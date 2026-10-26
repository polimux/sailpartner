#!/usr/bin/env node
'use strict'

// Runs the Sailpartner screen on your laptop without a boat or Signal K server:
// a simulated morning in Heiligenhafen (26 Oct, front coming in) with mocked
// Open-Meteo responses, three hours of wind/pressure history and two warnings.
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

const warningsStatus = {
  sources: [
    { id: 'sjofartsverket', enabled: true, lastSuccess: new Date(now - 6 * 60e3).toISOString(), lastError: null },
    { id: 'digitraffic', enabled: true, lastSuccess: new Date(now - 4 * 60e3).toISOString(), lastError: null }
  ]
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }
const PUBLIC = path.join(__dirname, '..', 'public')

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body) }
  if (url.pathname.startsWith('/plugins/sailpartner/')) {
    const route = `${req.method.toLowerCase()} ${url.pathname.replace('/plugins/sailpartner', '')}`
    const h = router.routes[route]
    if (!h) return send(404, { error: 'not found' })
    let body = ''
    for await (const c of req) body += c
    const fakeReq = { query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : undefined }
    const fakeRes = { statusCode: 200, status (c) { this.statusCode = c; return this }, json (d) { send(this.statusCode, d) } }
    return h(fakeReq, fakeRes)
  }
  if (url.pathname === '/plugins/signalk-baltic-warnings/status') return send(200, warningsStatus)
  if (url.pathname.startsWith('/plugins/signalk-baltic-warnings/')) return send(200, { ok: true })
  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname)
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return send(404, 'not found', 'text/plain')
  send(200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream')
})

server.listen(PORT, () => console.log(`Sailpartner demo on http://localhost:${PORT}/  (simulated 26 Oct 2026, 08:56 in Heiligenhafen)`))
process.on('SIGINT', () => { plugin.stop(); process.exit(0) })
