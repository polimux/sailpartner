'use strict'

// The Weather page: 48 hours at the boat's position, the next days in short,
// and the pressure measured on board joined to the forecast pressure.

const { beaufort, compass8, meanDirection } = require('./units')
const { windLevel, rainLevel } = require('./routeweather')
const T = require('./time')

const LEVEL_RANK = { green: 0, amber: 1, red: 2, unknown: -1 }

function weatherPage ({ forecast, now, tz, thresholds, measured = [] }) {
  if (!forecast) return { hours: [], days: [], pressure: { measured, forecast: [] } }
  const start = Math.floor(now / 3600e3) * 3600e3
  const hours = forecast.hours
    .filter(h => Date.parse(h.time) >= start)
    .slice(0, 48)
    .map(h => ({
      time: h.time,
      hour: T.parts(h.time, tz).h,
      windKn: typeof h.windKn === 'number' ? Math.round(h.windKn) : null,
      gustKn: typeof h.gustKn === 'number' ? Math.round(h.gustKn) : null,
      windDir: h.windDir,
      rainMm: h.rainMm,
      rainProb: h.rainProb,
      rainLevel: rainLevel(h.rainMm),
      waveM: typeof h.waveM === 'number' ? Math.round(h.waveM * 10) / 10 : null,
      pressure: h.pressure,
      level: windLevel(h.windKn, h.gustKn, thresholds)
    }))

  // day summaries over daylight (sunrise..sunset) for today and the next two days
  const today = T.dayKey(now, tz)
  const days = []
  for (let i = 0; i < 3; i++) {
    const key = T.addDays(today, i)
    const si = forecast.sunset.findIndex(s => T.dayKey(s, tz) === key)
    const sunrise = si >= 0 ? forecast.sunrise[si] : T.localToDate(key, 7, 0, tz).toISOString()
    const sunset = si >= 0 ? forecast.sunset[si] : T.localToDate(key, 18, 0, tz).toISOString()
    const from = Math.max(Date.parse(sunrise), i === 0 ? start : 0)
    const day = forecast.hours.filter(h => T.dayKey(h.time, tz) === key)
    const light = day.filter(h => Date.parse(h.time) >= from - 3600e3 && Date.parse(h.time) <= Date.parse(sunset))
    const use = (light.length ? light : day).filter(h => typeof h.windKn === 'number')
    if (!use.length) continue
    const winds = use.map(h => h.windKn)
    const lv = use.map(h => windLevel(h.windKn, h.gustKn, thresholds)).reduce((a, l) => (LEVEL_RANK[l] > LEVEL_RANK[a] ? l : a), 'green')
    const rain = day.reduce((a, h) => a + (h.rainMm || 0), 0)
    const waves = use.map(h => h.waveM).filter(v => typeof v === 'number')
    const dir = meanDirection(use.map(h => h.windDir).filter(d => typeof d === 'number'))
    days.push({
      key,
      label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' }).format(new Date(key + 'T12:00:00Z')),
      sunrise,
      sunset,
      windDir: dir === null ? null : Math.round(dir),
      windFrom: compass8(dir),
      bft: { min: beaufort(Math.min(...winds)), max: beaufort(Math.max(...winds)) },
      windKn: { min: Math.round(Math.min(...winds)), max: Math.round(Math.max(...winds)) },
      gustMaxKn: Math.round(Math.max(...use.map(h => h.gustKn || h.windKn))),
      rainMm: Math.round(rain * 10) / 10,
      rainHours: day.filter(h => (h.rainMm || 0) >= 0.2).length,
      waveMaxM: waves.length ? Math.round(Math.max(...waves) * 10) / 10 : null,
      level: lv
    })
  }

  const fp = forecast.hours
    .filter(h => typeof h.pressure === 'number' && Date.parse(h.time) >= start - 3600e3 && Date.parse(h.time) <= start + 48 * 3600e3)
    .map(h => ({ t: h.time, hPa: Math.round(h.pressure * 10) / 10 }))
  let low = null; let high = null
  for (const p of fp) {
    if (Date.parse(p.t) < now) continue
    if (!low || p.hPa < low.hPa) low = p
    if (!high || p.hPa > high.hPa) high = p
  }
  return { hours, days, pressure: { measured, forecast: fp, low, high } }
}

module.exports = { weatherPage }
