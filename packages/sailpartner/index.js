'use strict'

const fs = require('fs')
const path = require('path')
const http = require('./lib/http')
const { fetchForecasts } = require('./lib/openmeteo')
const { routeWeather, sailingHour, DEFAULT_THRESHOLDS } = require('./lib/routeweather')
const L = require('./lib/local')
const P = require('./lib/passage')
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
    description: 'Morning brief for here, passage weather along a planned route, live wind, battery and barometer'
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

  function forecastKey (pts) {
    return JSON.stringify(pts.map(p => [p.latitude.toFixed(2), p.longitude.toFixed(2)]))
  }

  async function refreshForecast (force = false) {
    const s = snapshot()
    const trip = activeTrip()
    const pts = samplePoints(s, trip)
    const key = forecastKey(pts)
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

  // ----- brief: here -------------------------------------------------------
  function placeName (pos, boatState) {
    if (!pos) return options.home.name
    let best = null
    for (const d of options.destinations) {
      const dd = distanceNm(pos, d)
      if (!best || dd < best.d) best = { d: dd, name: d.name }
    }
    if (best && best.d <= 1.5) return best.name
    return boatState === 'underway' ? 'At sea' : 'At anchor'
  }

  function localForecast () {
    return forecast.list[0] || null
  }

  function buildBrief () {
    const now = clock()
    const nowIso = new Date(now).toISOString()
    const s = snapshot()
    const boatState = live.boatState(s)
    const warnings = live.warnings(app)
    const baro = history.barometer(now)
    const day = L.briefDay(now, tz(), sunFor)
    const fc = localForecast()
    const hours = L.periodHours(fc, now, day, tz()).map(h => ({ ...h, ...sailingHour(h, null, thresholds()) }))
    const hereWarnings = warnings.filter(w => w.relevance !== 'route' && w.relevance !== 'far')
    const v = L.localVerdict({ hours, warnings: hereWarnings, barometer: baro, thresholds: thresholds(), fmt, now, day, tz: tz() })
    const front = L.detectFront(hours)
    const wind = {
      aws: s.aws,
      awa: s.awa,
      tws: s.tws,
      twa: s.twa,
      twd: s.twd,
      sog: s.sog,
      gust10: history.gust(10, now),
      ...history.windHistory(now)
    }
    const pressure24 = history.pressureSeries(24, now)
    const pressure3h = pressure24.filter(p => Date.parse(p.t) >= now - 3 * 3600e3)

    return {
      now: nowIso,
      timezone: tz(),
      place: { name: placeName(s.position, boatState), state: boatState, position: s.position, heading: s.heading },
      sun: sunFor(nowIso),
      day: { key: day.key, isToday: day.isToday },
      verdict: v,
      headline: L.headline({ hours, verdict: v, front, fmt, day, now }),
      ribbon: L.ribbon({ forecast: fc, now, day, tz: tz(), thresholds: thresholds() }),
      attention: L.attention({ barometer: baro, pressure3h, warnings, battery: s.battery, anchor: boatState === 'anchored' ? s.anchor : null }),
      status: L.status({ battery: s.battery, wind, cabin: { temp: s.cabinTemp, humidity: s.cabinHumidity } }),
      wind,
      battery: s.battery,
      barometer: { ...(baro || {}), current: baro ? baro.current : s.pressureHPa, series: pressure24 },
      boat: {
        cabinTemp: s.cabinTemp,
        cabinHumidity: s.cabinHumidity,
        overnightMax: history.maxWind(12, now),
        anchor: s.anchor
      },
      log: { today: history.day(T.dayKey(now, tz())), yesterday: history.day(T.addDays(T.dayKey(now, tz()), -1)) },
      warnings,
      forecast: { updated: forecast.at ? new Date(forecast.at).toISOString() : null, error: forecast.error, source: 'Open-Meteo' },
      thresholds: thresholds()
    }
  }

  // ----- passage ------------------------------------------------------------
  function buildPassage () {
    const now = clock()
    const s = snapshot()
    const trip = activeTrip(now)
    let out = null
    if (trip && forecast.list.length) {
      out = P.passage({ trip, forecastFor, sunFor, thresholds: thresholds(), fmt, now, tz: tz(), warnings: live.warnings(app) })
    }
    return {
      now: new Date(now).toISOString(),
      timezone: tz(),
      boat: { position: boatPosition(s), heading: s.heading, state: live.boatState(s) },
      home: options.home,
      destinations: options.destinations.map(d => ({ name: d.name, latitude: d.latitude, longitude: d.longitude })),
      speedKn: options.speedKn,
      trip: out,
      waypoints: trip ? trip.waypoints || trip.points.slice(1) : [],
      forecast: { updated: forecast.at ? new Date(forecast.at).toISOString() : null, error: forecast.error },
      thresholds: thresholds()
    }
  }

  function nameFor (point) {
    for (const d of options.destinations) if (distanceNm(point, d) <= 1.5) return d.name
    const f = (v, pos, neg) => `${Math.floor(Math.abs(v))}°${String(Math.round((Math.abs(v) % 1) * 60)).padStart(2, '0')}′${v >= 0 ? pos : neg}`
    return `${f(point.latitude, 'N', 'S')} ${f(point.longitude, 'E', 'W')}`
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

    router.get('/passage', async (req, res) => {
      if (!options) return res.status(503).json({ error: 'not started' })
      if (activeTrip() && (!forecast.list.length || forecast.key !== forecastKey(samplePoints(snapshot(), activeTrip())))) await refreshForecast()
      res.json(buildPassage())
    })

    // PUT /trip — one of:
    //   { destination: "Kühlungsborn" }               saved harbour, with its via points
    //   { waypoints: [{latitude, longitude}, ...] }   tapped on the chart, from the boat
    //   { points: [...], name }                       a full route, e.g. from Freeboard-SK
    // plus optional departure ("09:00" local or ISO) and speedKn.
    router.put('/trip', async (req, res) => {
      try {
        const b = await readBody(req)
        const s = snapshot()
        const prev = activeTrip()
        const valid = arr => (arr || []).filter(p => p && typeof p.latitude === 'number' && typeof p.longitude === 'number')
        let points; let name; let waypoints
        if (b.destination) {
          const dest = options.destinations.find(d => d.name === b.destination)
          if (!dest) return res.status(400).json({ error: `unknown destination "${b.destination}"` })
          points = tripPoints(dest, boatPosition(s))
          waypoints = points.slice(1)
          name = dest.name
        } else if (Array.isArray(b.waypoints)) {
          waypoints = valid(b.waypoints)
          if (!waypoints.length) return res.status(400).json({ error: 'waypoints need latitude and longitude' })
          points = [boatPosition(s), ...waypoints]
          name = nameFor(waypoints[waypoints.length - 1])
        } else if (Array.isArray(b.points)) {
          points = valid(b.points)
          waypoints = points.slice(1)
          name = b.name || nameFor(points[points.length - 1])
        } else if (prev) {
          points = prev.points; waypoints = prev.waypoints || prev.points.slice(1); name = prev.destination
        } else {
          return res.status(400).json({ error: 'give a destination, waypoints or points' })
        }
        if (points.length < 2) return res.status(400).json({ error: 'route needs at least 2 points' })
        let departure
        if (typeof b.departure === 'string' && /^\d{1,2}:\d{2}$/.test(b.departure)) {
          const [hh, mm] = b.departure.split(':').map(Number)
          departure = T.localToDate(T.dayKey(clock(), tz()), hh, mm, tz()).toISOString()
        } else if (b.departure && !isNaN(Date.parse(b.departure))) {
          departure = new Date(b.departure).toISOString()
        } else if (prev && Date.parse(prev.departure) >= clock() - 3600e3) {
          departure = prev.departure
        } else {
          departure = new Date(Math.ceil(clock() / 1800e3) * 1800e3).toISOString()
        }
        let speedKn = typeof b.speedKn === 'number' && b.speedKn > 0.5 ? b.speedKn : (prev ? prev.speedKn : options.speedKn)
        speedKn = Math.min(12, Math.max(1, speedKn))
        state.trip = { destination: name, departure, speedKn, points, waypoints }
        saveJson('state.json', state)
        await refreshForecast()
        res.json(buildPassage())
      } catch (e) {
        res.status(400).json({ error: e.message })
      }
    })

    router.delete('/trip', (req, res) => {
      if (!options) return res.status(503).json({ error: 'not started' })
      state.trip = null
      saveJson('state.json', state)
      res.json(buildPassage())
    })
  }

  plugin._internals = { buildBrief, buildPassage, refreshForecast, tick, get history () { return history }, get state () { return state } }
  return plugin
}
