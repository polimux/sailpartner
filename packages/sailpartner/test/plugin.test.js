'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const createPlugin = require('..')
const { mockApp, mockRouter } = require('./mockserver')
const { mockHttp } = require('./scenario')
const live = require('../lib/live')

const T0 = Date.parse('2026-10-26T04:56:00Z')

test('live snapshot from Signal K paths', () => {
  const app = mockApp()
  const s = live.snapshot(app)
  assert.equal(s.aws, 14.1)
  assert.equal(s.awa, -40)
  assert.equal(s.tws, 14.1, 'moored: true wind falls back to apparent')
  assert.equal(s.twd, 230, 'heading 270 + angle -40')
  assert.equal(s.pressureHPa, 1008.8)
  assert.equal(s.cabinTemp, 14.2)
  assert.equal(s.cabinHumidity, 78)
  assert.deepEqual(s.battery, { id: 'house', soc: 78, voltage: 12.64, current: -3.2, power: -40, consumedAh: -44, timeRemainingS: 151200 })
  assert.equal(live.boatState(s), 'moored')
  const w = live.warnings(app)
  assert.equal(w.length, 3)
  assert.equal(w[0].state, 'warn')
})

test('brief end to end: history, trip, verdict', async (t) => {
  const app = mockApp()
  let now = T0
  const plugin = createPlugin(app, { http: mockHttp, now: () => now })
  t.after(() => plugin.stop())
  const router = mockRouter()
  plugin.registerWithRouter(router)
  plugin.start({})

  // three hours of history: wind veering and building, pressure falling
  for (let s = 0; s <= 3 * 3600; s += 30) {
    now = T0 + s * 1000
    const f = s / (3 * 3600)
    app.self['environment.wind.speedApparent'] = { value: (11 + 3.1 * f) / 1.943844 }
    app.self['environment.wind.angleApparent'] = { value: (-57 + 17 * f) * Math.PI / 180 }
    app.self['environment.outside.pressure'] = { value: (1011.9 - 3.1 * f) * 100 }
    plugin._internals.tick()
  }
  now = T0 + 3 * 3600e3 // 07:56Z = 08:56 local

  let r = await router.call('get', '/destinations')
  assert.ok(r.body.destinations.some(d => d.name === 'Kühlungsborn'))

  r = await router.call('get', '/brief')
  assert.equal(r.status, 200)
  const b = r.body
  assert.equal(b.place.name, 'Heiligenhafen')
  assert.equal(b.place.state, 'moored')
  assert.equal(b.sun.sunset, '2026-10-26T15:41:00.000Z')
  assert.equal(b.trip, null)
  assert.equal(b.verdict.level, 'caution')
  assert.match(b.summary[0].text, /^SW 4 now/)
  assert.equal(b.barometer.label, 'falling fast')
  assert.ok(b.barometer.series.length > 5)
  assert.equal(b.wind.trend.text, 'turned right 17° · 3 kn stronger')
  assert.equal(b.wind.points.length, 7)
  assert.equal(b.battery.soc, 78)
  assert.equal(b.rain.hours.length, 12)
  assert.equal(b.rain.status, 'rain from 13h')
  assert.equal(b.warnings.length, 3)
  assert.ok(b.windToday.length >= 12)

  r = await router.call('put', '/trip', { body: { destination: 'Kühlungsborn', departure: '09:00' } })
  assert.equal(r.status, 200)
  const trip = r.body.trip
  assert.equal(trip.destination, 'Kühlungsborn')
  assert.equal(trip.departure, '2026-10-26T08:00:00.000Z')
  assert.equal(trip.speedKn, 5)
  assert.ok(trip.hours.length >= 7)
  assert.ok(trip.advice.some(a => a.type === 'reef'))
  // forecast was fetched for several points along the route in one request
  const last = mockHttp.calls.filter(u => u.includes('api.open-meteo.com')).pop()
  assert.ok(new URL(last).searchParams.get('latitude').split(',').length >= 5)

  r = await router.call('put', '/trip', { body: { destination: 'Atlantis' } })
  assert.equal(r.status, 400)

  r = await router.call('delete', '/trip')
  r = await router.call('get', '/brief')
  assert.equal(r.body.trip, null)
})
