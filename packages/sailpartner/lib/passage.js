'use strict'

// The Passage tab: weather along a planned route, a verdict for the trip and a
// search for a better departure time today or tomorrow.

const { routeWeather, tripAdvice } = require('./routeweather')
const { verdict } = require('./brief')
const { detectFront } = require('./local')
const T = require('./time')

const STEP_MS = 30 * 60e3

// Lower is better. null when the forecast does not cover the whole trip.
function scoreTrip (rw, sunrise) {
  const sailing = rw.hours.filter(h => !h.arrival)
  if (!sailing.length || sailing.some(h => typeof h.windKn !== 'number')) return null
  let s = 0
  let strong = 0; let rainy = 0; let maxGust = 0
  for (const h of sailing) {
    if (h.level === 'red') { s += 3; strong++ } else if (h.level === 'amber') { s += 1; strong++ }
    if (h.rainLevel) { s += 0.5 * h.rainLevel; rainy++ }
    maxGust = Math.max(maxGust, h.gustKn || 0)
  }
  if (rw.sunsetMarginMin !== null && rw.sunsetMarginMin < 0) s += 4 + (-rw.sunsetMarginMin) / 30
  if (sunrise && Date.parse(rw.departure) < Date.parse(sunrise)) s += 0.5 // leaving in the dark
  return { score: Math.round(s * 10) / 10, strongHours: strong, rainyHours: rainy, maxGust }
}

function describeBetter (best, chosen) {
  const parts = []
  if (best.stats.strongHours < chosen.stats.strongHours) parts.push(best.stats.strongHours === 0 ? 'no reefing weather' : `${chosen.stats.strongHours - best.stats.strongHours} h less strong wind`)
  if (best.stats.rainyHours < chosen.stats.rainyHours) parts.push(best.stats.rainyHours === 0 ? 'dry' : 'less rain')
  if (chosen.rw.sunsetMarginMin !== null && chosen.rw.sunsetMarginMin < 0 && best.rw.sunsetMarginMin >= 0) parts.push('arrive in daylight')
  if (parts.length < 2) parts.push(`gusts max ${best.stats.maxGust} kn`)
  return parts.join(', ')
}

// Try departures every 30 minutes today and tomorrow (daylight only).
function bestDeparture ({ trip, forecastFor, sunFor, thresholds, now, tz }) {
  const evaluate = dep => {
    const t = { ...trip, departure: new Date(dep).toISOString() }
    const rw = routeWeather(t, forecastFor, { thresholds, sunsetFor: iso => (sunFor(iso) || {}).sunset })
    const sun = sunFor(t.departure)
    const stats = scoreTrip(rw, sun && sun.sunrise)
    return stats ? { dep, rw, stats } : null
  }
  const chosen = evaluate(Date.parse(trip.departure))
  if (!chosen) return { better: null, chosen: null }

  const minutesOfDay = ms => { const p = T.parts(ms, tz); return p.h * 60 + p.min }
  const closeness = dep => Math.abs(minutesOfDay(dep) - minutesOfDay(chosen.dep)) + (T.dayKey(dep, tz) === T.dayKey(chosen.dep, tz) ? 0 : 1)
  const today = T.dayKey(now, tz)
  const durationMs = chosen.rw.durationH * 3600e3
  let best = null
  for (const key of [today, T.addDays(today, 1)]) {
    const sun = sunFor(T.localToDate(key, 12, 0, tz).toISOString())
    if (!sun) continue
    const first = Math.ceil((Date.parse(sun.sunrise) - 3600e3) / STEP_MS) * STEP_MS
    const last = Date.parse(sun.sunset) + 3600e3 - durationMs
    for (let dep = Math.max(first, Math.ceil(now / STEP_MS) * STEP_MS); dep <= last; dep += STEP_MS) {
      const c = evaluate(dep)
      if (!c) continue
      // prefer the lower score; on a tie the time of day closest to the one chosen
      if (!best || c.stats.score < best.stats.score - 0.01 ||
        (Math.abs(c.stats.score - best.stats.score) <= 0.01 && closeness(dep) < closeness(best.dep))) best = c
    }
  }
  if (!best || best.stats.score >= chosen.stats.score - 1 || best.dep === chosen.dep) {
    return { better: null, chosen: chosen.stats }
  }
  const sameDay = T.dayKey(best.dep, tz) === T.dayKey(chosen.dep, tz)
  return {
    better: {
      departure: new Date(best.dep).toISOString(),
      eta: best.rw.eta,
      day: T.dayKey(best.dep, tz) === today ? 'today' : 'tomorrow',
      sameDay,
      reason: describeBetter(best, chosen),
      stats: best.stats
    },
    chosen: chosen.stats
  }
}

// Everything the Passage page shows for one trip.
function passage ({ trip, forecastFor, sunFor, thresholds, fmt, now, tz, warnings = [] }) {
  const rw = routeWeather(trip, forecastFor, { thresholds, sunsetFor: iso => (sunFor(iso) || {}).sunset })
  const sailing = rw.hours.filter(h => !h.arrival)
  const routeWarnings = warnings.filter(w => w.relevance === 'route' || w.relevance === 'here')
  const v = verdict({ hours: sailing, warnings: routeWarnings, thresholds, fmt, now })
  const front = detectFront(sailing)
  let frontText = null
  if (front) {
    const h = sailing.find(x => x.time === front.time)
    frontText = `front at ${fmt(front.time)}${h ? `, ${Math.round(h.distanceNm)} nm out` : ''}`
  }
  return {
    ...rw,
    name: trip.destination,
    route: trip.points,
    advice: tripAdvice(rw, fmt),
    verdict: v,
    front: front ? { time: front.time, text: frontText } : null,
    departureAdvice: bestDeparture({ trip, forecastFor, sunFor, thresholds, now, tz })
  }
}

module.exports = { passage, bestDeparture, scoreTrip }
