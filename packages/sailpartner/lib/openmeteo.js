'use strict'

// Open-Meteo forecast (wind, gusts, rain, pressure, sun) and marine (waves) APIs.
// Free, no API key. Several locations are fetched in one request.

const FORECAST = 'https://api.open-meteo.com/v1/forecast'
const MARINE = 'https://marine-api.open-meteo.com/v1/marine'
const HOURLY = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'precipitation', 'precipitation_probability', 'pressure_msl']

function coords (points) {
  return {
    latitude: points.map(p => p.latitude.toFixed(4)).join(','),
    longitude: points.map(p => p.longitude.toFixed(4)).join(',')
  }
}

function forecastUrl (points, days = 3) {
  const c = coords(points)
  const q = new URLSearchParams({
    latitude: c.latitude,
    longitude: c.longitude,
    hourly: HOURLY.join(','),
    daily: 'sunrise,sunset',
    wind_speed_unit: 'kn',
    timezone: 'GMT',
    forecast_days: String(days)
  })
  return `${FORECAST}?${q}`
}

function marineUrl (points, days = 3) {
  const c = coords(points)
  const q = new URLSearchParams({ latitude: c.latitude, longitude: c.longitude, hourly: 'wave_height', timezone: 'GMT', forecast_days: String(days) })
  return `${MARINE}?${q}`
}

const iso = t => (t.length === 16 ? t + ':00Z' : t.endsWith('Z') ? t : t + 'Z')

// One location's response -> { hours: [{ time, windKn, windDir, gustKn, rainMm, rainProb, pressure }], sunrise[], sunset[] }
function parseForecast (r) {
  const h = r.hourly || {}
  const hours = (h.time || []).map((t, i) => ({
    time: new Date(iso(t)).toISOString(),
    windKn: h.wind_speed_10m ? h.wind_speed_10m[i] : null,
    windDir: h.wind_direction_10m ? h.wind_direction_10m[i] : null,
    gustKn: h.wind_gusts_10m ? h.wind_gusts_10m[i] : null,
    rainMm: h.precipitation ? h.precipitation[i] : null,
    rainProb: h.precipitation_probability ? h.precipitation_probability[i] : null,
    pressure: h.pressure_msl ? h.pressure_msl[i] : null,
    waveM: null
  }))
  const d = r.daily || {}
  return {
    latitude: r.latitude,
    longitude: r.longitude,
    hours,
    sunrise: (d.sunrise || []).map(t => new Date(iso(t)).toISOString()),
    sunset: (d.sunset || []).map(t => new Date(iso(t)).toISOString())
  }
}

function mergeWaves (fc, marine) {
  if (!marine || !marine.hourly) return fc
  const byTime = new Map()
  marine.hourly.time.forEach((t, i) => byTime.set(new Date(iso(t)).toISOString(), marine.hourly.wave_height[i]))
  for (const h of fc.hours) if (byTime.has(h.time)) h.waveM = byTime.get(h.time)
  return fc
}

// Fetch forecasts for several points. Returns one parsed forecast per point.
// Waves are optional: inland or on failure they stay null.
async function fetchForecasts (http, points, { days = 3 } = {}) {
  const fc = await http.fetchJson(forecastUrl(points, days))
  const list = (Array.isArray(fc) ? fc : [fc]).map(parseForecast)
  try {
    const m = await http.fetchJson(marineUrl(points, days))
    const ml = Array.isArray(m) ? m : [m]
    list.forEach((f, i) => mergeWaves(f, ml[i]))
  } catch (e) { /* waves optional */ }
  return list
}

// Value of a forecast at an exact time (nearest hour).
function at (forecast, time) {
  const t = new Date(time).getTime()
  let best = null
  for (const h of forecast.hours) {
    const d = Math.abs(Date.parse(h.time) - t)
    if (!best || d < best.d) best = { d, h }
  }
  return best && best.d <= 90 * 60e3 ? best.h : null
}

module.exports = { fetchForecasts, parseForecast, mergeWaves, forecastUrl, marineUrl, at }
