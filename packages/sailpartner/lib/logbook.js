'use strict'

// A simple logbook kept by Sailpartner itself: one JSON file per day in the
// plugin's data folder, plus a file with daily totals for the season.
//
// Entries are written
//   - automatically when the boat leaves or reaches a berth/anchorage ("event"),
//   - every hour while under way ("auto"),
//   - by hand from the Logbook page ("manual").

const fs = require('fs')
const path = require('path')

const HOURLY_MS = 60 * 60e3

function round (v, n = 1) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : null }

class Logbook {
  constructor (dir) {
    this.dir = dir
    this.cache = new Map()
    this.state = this.readJson('state.json', { boatState: null, lastAuto: 0 })
    this.daysTotals = this.readJson('days.json', {})
  }

  file (name) { return path.join(this.dir, name) }

  readJson (name, fallback) {
    if (!this.dir) return fallback
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')) } catch (e) { return fallback }
  }

  writeJson (name, obj) {
    if (!this.dir) return
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.file(name) + '.tmp', JSON.stringify(obj))
      fs.renameSync(this.file(name) + '.tmp', this.file(name))
    } catch (e) { /* best effort */ }
  }

  entries (day) {
    if (!this.cache.has(day)) this.cache.set(day, this.readJson(`${day}.json`, []))
    return this.cache.get(day)
  }

  days () {
    const fromFiles = this.dir && fs.existsSync(this.dir)
      ? fs.readdirSync(this.dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10))
      : []
    return [...new Set([...fromFiles, ...this.cache.keys()].filter(d => this.entries(d).length))].sort()
  }

  // snapshot: live values at the moment of writing (from lib/live)
  add (day, { t, kind = 'manual', text = '', snapshot = {} }) {
    const s = snapshot
    const entry = {
      t: new Date(t).toISOString(),
      kind,
      text: String(text).slice(0, 200),
      position: s.position ? { latitude: round(s.position.latitude, 5), longitude: round(s.position.longitude, 5) } : null,
      cog: round(s.cog, 0),
      sog: round(s.sog),
      heading: round(s.heading, 0),
      tws: round(s.tws),
      twd: typeof s.twd === 'number' ? Math.round(s.twd) : null,
      pressure: round(s.pressureHPa)
    }
    const list = this.entries(day)
    list.push(entry)
    list.sort((a, b) => a.t.localeCompare(b.t))
    this.writeJson(`${day}.json`, list)
    return entry
  }

  remove (day, t) {
    const list = this.entries(day)
    const i = list.findIndex(e => e.t === t && e.kind === 'manual')
    if (i < 0) return false
    list.splice(i, 1)
    this.writeJson(`${day}.json`, list)
    return true
  }

  // Called once a minute with the boat state and live values.
  tick ({ t, day, boatState, snapshot, placeName }) {
    const added = []
    const prev = this.state.boatState
    if (prev && boatState && prev !== boatState) {
      let text = null
      if (boatState === 'underway') text = prev === 'anchored' ? 'Anchor up' : `Cast off${placeName ? ' · ' + placeName : ''}`
      else if (boatState === 'anchored') text = 'Anchored'
      else if (boatState === 'moored') text = `Moored${placeName ? ' · ' + placeName : ''}`
      if (text) added.push(this.add(day, { t, kind: 'event', text, snapshot }))
      if (boatState === 'underway') this.state.lastAuto = t
    }
    if (boatState === 'underway' && t - (this.state.lastAuto || 0) >= HOURLY_MS) {
      added.push(this.add(day, { t, kind: 'auto', text: '', snapshot }))
      this.state.lastAuto = t
    }
    if (boatState !== prev) {
      this.state.boatState = boatState
      this.writeJson('state.json', this.state)
    }
    return added
  }

  // Daily totals (distance, time under way) for season statistics.
  setDayTotals (day, totals) {
    if (!totals) return
    const prev = this.daysTotals[day]
    if (prev && prev.distanceNm === totals.distanceNm && prev.underwayH === totals.underwayH) return
    this.daysTotals[day] = { distanceNm: totals.distanceNm, underwayH: totals.underwayH, maxSog: totals.maxSog }
    this.writeJson('days.json', this.daysTotals)
  }

  season (year) {
    const days = Object.entries(this.daysTotals).filter(([d]) => d.startsWith(String(year)))
    const sailed = days.filter(([, v]) => v.distanceNm >= 1)
    const longest = sailed.reduce((a, [d, v]) => (!a || v.distanceNm > a.distanceNm ? { day: d, distanceNm: v.distanceNm } : a), null)
    return {
      year,
      distanceNm: round(sailed.reduce((a, [, v]) => a + v.distanceNm, 0)),
      underwayH: round(sailed.reduce((a, [, v]) => a + (v.underwayH || 0), 0)),
      daysUnderway: sailed.length,
      daysAboard: days.length,
      longest
    }
  }

  csv (day) {
    const head = 'time,latitude,longitude,cog,sog_kn,heading,wind_kn,wind_dir,pressure_hpa,kind,entry'
    const q = v => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
    const rows = this.entries(day).map(e => [e.t, e.position && e.position.latitude, e.position && e.position.longitude, e.cog, e.sog, e.heading, e.tws, e.twd, e.pressure, e.kind, e.text].map(q).join(','))
    return [head, ...rows].join('\n') + '\n'
  }
}

module.exports = { Logbook }
