#!/usr/bin/env node
'use strict'

// Runs the Sailpartner screen on your laptop without a boat or Signal K server:
// a simulated morning in Heiligenhafen (26 Oct 2026, a front coming in) with
// mocked Open-Meteo responses and three hours of wind/pressure history.
// If the signalk-baltic-warnings package sits next to this one (as in the
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

// The warnings plugin, with offline copies of its sources
const routers = { sailpartner: router }
let warnings = null
const WARN_DIR = path.join(__dirname, '..', '..', 'signalk-baltic-warnings')
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
  routers['signalk-baltic-warnings'] = mockRouter()
  warnings.registerWithRouter(routers['signalk-baltic-warnings'])
  warnings.start({ sources: { digitraffic: { enabled: false } } })
} catch (e) {
  console.log(`(signalk-baltic-warnings not found next to this package — warnings will be empty: ${e.message})`)
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
    const fakeRes = { statusCode: 200, status (c) { this.statusCode = c; return this }, json (d) { send(this.statusCode, d) } }
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
