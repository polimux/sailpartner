#!/usr/bin/env node
'use strict'

// Runs the Sailpartner screen on your laptop without a boat or Signal K server:
// a simulated morning in Heiligenhafen (26 Oct 2026, a front coming in) with
// mocked Open-Meteo responses and three hours of wind/pressure history.
// If the sailwarnings package sits next to this one (as in the
// repository), it runs too, fed with a saved copy of the BALTICO warnings page.
//
//   npm run demo   ->  http://localhost:3333/

const http = require('http')
const fs = require('fs')
const path = require('path')
const createPlugin = require('..')
const { mockApp, mockRouter } = require('../test/mockserver')
const { mockHttp } = require('../test/scenario')

const PORT = Number(process.env.PORT || 3333)
const T0 = Date.parse('2026-10-26T04:56:00Z')
let now = T0

const app = mockApp()
const plugin = createPlugin(app, { http: mockHttp, now: () => now })
const router = mockRouter()
plugin.registerWithRouter(router)
plugin.start({})

// ---- a week of battery history: solar by day, fridge and lights at night ----
;(function seedBattery () {
  const h = plugin._internals.history
  const T = require('../lib/time')
  let soc = 80
  const tz = 'Europe/Berlin'
  for (let t = T0 - 7 * 86400e3; t < T0; t += 60e3) {
    const local = T.parts(t, tz).h
    const day = Math.floor((t - (T0 - 7 * 86400e3)) / 86400e3)
    const sunny = [1, 1, 0, 1, 1, 1, 0][day]
    let current = -1.2 // fridge, instruments, Pi
    if (local >= 10 && local < 16) current = sunny ? 9 : 2
    if (local >= 19 && local < 23) current = -3.5 // lights, cooking
    soc = Math.max(35, Math.min(100, soc + current / 60 / 200 * 100))
    if (soc >= 100 && current > 0) current = 0.4
    h.sampleBattery({ soc: Math.round(soc * 10) / 10, voltage: 12.05 + soc * 0.0095, current }, t, T.dayKey(t, tz))
  }
})()

// three hours of history: wind veering and building, pressure falling
for (let s = 0; s <= 3 * 3600; s += 20) {
  now = T0 + s * 1000
  const f = s / (3 * 3600)
  app.self['environment.wind.speedApparent'] = { value: (11 + 3.1 * f + (s % 600 === 300 ? 4 : 0)) / 1.943844 }
  app.self['environment.wind.angleApparent'] = { value: (-57 + 17 * f) * Math.PI / 180 }
  app.self['environment.outside.pressure'] = { value: (1011.9 - 3.1 * f) * 100 }
  plugin._internals.tick()
}
now = T0 + 3 * 3600e3

// ---- yesterday's sail and the season so far in the logbook ----
;(function seedLogbook () {
  const lb = plugin._internals.logbook
  const h = plugin._internals.history
  const y = '2026-10-25'
  const at = (hh, mm) => Date.parse(`${y}T${String(hh - 1).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`) // CET
  const snap = (lat, lon, cog, sog, tws, twd, p) => ({ position: { latitude: lat, longitude: lon }, cog, sog, tws, twd, pressureHPa: p })
  const rows = [
    [9, 12, 'event', 'Cast off · Heiligenhafen', snap(54.3735, 11.005, null, 0, 9, 225, 1017.2)],
    [9, 40, 'manual', 'Main and genoa up', snap(54.381, 11.048, 62, 5.1, 10, 225, 1017.1)],
    [10, 12, 'auto', '', snap(54.418, 11.135, 62, 5.4, 11, 230, 1016.9)],
    [11, 12, 'auto', '', snap(54.465, 11.29, 71, 5.8, 12, 230, 1016.6)],
    [11, 40, 'manual', 'Reefed', snap(54.476, 11.338, 71, 5.6, 13, 232, 1016.4)],
    [12, 12, 'auto', '', snap(54.455, 11.402, 118, 6.1, 13, 235, 1016.2)],
    [13, 0, 'manual', 'Tacked', snap(54.400, 11.31, 242, 4.6, 12, 235, 1016.3)],
    [13, 12, 'auto', '', snap(54.398, 11.29, 242, 4.7, 12, 235, 1016.3)],
    [14, 12, 'auto', '', snap(54.385, 11.162, 251, 4.9, 11, 230, 1016.6)],
    [15, 20, 'manual', 'Engine on', snap(54.377, 11.046, 265, 5.2, 10, 225, 1016.9)],
    [16, 2, 'event', 'Moored · Heiligenhafen', snap(54.3735, 11.005, null, 0, 9, 225, 1017.1)]
  ]
  for (const [hh, mm, kind, text, s] of rows) lb.add(y, { t: at(hh, mm), kind, text, snapshot: s })
  h.days[y] = { distanceNm: 34.2, underwaySec: 6.83 * 3600, maxSog: 7.3 }
  lb.setDayTotals(y, { distanceNm: 34.2, underwayH: 6.8, maxSog: 7.3 })
  // earlier days of the season (made up for the demo)
  let seed = 7
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 }
  for (let i = 0; i < 40; i++) {
    const d = new Date(Date.UTC(2026, 4, 1) + Math.floor(i * 4.2 + rnd() * 3) * 86400e3).toISOString().slice(0, 10)
    const nm = i % 5 === 4 ? 0 : Math.round((8 + rnd() * 30) * 10) / 10
    lb.setDayTotals(d, { distanceNm: nm, underwayH: Math.round(nm / 5 * 10) / 10, maxSog: 6 + rnd() * 2 })
  }
  lb.state.boatState = 'moored'
})()

// ---- live NMEA traffic, like a boat in the marina with instruments on ----
const N2K = (pgn, src, label = 'can0') => ({ source: { label, type: 'NMEA2000', pgn, src: String(src) }, $source: `${label}.${src}` })
const BLE = { source: { label: 'victron-ble', type: 'plugin' }, $source: 'victron-ble' }
const I2C = { source: { label: 'openplotter-i2c', type: 'plugin' }, $source: 'openplotter-i2c' }
const RMC = { source: { label: 'ttyUSB0', type: 'NMEA0183', talker: 'GP', sentence: 'RMC' }, $source: 'ttyUSB0.GP' }
const DEG = Math.PI / 180
let tick = 0
function simulate () {
  tick++
  const noise = (a) => (Math.random() - 0.5) * 2 * a
  const send = (path, value, src) => app.emit(path, value, src.source, src.$source)
  send('environment.wind.speedApparent', (14 + noise(2.5)) / 1.943844, N2K(130306, 115))
  send('environment.wind.angleApparent', (-40 + noise(6)) * DEG, N2K(130306, 115))
  send('navigation.position', { latitude: 54.37330 + noise(0.00002), longitude: 11.00520 + noise(0.00003) }, N2K(129025, 3))
  send('navigation.courseOverGroundTrue', (180 + noise(90)) * DEG, N2K(129026, 3))
  send('navigation.speedOverGround', Math.abs(noise(0.05)), N2K(129026, 3))
  send('navigation.headingMagnetic', (266 + noise(1)) * DEG, N2K(127250, 2))
  send('environment.depth.belowTransducer', 3.4 + noise(0.05), N2K(128267, 35))
  if (tick % 2 === 0) {
    send('electrical.batteries.house.voltage', 12.64 + noise(0.01), BLE)
    send('electrical.batteries.house.current', -3.2 + noise(0.3), BLE)
    send('electrical.batteries.house.capacity.stateOfCharge', 0.78, BLE)
    send('navigation.position', { latitude: 54.3733, longitude: 11.0052 }, RMC)
  }
  if (tick % 5 === 0) {
    send('navigation.magneticVariation', 3.9 * DEG, N2K(127258, 2))
    send('environment.water.temperature', 273.15 + 11.8, N2K(130312, 35))
    send('navigation.speedThroughWater', 0, N2K(128259, 36))
    send('navigation.log', 21345 * 1852, N2K(128275, 36))
    send('environment.outside.pressure', 100880 + noise(5), I2C)
    send('environment.inside.temperature', 273.15 + 14.2, I2C)
    send('environment.inside.relativeHumidity', 0.78, I2C)
  }
}
setInterval(simulate, 1000)

// The warnings plugin, with offline copies of its sources
const routers = { sailpartner: router }
let warnings = null
const WARN_DIR = path.join(__dirname, '..', '..', 'sailwarnings')
// demo notifications come from the real warnings plugin, not the test fixtures
for (const k of ['notifications.navigation.warnings', 'notifications.environment.warnings']) app.self[k] = {}
try {
  const createWarnings = require(WARN_DIR)
  const fixture = fs.readFileSync(path.join(WARN_DIR, 'test', 'fixtures', 'sjofartsverket-navtex.html'), 'utf8')
  const offline = {
    fetchText: async url => {
      if (url.includes('Navigationsvarningar/Navtex')) return fixture
      if (url.includes('Navigationsvarningar/VHF')) return '<html><body></body></html>'
      throw new Error('offline demo')
    },
    fetchJson: async () => { throw new Error('offline demo') }
  }
  warnings = createWarnings(app, { http: offline })
  routers['sailwarnings'] = mockRouter()
  warnings.registerWithRouter(routers['sailwarnings'])
  warnings.start({ sources: { digitraffic: { enabled: false } } })
} catch (e) {
  console.log(`(sailwarnings not found next to this package — warnings will be empty: ${e.message})`)
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }
const PUBLIC = path.join(__dirname, '..', 'public')

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body) }
  const m = /^\/plugins\/([^/]+)(\/.*)$/.exec(url.pathname)
  if (m) {
    const r = routers[m[1]]
    const h = r && r.routes[`${req.method.toLowerCase()} ${m[2]}`]
    if (!h) return send(404, { error: 'not found' })
    let body = ''
    for await (const c of req) body += c
    const fakeReq = { query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : {} }
    const headers = {}
    const fakeRes = {
      statusCode: 200,
      status (c) { this.statusCode = c; return this },
      setHeader (k, v) { headers[k] = v },
      send (d) { res.writeHead(this.statusCode, headers); res.end(d) },
      json (d) { send(this.statusCode, d) }
    }
    try { return await h(fakeReq, fakeRes) } catch (e) { return send(500, { error: e.message }) }
  }
  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname)
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return send(404, 'not found', 'text/plain')
  send(200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream')
})

async function main () {
  if (warnings) {
    const src = require(path.join(WARN_DIR, 'lib', 'sources')).find(s => s.id === 'sjofartsverket')
    await warnings._internals.runSource(src)
  }
  server.listen(PORT, () => console.log(`Sailpartner demo on http://localhost:${PORT}/  (simulated 26 Oct 2026, 08:56 in Heiligenhafen)`))
}
main()

process.on('SIGINT', () => { plugin.stop(); if (warnings) warnings.stop(); process.exit(0) })
