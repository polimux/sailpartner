'use strict'

// Live view of everything arriving in Signal K for our own boat: one row per
// path and source, with the NMEA 2000 PGN or NMEA 0183 sentence it came from,
// how fresh it is and how often it arrives, plus a running log of updates.

const PGN = {
  59392: 'ISO acknowledgement', 60928: 'ISO address claim', 126992: 'System time', 126993: 'Heartbeat', 126996: 'Product information',
  127233: 'Man overboard', 127237: 'Heading/track control', 127245: 'Rudder', 127250: 'Vessel heading', 127251: 'Rate of turn',
  127257: 'Attitude', 127258: 'Magnetic variation', 127488: 'Engine, rapid', 127489: 'Engine, dynamic', 127493: 'Transmission',
  127505: 'Fluid level', 127506: 'DC detailed status', 127507: 'Charger status', 127508: 'Battery status', 127513: 'Battery configuration',
  128259: 'Speed through water', 128267: 'Water depth', 128275: 'Distance log', 129025: 'Position, rapid', 129026: 'COG & SOG, rapid',
  129029: 'GNSS position', 129033: 'Time & date', 129038: 'AIS class A position', 129039: 'AIS class B position', 129040: 'AIS class B extended',
  129283: 'Cross track error', 129284: 'Navigation data', 129285: 'Route/waypoint', 129539: 'GNSS DOPs', 129540: 'GNSS satellites in view',
  129794: 'AIS class A static', 129809: 'AIS class B static A', 129810: 'AIS class B static B', 130306: 'Wind data', 130310: 'Environmental parameters',
  130311: 'Environmental parameters', 130312: 'Temperature', 130313: 'Humidity', 130314: 'Actual pressure', 130316: 'Temperature, extended',
  130577: 'Direction data', 130578: 'Vessel speed components'
}
const SENTENCE = {
  APB: 'Autopilot B', BOD: 'Bearing origin to destination', BWC: 'Bearing to waypoint', DBK: 'Depth below keel', DBS: 'Depth below surface',
  DBT: 'Depth below transducer', DPT: 'Depth', GGA: 'GPS fix', GLL: 'Geographic position', GSA: 'GNSS DOP', GSV: 'Satellites in view',
  HDG: 'Heading, deviation, variation', HDM: 'Heading, magnetic', HDT: 'Heading, true', MDA: 'Meteorological composite', MTW: 'Water temperature',
  MWD: 'Wind direction & speed', MWV: 'Wind speed & angle', RMB: 'Navigation info', RMC: 'Recommended minimum', ROT: 'Rate of turn',
  RSA: 'Rudder angle', VDM: 'AIS message', VDO: 'AIS own vessel', VHW: 'Speed through water', VLW: 'Distance log', VTG: 'Course & speed',
  VWR: 'Relative wind', XDR: 'Transducer measurement', XTE: 'Cross track error', ZDA: 'Time & date'
}

function describeSource (source, $source) {
  const s = source || {}
  if (s.pgn !== undefined && s.pgn !== null) {
    return { type: 'NMEA 2000', code: `PGN ${s.pgn}`, name: PGN[s.pgn] || '', label: s.label || '', device: s.src !== undefined ? `src ${s.src}` : '', id: $source || '' }
  }
  if (s.sentence) {
    return { type: 'NMEA 0183', code: `${s.talker || ''}${s.sentence}`, name: SENTENCE[s.sentence] || '', label: s.label || '', device: '', id: $source || '' }
  }
  const label = s.label || ($source || '').split('.')[0] || 'unknown'
  return { type: s.type && s.type !== 'NMEA2000' && s.type !== 'NMEA0183' ? s.type : 'plugin', code: '', name: '', label, device: '', id: $source || label }
}

// Keep values small enough to list: positions and numbers as they are, big objects summarised.
function compact (v) {
  if (v === null || typeof v !== 'object') return v
  const s = JSON.stringify(v)
  if (s.length <= 160) return v
  if (v.state && v.message !== undefined) return { state: v.state, message: String(v.message).slice(0, 100) }
  return s.slice(0, 157) + '…'
}

class Feed {
  constructor ({ logSize = 200, now = () => Date.now() } = {}) {
    this.now = now
    this.logSize = logSize
    this.reset()
  }

  reset () {
    this.rows = new Map()
    this.log = []
    this.seq = 0
    this.sources = new Map()
    this.recent = []
    this.started = this.now()
  }

  onDelta (d) {
    if (!d || typeof d.path !== 'string' || d.path === '') return
    const t = this.now()
    const src = describeSource(d.source, d.$source)
    const key = `${d.path}|${src.id}`
    let row = this.rows.get(key)
    if (!row) { row = { path: d.path, source: src, count: 0, first: t }; this.rows.set(key, row) }
    row.value = compact(d.value)
    row.t = t
    row.timestamp = d.timestamp || null
    row.count++
    row.source = src
    this.seq++
    this.log.push({ seq: this.seq, t, path: d.path, value: row.value, source: { type: src.type, code: src.code, label: src.label } })
    if (this.log.length > this.logSize) this.log.splice(0, this.log.length - this.logSize)
    const sKey = src.type === 'plugin' ? src.label : `${src.label || src.type}${src.device ? ' ' + src.device : ''}`
    const st = this.sources.get(sKey) || { name: sKey, type: src.type, count: 0, last: 0 }
    st.count++; st.last = t
    this.sources.set(sKey, st)
    this.recent.push(t)
    while (this.recent.length && this.recent[0] < t - 10e3) this.recent.shift()
  }

  snapshot ({ logSince = 0, logLimit = 40 } = {}) {
    const t = this.now()
    const rows = [...this.rows.values()].sort((a, b) => a.path.localeCompare(b.path) || a.source.id.localeCompare(b.source.id)).map(r => ({
      path: r.path,
      value: r.value,
      source: r.source,
      ageMs: t - r.t,
      count: r.count,
      perMin: Math.round(r.count / Math.max(1 / 6, (t - r.first) / 60e3) * 10) / 10
    }))
    const log = this.log.filter(l => l.seq > logSince).slice(-logLimit)
    return {
      now: new Date(t).toISOString(),
      seq: this.seq,
      updatesPerSec: Math.round(this.recent.filter(x => x >= t - 10e3).length / 10 * 10) / 10,
      paths: rows,
      log,
      sources: [...this.sources.values()].sort((a, b) => b.count - a.count).map(s => ({ ...s, ageMs: t - s.last }))
    }
  }
}

module.exports = { Feed, describeSource, PGN, SENTENCE }
