'use strict'

// Verdict ("Good sailing" / "Reef before 13h" / "Stay in") and the written summary.

const { beaufort, compass8 } = require('./units')
const { windLevel, DEFAULT_THRESHOLDS } = require('./routeweather')

function bftRange (kns) {
  const b = kns.filter(k => typeof k === 'number').map(beaufort)
  if (!b.length) return ''
  const lo = Math.min(...b); const hi = Math.max(...b)
  return lo === hi ? `${lo}` : `${lo}–${hi}`
}

// hours: [{ time, windKn, gustKn, windDir, rainMm }] for the period that matters
// (the trip, or the rest of the daylight at the berth)
function verdict ({ hours, warnings = [], barometer = null, thresholds = DEFAULT_THRESHOLDS, fmt, now = Date.now() }) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds }
  const reasons = []
  const valid = hours.filter(h => typeof h.windKn === 'number')
  const maxWind = Math.max(0, ...valid.map(h => h.windKn))
  const maxGust = Math.max(0, ...valid.map(h => h.gustKn || h.windKn))
  const alarms = warnings.filter(w => w.state === 'alarm' || w.state === 'emergency')

  if (maxGust >= t.stayGustKn || maxWind >= t.stayWindKn) reasons.push(`gusts up to ${Math.round(maxGust)} kn`)
  if (alarms.length) reasons.push(alarms[0].message)
  if (barometer && barometer.severity === 'alarm') reasons.push(`pressure ${barometer.label}`)
  if (reasons.length) return { level: 'stay', text: 'Stay in', reasons }

  const first = valid.find(h => windLevel(h.windKn, h.gustKn, t) !== 'green')
  if (first) {
    const reefBy = new Date(Date.parse(first.time) - 3600e3).toISOString()
    const text = Date.parse(reefBy) <= now ? 'Reef now' : `Reef before ${fmt(reefBy)}`
    return { level: 'caution', text, reefBy, firstBad: first.time, reasons: [`${Math.round(first.windKn)} kn, gusts ${Math.round(first.gustKn || first.windKn)} from ${fmt(first.time)}`] }
  }
  if (barometer && barometer.severity === 'warn') {
    return { level: 'caution', text: 'Watch the barometer', reasons: [`pressure ${barometer.label}`] }
  }
  if (warnings.some(w => w.state === 'warn')) {
    return { level: 'caution', text: 'Check warnings', reasons: [warnings.find(w => w.state === 'warn').message] }
  }
  if (maxWind < 4) return { level: 'go', text: 'Light winds', reasons: [] }
  return { level: 'go', text: 'Good sailing', reasons: [] }
}

// Three or four plain sentences for the "Today in brief" card.
function summary ({ hours, barometer, verdict: v, fmt }) {
  const lines = []
  const valid = hours.filter(h => typeof h.windKn === 'number')
  if (valid.length) {
    const first = valid.slice(0, 2)
    const nowDir = compass8(first[first.length - 1].windDir)
    const nowB = bftRange(first.map(h => h.windKn))
    const peak = valid.reduce((a, h) => (h.windKn > a.windKn ? h : a), valid[0])
    const peakB = beaufort(peak.windKn)
    const startB = Math.max(...first.map(h => beaufort(h.windKn)))
    const peakGustB = beaufort(Math.max(...valid.map(h => h.gustKn || h.windKn)))
    let s = `${nowDir} ${nowB} now`
    if (peakB > startB) {
      s += `, ${compass8(peak.windDir) === nowDir ? 'increasing' : 'increasing ' + compass8(peak.windDir)} ${peakB}`
      if (peakGustB > peakB) s += `, gusts ${peakGustB}`
      s += ` from about ${fmt(valid.find(h => beaufort(h.windKn) >= peakB).time)}`
    } else if (peakGustB > startB + 1) {
      s += `, gusts ${peakGustB}`
    } else {
      const last = valid[valid.length - 1]
      if (beaufort(last.windKn) < startB - 1) s += `, easing to ${beaufort(last.windKn)} later`
    }
    lines.push({ text: s + '.' })

    const rainy = valid.filter(h => (h.rainMm || 0) >= 0.2)
    if (rainy.length) {
      const endT = new Date(Date.parse(rainy[rainy.length - 1].time) + 3600e3).toISOString()
      const heavy = rainy.some(h => h.rainMm >= 2.5)
      lines.push({ text: `${heavy ? 'Heavy rain' : 'Rain'} ${fmt(rainy[0].time, true)}–${fmt(endT)}${heavy ? ', poor visibility in showers' : ''}.` })
    } else {
      lines.push({ text: 'Dry.' })
    }
  }
  if (barometer && barometer.label) {
    const p = barometer.label === 'steady' ? 'Pressure steady.' : `Pressure ${barometer.label}.`
    lines.push({ text: p })
  }
  if (v) {
    let take
    if (v.level === 'stay') take = 'Better stay in harbour today.'
    else if (v.level === 'caution' && v.reefBy) take = `Fine until ${fmt(v.reefBy)}. Reef early.`
    else if (v.level === 'caution') take = 'Sail, but keep an eye on it.'
    else take = v.text === 'Light winds' ? 'Light winds, maybe motor-sailing.' : 'Fine sailing day.'
    if (valid.some(h => (h.rainMm || 0) >= 1) && v.level !== 'stay') take = take.replace(/\.$/, ', pack oilskins.')
    lines.push({ text: take, emphasis: true })
  }
  return lines
}

module.exports = { verdict, summary, bftRange }
