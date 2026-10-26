'use strict'

// Weather along a planned trip: where the boat is each hour at the planned speed,
// and what wind, gusts, waves and rain it meets there.

const { timeline } = require('./route')
const { at } = require('./openmeteo')
const { norm180, compass8, compass16 } = require('./units')

// Defaults for a ~32 ft cruiser (Hanse 323): first reef around 18 kn mean or 24 kn gusts.
const DEFAULT_THRESHOLDS = { reefWindKn: 18, reefGustKn: 24, strongGustKn: 28, stayWindKn: 25, stayGustKn: 32 }

function pointOfSail (twaDeg) {
  if (typeof twaDeg !== 'number') return null
  const a = Math.abs(twaDeg)
  if (a < 45) return 'beat'
  if (a < 70) return 'close reach'
  if (a < 110) return 'beam reach'
  if (a < 150) return 'broad reach'
  return 'run'
}

function rainLevel (mm) {
  if (typeof mm !== 'number' || mm < 0.1) return 0
  if (mm < 1) return 1
  if (mm < 2.5) return 2
  return 3
}

function windLevel (windKn, gustKn, t = DEFAULT_THRESHOLDS) {
  if (typeof windKn !== 'number') return 'unknown'
  const g = typeof gustKn === 'number' ? gustKn : windKn
  if (g >= t.strongGustKn || windKn >= t.stayWindKn) return 'red'
  if (g >= t.reefGustKn || windKn >= t.reefWindKn) return 'amber'
  return 'green'
}

// One forecast hour enriched for a boat on `course`.
function sailingHour (f, course, t) {
  if (!f) return { windKn: null, gustKn: null, windDir: null, level: 'unknown', rainLevel: 0 }
  const twa = typeof f.windDir === 'number' && typeof course === 'number' ? Math.round(norm180(f.windDir - course)) : null
  return {
    windKn: f.windKn === null ? null : Math.round(f.windKn),
    gustKn: f.gustKn === null ? null : Math.round(f.gustKn),
    windDir: f.windDir,
    windFrom: compass16(f.windDir),
    twa,
    pointOfSail: pointOfSail(twa),
    waveM: typeof f.waveM === 'number' ? Math.round(f.waveM * 10) / 10 : null,
    rainMm: typeof f.rainMm === 'number' ? Math.round(f.rainMm * 10) / 10 : null,
    rainLevel: rainLevel(f.rainMm),
    level: windLevel(f.windKn, f.gustKn, t)
  }
}

// trip: { points, departure, speedKn }
// forecastFor(position) -> forecast object (nearest fetched point)
function routeWeather (trip, forecastFor, { thresholds = DEFAULT_THRESHOLDS, sunsetFor } = {}) {
  const tl = timeline(trip.points, trip.departure, trip.speedKn)
  const hours = tl.hours.map(h => ({
    time: h.time,
    distanceNm: h.distanceNm,
    position: h.position,
    course: h.course,
    arrival: h.arrival,
    ...sailingHour(at(forecastFor(h.position), h.time), h.course, thresholds)
  }))
  const eta = hours[hours.length - 1].time
  const durationH = (Date.parse(eta) - Date.parse(trip.departure)) / 3600e3
  let sunsetMarginMin = null
  if (sunsetFor) {
    const ss = sunsetFor(eta)
    if (ss) sunsetMarginMin = Math.round((Date.parse(ss) - Date.parse(eta)) / 60e3)
  }
  return {
    destination: trip.destination || null,
    via: trip.via || null,
    departure: new Date(trip.departure).toISOString(),
    speedKn: trip.speedKn,
    distanceNm: Math.round(tl.totalNm * 10) / 10,
    durationH: Math.round(durationH * 10) / 10,
    eta,
    sunsetMarginMin,
    hours
  }
}

// Short tactical advice for a trip.  fmt(iso) formats a local hour like "13h".
function tripAdvice (rw, fmt) {
  const out = []
  const sailing = rw.hours.filter(h => !h.arrival)
  const firstHard = sailing.find(h => h.level === 'amber' || h.level === 'red')
  if (firstHard) {
    const reefBy = new Date(Date.parse(firstHard.time) - 3600e3).toISOString()
    out.push({ type: 'reef', time: reefBy, text: `reef before ${fmt(reefBy)}` })
  }
  const rainy = sailing.filter(h => h.rainLevel >= 1)
  if (rainy.length) out.push({ type: 'rain', from: rainy[0].time, to: rainy[rainy.length - 1].time, text: 'oilskins on' })
  const runs = sailing.filter(h => h.pointOfSail === 'run' && (h.windKn || 0) >= 15)
  if (runs.length) out.push({ type: 'preventer', text: 'rig a preventer' })
  const beats = sailing.filter(h => h.pointOfSail === 'beat')
  if (sailing.length && beats.length / sailing.length >= 0.5) out.push({ type: 'beat', text: 'upwind most of the way, allow extra time' })
  const waves = Math.max(...sailing.map(h => h.waveM || 0))
  if (waves >= 1) {
    const dir = sailing.find(h => h.waveM === waves)
    const pos = dir && dir.pointOfSail
    const kind = pos === 'run' || pos === 'broad reach' ? 'following' : pos === 'beat' || pos === 'close reach' ? 'head' : ''
    out.push({ type: 'sea', text: `${kind ? kind + ' ' : ''}sea ${waves} m`.trim() })
  }
  if (rw.sunsetMarginMin !== null && rw.sunsetMarginMin < 30) {
    out.push({ type: 'darkness', text: rw.sunsetMarginMin < 0 ? `arrival ${-rw.sunsetMarginMin} min after sunset` : 'tight before sunset' })
  }
  return out
}

function summarizeWind (hours) {
  const dirs = hours.filter(h => typeof h.windDir === 'number').map(h => h.windDir)
  return dirs.length ? compass8(dirs[dirs.length - 1]) : ''
}

module.exports = { routeWeather, tripAdvice, pointOfSail, rainLevel, windLevel, sailingHour, summarizeWind, DEFAULT_THRESHOLDS }
