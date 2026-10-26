'use strict'

// Persistent warning store (a single JSON file in the plugin data directory).
// No native dependencies, so it installs cleanly on a Raspberry Pi.

const fs = require('fs')
const path = require('path')

const HISTORY_DAYS = 30

function geomScore (g) {
  if (!g) return 0
  return (g.polygon ? 100 + g.polygon.length : 0) + (g.circle ? 50 : 0) + (g.positions ? g.positions.length : 0)
}

class Store {
  constructor (file) {
    this.file = file
    this.state = { warnings: {}, history: {}, sources: {}, pressure: [], route: null }
    this.saveTimer = null
    if (file) this.load()
  }

  load () {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.state = { ...this.state, ...s }
    } catch (e) { /* first run */ }
  }

  save () {
    if (!this.file) return
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveNow(), 2000)
  }

  saveNow () {
    if (!this.file) return
    clearTimeout(this.saveTimer)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.state))
      fs.renameSync(tmp, this.file)
    } catch (e) { /* best effort */ }
  }

  sourceStatus (id) {
    if (!this.state.sources[id]) this.state.sources[id] = { lastAttempt: null, lastSuccess: null, lastError: null, count: 0 }
    return this.state.sources[id]
  }

  markAttempt (id, now = new Date()) { this.sourceStatus(id).lastAttempt = now.toISOString() }

  markError (id, err, now = new Date()) {
    const s = this.sourceStatus(id)
    s.lastError = { at: now.toISOString(), message: String(err && err.message ? err.message : err) }
    this.save()
  }

  // Replace the set of warnings reported by one source.
  update (sourceId, warnings, now = new Date()) {
    const nowIso = now.toISOString()
    const seen = new Set()
    for (const w of warnings) {
      seen.add(w.id)
      const ex = this.state.warnings[w.id]
      if (!ex) {
        this.state.warnings[w.id] = { ...w, sources: [sourceId], firstSeen: nowIso, lastSeen: nowIso }
        delete this.state.history[w.id]
        continue
      }
      const merged = { ...ex, lastSeen: nowIso }
      if (!merged.sources.includes(sourceId)) merged.sources = merged.sources.concat([sourceId])
      merged.areas = Array.from(new Set([...(ex.areas || []), ...(w.areas || [])]))
      if (ex.channels || w.channels) merged.channels = Array.from(new Set([...(ex.channels || []), ...(w.channels || [])]))
      if (geomScore(w.geometry) > geomScore(ex.geometry)) merged.geometry = w.geometry
      if (ex.sources[0] === sourceId) {
        // primary source: refresh text and validity
        Object.assign(merged, { title: w.title, text: w.text, validFrom: w.validFrom, validTo: w.validTo, severity: w.severity, category: w.category })
      }
      this.state.warnings[w.id] = merged
    }
    // Warnings this source no longer lists
    for (const [id, w] of Object.entries(this.state.warnings)) {
      if (!w.sources.includes(sourceId) || seen.has(id)) continue
      w.sources = w.sources.filter(s => s !== sourceId)
      if (w.sources.length === 0) this.retire(id, 'withdrawn', nowIso)
    }
    // Explicit cancellations ("CANCEL NAV WARN 516/26")
    for (const w of warnings) {
      for (const num of w.cancels || []) {
        const [n, yy] = num.split('/')
        const target = `${w.issuer.toLowerCase().replace(/\s+/g, '-')}-${Number(n)}-${yy}`
        if (target !== w.id && this.state.warnings[target]) this.retire(target, `cancelled by ${w.label}`, nowIso)
      }
    }
    const st = this.sourceStatus(sourceId)
    st.lastSuccess = nowIso
    st.lastError = null
    st.count = warnings.length
    this.pruneHistory(now)
    this.save()
  }

  retire (id, reason, nowIso) {
    const w = this.state.warnings[id]
    if (!w) return
    delete this.state.warnings[id]
    this.state.history[id] = { ...w, removedAt: nowIso, removedReason: reason }
  }

  pruneHistory (now = new Date()) {
    const limit = now.getTime() - HISTORY_DAYS * 86400e3
    for (const [id, w] of Object.entries(this.state.history)) {
      if (Date.parse(w.removedAt) < limit) delete this.state.history[id]
    }
  }

  list () { return Object.values(this.state.warnings) }
}

module.exports = { Store }
