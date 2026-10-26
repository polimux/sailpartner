'use strict'

// On-board barometer tendency, using the classic 3-hour rule.
//   < 1.0 hPa steady · 1.0–1.5 slow · 1.6–3.0 falling/rising · 3.1–6.0 fast · > 6.0 very fast

const KEEP_MS = 4 * 3600e3
const WINDOW_MS = 3 * 3600e3
const MIN_SPAN_MS = 2.5 * 3600e3

class Barometer {
  constructor (samples = []) {
    this.samples = samples.filter(s => typeof s.t === 'number' && typeof s.hPa === 'number')
  }

  add (pascal, t = Date.now()) {
    if (typeof pascal !== 'number' || !isFinite(pascal)) return
    const hPa = pascal > 2000 ? pascal / 100 : pascal // accept Pa (Signal K) or hPa
    const last = this.samples[this.samples.length - 1]
    if (last && t - last.t < 60e3) return // at most one sample per minute
    this.samples.push({ t, hPa: Math.round(hPa * 100) / 100 })
    this.samples = this.samples.filter(s => t - s.t <= KEEP_MS)
  }

  // Change over the last 3 hours in hPa, scaled to 3 h. null if not enough history yet.
  tendency (t = Date.now()) {
    if (this.samples.length < 2) return null
    const latest = this.samples[this.samples.length - 1]
    const target = t - WINDOW_MS
    let old = null
    for (const s of this.samples) {
      if (!old || Math.abs(s.t - target) < Math.abs(old.t - target)) old = s
    }
    const span = latest.t - old.t
    if (span < MIN_SPAN_MS) return null
    const change = (latest.hPa - old.hPa) * (WINDOW_MS / span)
    return { current: latest.hPa, change3h: Math.round(change * 10) / 10, spanHours: Math.round(span / 360e3) / 10 }
  }

  classify (t = Date.now()) {
    const tend = this.tendency(t)
    if (!tend) return null
    const c = tend.change3h
    const a = Math.abs(c)
    const dir = c < 0 ? 'falling' : 'rising'
    let label; let severity = null
    if (a < 1.0) label = 'steady'
    else if (a <= 1.5) label = `${dir} slowly`
    else if (a <= 3.0) { label = dir; severity = c < 0 ? 'alert' : null }
    else if (a <= 6.0) { label = `${dir} fast`; severity = c < 0 ? 'warn' : 'alert' }
    else { label = `${dir} very fast`; severity = c < 0 ? 'alarm' : 'warn' }
    return { ...tend, label, severity }
  }

  // A warning object (same shape as source warnings) or null when nothing to report.
  toWarning (ownPosition, t = Date.now()) {
    const cl = this.classify(t)
    if (!cl || !cl.severity) return null
    const sign = cl.change3h > 0 ? '+' : ''
    const squall = cl.change3h > 0 ? ' Expect gusty, squally wind behind the front.' : ''
    return {
      id: 'onboard-pressure',
      issuer: 'ON BOARD',
      number: '',
      label: 'On board barometer',
      title: `Pressure ${cl.label}`,
      text: `${sign}${cl.change3h} hPa in 3 h, now ${cl.current.toFixed(1)} hPa.${squall}`,
      areas: [],
      category: 'weather',
      severity: cl.severity,
      issued: new Date(t).toISOString(),
      validFrom: null,
      validTo: null,
      cancels: [],
      geometry: { positions: ownPosition ? [ownPosition] : [] },
      onboard: true,
      tendency: cl
    }
  }
}

module.exports = { Barometer }
