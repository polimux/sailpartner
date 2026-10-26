'use strict'

const fs = require('fs')
const path = require('path')
const http = require('./lib/http')
const { fetchForecasts, at } = require('./lib/openmeteo')
const { routeWeather, tripAdvice, sailingHour, DEFAULT_THRESHOLDS } = require('./lib/routeweather')
const { verdict, summary } = require('./lib/brief')
const { History } = require('./lib/history')
const live = require('./lib/live')
const { distanceNm } = require('./lib/route')
const T = require('./lib/time')
const DEST = require('./lib/destinations')

const PLUGIN_ID = 'sailpartner'

module.exports = function (app, deps = {}) {
  const httpClient = deps.http || http
  const clock = deps.now || (() => Date.now())
  const plugin = {
    id: PLUGIN_ID,
    name: 'Sailpartner',
    description: 'Morning brief and logbook screen: verdict, written weather summary, route weather, live wind, rain, battery and barometer'
  }

  let options = null
  let history = null
  let state = { trip: null }
  let timers = []
  let forecast = { at: 0, key: null, points: [], list: [], error: null }
  let forecastPromise = null

  const pointSchema = {
    type: 'object',
    properties: { latitude: { type: 'number', title: 'Latitude' }, longitude: { type: 'number', title: 'Longitude' } }
  }

  plugin.schema = () => ({
    type: 'object',
    properties: {
      timezone: { type: 'string', title: 'Time zone of the boat', default: 'Europe/Berlin' },
      speedKn: { type: 'number', title: 'Planning speed (kn)', default: 5 },
      reefWindKn: { type: 'number', title: 'Reef from mean wind (kn)', default: DEFAULT_THRESHOLDS.reefWindKn },
      reefGustKn: { type: 'number', title: 'Reef from gusts (kn)', default: DEFAULT_THRESHOLDS.reefGustKn },
      strongGustKn: { type: 'number', title: 'Gusts shown red from (kn)', default: DEFAULT_THRESHOLDS.strongGustKn },
      stayWindKn: { type: 'number', title: '"Stay in" from mean wind (kn)', default: DEFAULT_THRESHOLDS.stayWindKn },
      stayGustKn: { type: 'number', title: '"Stay in" from gusts (kn)', default: DEFAULT_THRESHOLDS.stayGustKn },
      batteryId: { type: 'string', title: 'Battery id under electrical.batteries (empty: first found)', default: '' },
      pressurePath: { type: 'string', title: 'Barometer path (Pa)', default: 'environment.outside.pressure' },
      cabinTemperaturePath: { type: 'string', title: 'Cabin temperature path (K)', default: 'environment.inside.temperature' },
      cabinHumidityPath: { type: 'string', title: 'Cabin humidity path (ratio)', default: 'environment.inside.relativeHumidity' },
      forecastIntervalMin: { type: 'number', title: 'Forecast refresh (minutes)', default: 30 },
      home: { ...pointSchema, title: 'Home port', properties: { name: { type: 'string', title: 'Name', default: DEST.home.name }, ...pointSchema.properties } },
      destinations: {
        type: 'array',
        title: 'Saved destinations (approximate positions, for weather sampling only)',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Name' },
            latitude: { type: 'number', title: 'Latitude' },
            longitude: { type: 'number', title: 'Longitude' },
            via: { type: 'array', title: 'Via points from home', items: pointSchema }
          }
        }
      }
    }
  })

  function withDefaults (o = {}) {
    return {
      timezone: 'Europe/Berlin',
      speedKn: 5,
      ...DEFAULT_THRESHOLDS,
      batteryId: '',
      pressurePath: 'environment.outside.pressure',
      cabinTemperaturePath: 'environment.inside.temperature',
      cabinHumidityPath: 'environment.inside.relativeHumidity',
      forecastIntervalMin: 30,
      ...o,
      home: o.home && typeof o.home.latitude === 'number' ? o.home : DEST.home,
      destinations: o.destinations && o.destinations.length ? o.destinations : DEST.list
    }
  }

  const thresholds = () => ({ reefWindKn: options.reefWindKn, reefGustKn: options.reefGustKn, strongGustKn: options.strongGustKn, stayWindKn: options.stayWindKn, stayGustKn: options.stayGustKn })
  const tz = () => options.timezone
  const fmt = (iso, bare) => T.hourLabel(iso, tz(), bare)
  const dataFile = name => path.join(app.getDataDirPath(), name)

  function loadJson (name, fallback) {
    try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')) } catch (e) { return fallback }
  }
  function saveJson (name, obj) {
    try {
      fs.mkdirSync(app.getDataDirPath(), { recursive: true })
      fs.writeFileSync(dataFile(name) + '.tmp', JSON.stringify(obj))
      fs.renameSync(dataFile(name) + '.tmp', dataFile(name))
    } catch (e) { app.debug(`save ${name} failed: ${e.message}`) }
  }

  function snapshot () {
    return live.snapshot(app, { pressurePath: options.pressurePath, cabinTemperaturePath: options.cabinTemperaturePath, cabinHumidityPath: options.cabinHumidityPath, batteryId: options.batteryId || undefined })
  }

  function boatPosition (s) {
    return (s && s.position) || { latitude: options.home.latitude, longitude: options.home.longitude }
  }

  // ----- trip -------------------------------------------------------------
  function activeTrip (now = clock()) {
    const t = state.trip
    if (!t) return null
    // a trip is shown until 2 h after its planned arrival, at most 24 h
    if (now - Date.parse(t.departure) > 24 * 3600e3) return null
    return t
  }

  function tripPoints (dest, from) {
    const via = (dest.via || []).filter(p => typeof p.latitude === 'number')
    // via points are defined from home; skip them when already past them
    return [from, ...via, { latitude: dest.latitude, longitude: dest.longitude }]
  }

  // ----- forecast ---------------------------------------------------------
  function samplePoints (s, trip) {
    const pts = [boatPosition(s)]
    if (trip) {
      const rw = routeWeather(trip, () => ({ hours: [] }), { thresholds: thresholds() })
      for (const h of rw.hours) {
        if (pts.every(p => distanceNm(p, h.position) > 3)) pts.push(h.position)
      }
    }
    return pts.slice(0, 20)
  }

  async function refreshForecast (force = false) {
    const s = snapshot()
    const trip = activeTrip()
    const pts = samplePoints(s, trip)
    const key = JSON.stringify(pts.map(p => [p.latitude.toFixed(2), p.longitude.toFixed(2)]))
    const fresh = clock() - forecast.at < options.forecastIntervalMin * 60e3
    if (!force && fresh && key === forecast.key) return forecast
    if (forecastPromise) return forecastPromise
    forecastPromise = (async () => {
      try {
        const list = await fetchForecasts(httpClient, pts)
        forecast = { at: clock(), key, points: pts, list, error: null }
      } catch (e) {
        forecast = { ...forecast, error: e.message }
        app.debug(`forecast failed: ${e.message}`)
      } finally {
        forecastPromise = null
      }
      return forecast
    })()
    return forecastPromise
  }

  function forecastFor (pos) {
    let best = null
    forecast.points.forEach((p, i) => {
      const d = distanceNm(p, pos)
      if (!best || d < best.d) best = { d, f: forecast.list[i] }
    })
    return best ? best.f : { hours: [] }
  }

  function sunFor (iso) {
    const f = forecast.list[0]
    if (!f) return null
    const key = T.dayKey(iso, tz())
    const i = f.sunset.findIndex(s => T.dayKey(s, tz()) === key)
    return i >= 0 ? { sunrise: f.sunrise[i], sunset: f.sunset[i] } : null
  }

  // ----- brief ------------------------------------------------------------
  function placeName (pos, state) {
    if (!pos) return options.home.name
    let best = null
    for (const d of options.destinations) {
      const dd = distanceNm(pos, d)
      if (!best || dd < best.d) best = { d: dd, name: d.name }
    }
    if (best && best.d <= 1.5) return best.name
    return state === 'underway' ? 'At sea' : 'At anchor'
  }

  function localHours (from, count) {
    const f = forecast.list[0]
    if (!f) return []
    const start = Math.floor(from / 3600e3) * 3600e3
    return f.hours.filter(h => Date.parse(h.time) >= start).slice(0, count)
  }

  function buildBrief () {
    const now = clock()
    const nowIso = new Date(now).toISOString()
    const s = snapshot()
    const boatState = live.boatState(s)
    const sun = sunFor(nowIso)
    const warnings = live.warnings(app)
    const baro = history.barometer(now)

    // trip / route weather
    const trip = activeTrip(now)
    let tripOut = null
    if (trip && forecast.list.length) {
      const rw = routeWeather(trip, forecastFor, { thresholds: thresholds(), sunsetFor: iso => (sunFor(iso) || {}).sunset })
      tripOut = { ...rw, route: trip.points, advice: tripAdvice(rw, fmt) }
    }

    // period that drives verdict and text: the trip, or the rest of the daylight here
    let period
    if (tripOut) period = tripOut.hours.filter(h => !h.arrival)
    else {
      const until = sun && Date.parse(sun.sunset) > now ? Date.parse(sun.sunset) : now + 8 * 3600e3
      const n = Math.max(6, Math.ceil((until - now) / 3600e3))
      period = localHours(now, n).map(h => ({ ...h, ...sailingHour(h, null, thresholds()) }))
    }
    const v = period.length ? verdict({ hours: period, warnings, barometer: baro, thresholds: thresholds(), fmt, now }) : null
    const lines = period.length ? summary({ hours: period, barometer: baro, verdict: v, fmt }) : []

    const rainHours = localHours(now, 12).map(h => ({ time: h.time, mm: h.rainMm }))
    const rainNow = rainHours.length && (rainHours[0].mm || 0) >= 0.1
    const nextRain = rainHours.find(h => (h.mm || 0) >= 0.2)
    const windToday = localHours(now, 16).map(h => ({ time: h.time, ...sailingHour(h, null, thresholds()) }))

    const today = T.dayKey(now, tz())
    const yesterday = T.addDays(today, -1)

    return {
      now: nowIso,
      timezone: tz(),
      place: { name: placeName(s.position, boatState), state: boatState, position: s.position },
      sun,
      verdict: v,
      summary: lines,
      rain: {
        hours: rainHours,
        status: rainNow ? 'rain now' : nextRain ? `rain from ${fmt(nextRain.time)}` : 'dry next 12 h'
      },
      trip: tripOut,
      windToday,
      wind: {
        aws: s.aws,
        awa: s.awa,
        tws: s.tws,
        twa: s.twa,
        twd: s.twd,
        sog: s.sog,
        gust10: history.gust(10, now),
        ...history.windHistory(now)
      },
      battery: s.battery,
      barometer: { ...(baro || {}), current: baro ? baro.current : s.pressureHPa, series: history.pressureSeries(24, now) },
      boat: {
        cabinTemp: s.cabinTemp,
        cabinHumidity: s.cabinHumidity,
        overnightMax: history.maxWind(12, now),
        anchor: s.anchor
      },
      log: { today: history.day(today), yesterday: history.day(yesterday) },
      warnings,
      forecast: { updated: forecast.at ? new Date(forecast.at).toISOString() : null, error: forecast.error, source: 'Open-Meteo' },
      thresholds: thresholds()
    }
  }

  // ----- lifecycle --------------------------------------------------------
  function tick () {
    const s = snapshot()
    history.sample(s, clock(), T.dayKey(clock(), tz()))
  }

  plugin.start = function (opts) {
    options = withDefaults(opts)
    history = new History(loadJson('history.json', {}))
    state = loadJson('state.json', { trip: null })
    timers.push(setInterval(tick, 2000))
    timers.push(setInterval(() => saveJson('history.json', history.toJSON()), 5 * 60e3))
    timers.push(setInterval(() => refreshForecast(), 5 * 60e3))
    refreshForecast()
    if (app.setPluginStatus) app.setPluginStatus('Started')
  }

  plugin.stop = function () {
    timers.forEach(t => clearInterval(t))
    timers = []
    if (history) { history.flush(); saveJson('history.json', history.toJSON()) }
  }

  function readBody (req) {
    if (req.body && typeof req.body === 'object') return Promise.resolve(req.body)
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', c => { data += c })
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
      req.on('error', reject)
    })
  }

  plugin.registerWithRouter = function (router) {
    router.get('/brief', async (req, res) => {
      if (!options) return res.status(503).json({ error: 'not started' })
      if (!forecast.list.length || req.query.refresh) await refreshForecast(!!req.query.refresh)
      res.json(buildBrief())
    })

    router.get('/destinations', (req, res) => {
      if (!options) return res.status(503).json({ error: 'not started' })
      res.json({ home: options.home, destinations: options.destinations.map(d => ({ name: d.name, latitude: d.latitude, longitude: d.longitude })), speedKn: options.speedKn })
    })

    // PUT /trip { destination: "Kühlungsborn", departure: "09:00" | ISO, speedKn: 5 }
    //       or { name, points: [{latitude, longitude}, ...], departure, speedKn }
    router.put('/trip', async (req, res) => {
      try {
        const b = await readBody(req)
        const s = snapshot()
        let points; let name
        if (Array.isArray(b.points) && b.points.length >= 2) {
          points = b.points.filter(p => typeof p.latitude === 'number' && typeof p.longitude === 'number')
          name = b.name || 'Route'
        } else {
          const dest = options.destinations.find(d => d.name === b.destination)
          if (!dest) return res.status(400).json({ error: `unknown destination "${b.destination}"` })
          points = tripPoints(dest, boatPosition(s))
          name = dest.name
        }
        if (points.length < 2) return res.status(400).json({ error: 'route needs at least 2 points' })
        let departure
        if (typeof b.departure === 'string' && /^\d{1,2}:\d{2}$/.test(b.departure)) {
          const [hh, mm] = b.departure.split(':').map(Number)
          departure = T.localToDate(T.dayKey(clock(), tz()), hh, mm, tz()).toISOString()
        } else if (b.departure && !isNaN(Date.parse(b.departure))) {
          departure = new Date(b.departure).toISOString()
        } else {
          departure = new Date(Math.ceil(clock() / 1800e3) * 1800e3).toISOString()
        }
        const speedKn = typeof b.speedKn === 'number' && b.speedKn > 0.5 ? b.speedKn : options.speedKn
        state.trip = { destination: name, departure, speedKn, points }
        saveJson('state.json', state)
        await refreshForecast(true)
        res.json(buildBrief())
      } catch (e) {
        res.status(400).json({ error: e.message })
      }
    })

    router.delete('/trip', (req, res) => {
      if (!options) return res.status(503).json({ error: 'not started' })
      state.trip = null
      saveJson('state.json', state)
      res.json({ ok: true })
    })
  }

  plugin._internals = { buildBrief, refreshForecast, tick, get history () { return history }, get state () { return state } }
  return plugin
}
