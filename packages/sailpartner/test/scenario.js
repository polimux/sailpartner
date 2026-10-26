'use strict'

// A synthetic but realistic day: Monday 26 Oct 2026 in Heiligenhafen (CET, UTC+1).
// SW 3–4 in the morning, a front around 14–15h local with W 5–6, gusts 7, rain 13–17h,
// pressure falling. Responses mimic the Open-Meteo JSON format.

const DAY0 = Date.UTC(2026, 9, 26, 0, 0) // 26 Oct 00:00Z
const fmtT = ms => new Date(ms).toISOString().slice(0, 16)

function local (hUtc) { return (hUtc + 1) % 24 }

function weatherAt (i) {
  // i = hours since 26 Oct 00:00Z
  const L = local(i % 24)
  const day = Math.floor(i / 24)
  if (day > 0) return { w: 12, d: 290, r: 0, p: 1013, wave: 0.6 }
  let w
  if (L <= 9) w = 12
  else if (L <= 15) w = 12 + (L - 9) * 1.5
  else if (L <= 18) w = 20
  else w = 16
  const d = L < 13 ? 225 : L === 13 ? 247 : 270
  const rain = { 13: 0.2, 14: 1.6, 15: 2.8, 16: 1.9, 17: 0.7 }[L] || 0
  const p = 1009 - Math.max(0, L - 9) * 0.5
  const wave = Math.min(1.2, 0.4 + Math.max(0, L - 9) * 0.12)
  return { w, d, r: rain, p, wave }
}

function forecastFor (lat, lon) {
  const time = []; const ws = []; const wd = []; const wg = []; const pr = []; const pp = []; const pm = []
  for (let i = 0; i < 72; i++) {
    const x = weatherAt(i)
    time.push(fmtT(DAY0 + i * 3600e3))
    ws.push(Math.round(x.w * 10) / 10)
    wd.push(x.d)
    wg.push(Math.round(x.w * 1.35 * 10) / 10)
    pr.push(x.r)
    pp.push(x.r > 0 ? 80 : 5)
    pm.push(x.p)
  }
  return {
    latitude: lat,
    longitude: lon,
    hourly_units: { wind_speed_10m: 'kn' },
    hourly: { time, wind_speed_10m: ws, wind_direction_10m: wd, wind_gusts_10m: wg, precipitation: pr, precipitation_probability: pp, pressure_msl: pm },
    daily: {
      time: ['2026-10-26', '2026-10-27', '2026-10-28'],
      sunrise: ['2026-10-26T06:02', '2026-10-27T06:04', '2026-10-28T06:06'],
      sunset: ['2026-10-26T15:41', '2026-10-27T15:39', '2026-10-28T15:37']
    }
  }
}

function marineFor (lat, lon) {
  const time = []; const wh = []
  for (let i = 0; i < 72; i++) { time.push(fmtT(DAY0 + i * 3600e3)); wh.push(weatherAt(i).wave) }
  return { latitude: lat, longitude: lon, hourly: { time, wave_height: wh } }
}

// Mock of lib/http with the Open-Meteo response conventions (object for one
// location, array for several).
const mockHttp = {
  calls: [],
  async fetchJson (url) {
    this.calls.push(url)
    const q = new URL(url).searchParams
    const lats = q.get('latitude').split(',').map(Number)
    const lons = q.get('longitude').split(',').map(Number)
    const make = url.includes('marine') ? marineFor : forecastFor
    const list = lats.map((la, i) => make(la, lons[i]))
    return list.length === 1 ? list[0] : list
  }
}

module.exports = { mockHttp, forecastFor, marineFor, DAY0 }
