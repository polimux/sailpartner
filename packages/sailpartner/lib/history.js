'use strict'

// Short on-board history kept by Sailpartner itself (no database needed):
//  - one bucket per minute for the last 24 h: wind (mean, max), direction, pressure
//  - daily distance and time under way for the last 14 days

const { meanDirection, norm180 } = require('./units')
const { distanceNm } = require('./route')

const DAY = 86400e3

class History {
  constructor (state = {}) {
    this.minutes = state.minutes || []
    this.days = state.days || {}
    this.lastPos = state.lastPos || null
    this.bucket = null
  }

  toJSON () { return { minutes: this.minutes, days: this.days, lastPos: this.lastPos } }

  // Called every few seconds with the live snapshot.
  sample (s, t = Date.now(), dayKey) {
    const minute = Math.floor(t / 60e3) * 60e3
    if (!this.bucket || this.bucket.t !== minute) {
      this.flush()
      this.bucket = { t: minute, n: 0, sum: 0, max: null, dirs: [], pressure: null }
    }
    const b = this.bucket
    if (typeof s.tws === 'number') {
      b.n++; b.sum += s.tws
      b.max = b.max === null ? s.tws : Math.max(b.max, s.tws)
    }
    if (typeof s.twd === 'number') b.dirs.push(s.twd)
    if (typeof s.pressureHPa === 'number') b.pressure = s.pressureHPa

    if (s.position) {
      if (this.lastPos && typeof s.sog === 'number' && s.sog >= 0.5) {
        const d = distanceNm(this.lastPos, s.position)
        if (d < 2) { // ignore GPS jumps
          const day = this.days[dayKey] || (this.days[dayKey] = { distanceNm: 0, underwaySec: 0, maxSog: 0 })
          day.distanceNm += d
          day.underwaySec += Math.min(60, (t - (this.lastPos.t || t)) / 1000)
          day.maxSog = Math.max(day.maxSog, s.sog)
        }
      }
      this.lastPos = { ...s.position, t }
    }
  }

  flush () {
    const b = this.bucket
    if (!b) return
    this.minutes.push({
      t: b.t,
      tws: b.n ? Math.round(b.sum / b.n * 10) / 10 : null,
      twsMax: b.max === null ? null : Math.round(b.max * 10) / 10,
      twd: b.dirs.length ? Math.round(meanDirection(b.dirs)) : null,
      p: b.pressure
    })
    const cut = b.t - DAY
    while (this.minutes.length && this.minutes[0].t < cut) this.minutes.shift()
    const keys = Object.keys(this.days).sort()
    while (keys.length > 14) delete this.days[keys.shift()]
    this.bucket = null
  }

  range (from, to) {
    const all = this.bucket ? this.minutes.concat([{ t: this.bucket.t, tws: this.bucket.n ? this.bucket.sum / this.bucket.n : null, twsMax: this.bucket.max, twd: this.bucket.dirs.length ? meanDirection(this.bucket.dirs) : null, p: this.bucket.pressure }]) : this.minutes
    return all.filter(m => m.t >= from && m.t <= to)
  }

  gust (minutes = 10, t = Date.now()) {
    const r = this.range(t - minutes * 60e3, t).filter(m => m.twsMax !== null)
    return r.length ? Math.round(Math.max(...r.map(m => m.twsMax)) * 10) / 10 : null
  }

  // 7 points, every 30 min over the last 3 h, plus the trend between first and last half hour
  windHistory (t = Date.now()) {
    const points = []
    for (let i = 6; i >= 0; i--) {
      const center = t - i * 30 * 60e3
      const r = this.range(center - 5 * 60e3, center + 5 * 60e3)
      const tws = r.filter(m => m.tws !== null)
      const twd = r.filter(m => m.twd !== null)
      points.push({
        t: new Date(center).toISOString(),
        tws: tws.length ? Math.round(tws.reduce((a, m) => a + m.tws, 0) / tws.length * 10) / 10 : null,
        twd: twd.length ? Math.round(meanDirection(twd.map(m => m.twd))) : null
      })
    }
    const first = points.find(p => p.tws !== null && p.twd !== null)
    const last = [...points].reverse().find(p => p.tws !== null && p.twd !== null)
    let trend = null
    if (first && last && first !== last) {
      const veer = Math.round(norm180(last.twd - first.twd))
      const delta = Math.round((last.tws - first.tws) * 10) / 10
      const parts = []
      if (Math.abs(veer) >= 10) parts.push(`${veer > 0 ? 'turned right' : 'turned left'} ${Math.abs(veer)}°`)
      else parts.push('steady direction')
      if (Math.abs(delta) >= 2) parts.push(`${Math.abs(Math.round(delta))} kn ${delta > 0 ? 'stronger' : 'lighter'}`)
      else parts.push('steady speed')
      trend = { veerDeg: veer, deltaKn: delta, text: parts.join(' · ') }
    }
    return { points, trend }
  }

  // Highest wind in the last `hours` hours, with its time
  maxWind (hours = 12, t = Date.now()) {
    const r = this.range(t - hours * 3600e3, t).filter(m => m.twsMax !== null)
    if (!r.length) return null
    const top = r.reduce((a, m) => (m.twsMax > a.twsMax ? m : a), r[0])
    return { kn: Math.round(top.twsMax), at: new Date(top.t).toISOString() }
  }

  pressureSeries (hours = 24, t = Date.now(), stepMin = 30) {
    const out = []
    for (let x = t - hours * 3600e3; x <= t; x += stepMin * 60e3) {
      const r = this.range(x - stepMin * 30e3, x + stepMin * 30e3).filter(m => typeof m.p === 'number')
      if (r.length) out.push({ t: new Date(x).toISOString(), hPa: Math.round(r[r.length - 1].p * 10) / 10 })
    }
    return out
  }

  // Barometer tendency over 3 h with the classic thresholds
  barometer (t = Date.now()) {
    const series = this.range(t - 3.25 * 3600e3, t).filter(m => typeof m.p === 'number')
    if (series.length < 2) return null
    const latest = series[series.length - 1]
    const target = t - 3 * 3600e3
    const old = series.reduce((a, m) => (Math.abs(m.t - target) < Math.abs(a.t - target) ? m : a), series[0])
    const span = latest.t - old.t
    if (span < 2.5 * 3600e3) return { current: latest.p, change3h: null, label: null, severity: null }
    const c = Math.round((latest.p - old.p) * (3 * 3600e3 / span) * 10) / 10
    const a = Math.abs(c); const dir = c < 0 ? 'falling' : 'rising'
    let label = 'steady'; let severity = null
    if (a >= 1.0 && a <= 1.5) label = `${dir} slowly`
    else if (a > 1.5 && a <= 3.0) { label = dir; severity = c < 0 ? 'alert' : null }
    else if (a > 3.0 && a <= 6.0) { label = `${dir} fast`; severity = c < 0 ? 'warn' : 'alert' }
    else if (a > 6.0) { label = `${dir} very fast`; severity = c < 0 ? 'alarm' : 'warn' }
    return { current: Math.round(latest.p * 10) / 10, change3h: c, label, severity }
  }

  day (dayKey) {
    const d = this.days[dayKey]
    if (!d) return null
    return { distanceNm: Math.round(d.distanceNm * 10) / 10, underwayH: Math.round(d.underwaySec / 360) / 10, maxSog: Math.round(d.maxSog * 10) / 10 }
  }
}

module.exports = { History }
