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
  assert.equal(w.length, 4)
  assert.equal(w[0].state, 'warn')
  const fehmarn = w.find(x => x.label === 'GERMAN NAV WARN 580/26')
  assert.equal(fehmarn.relevance, 'nearby')
  assert.equal(fehmarn.distanceNm, 14.1)
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
  assert.equal(b.trip, undefined, 'the brief is about here only')
  assert.equal(b.verdict.text, 'Sail this morning')
  assert.equal(b.headline.length, 2)
  assert.match(b.headline[0], /^SW 4 now\. A front brings W 5, gusts 7 and rain from about 13h\.$/)
  assert.equal(b.headline[1], 'Back in harbour by 13h, or reef early and pack oilskins.')
  // ribbon 7h..19h with gusts and the front
  assert.equal(b.ribbon.hours.length, 13)
  assert.equal(b.ribbon.hours[0].hour, 7)
  assert.ok(b.ribbon.hours.every(h => h.gustKn >= h.windKn))
  assert.equal(b.ribbon.front, '2026-10-26T12:00:00.000Z')
  assert.ok(b.ribbon.now)
  // attention: own barometer first; route-only and on-board-pressure notifications are left out
  const cards = b.attention.cards
  assert.equal(cards[0].kind, 'barometer')
  assert.equal(cards[0].title, 'Pressure falling fast')
  assert.ok(cards.some(c => c.title === 'Firing or exercise area' && c.detail === 'Western Baltic. Fehmarn. Prohibited Area.'))
  assert.ok(!cards.some(c => /POLISH/.test(c.note)), 'route-only warning stays on the Passage tab')
  assert.ok(!cards.some(c => /On board/.test(c.note)))
  assert.equal(b.status[0].text, 'Battery 78 % · 1d 18h')
  assert.equal(b.wind.trend.text, 'turned right 17° · 3 kn stronger')
  assert.equal(b.barometer.label, 'falling fast')

  // passage: nothing planned yet
  r = await router.call('get', '/passage')
  assert.equal(r.body.trip, null)
  assert.ok(r.body.destinations.some(d => d.name === 'Kühlungsborn'))

  // pick a harbour
  r = await router.call('put', '/trip', { body: { destination: 'Kühlungsborn', departure: '09:00' } })
  assert.equal(r.status, 200)
  let trip = r.body.trip
  assert.equal(trip.name, 'Kühlungsborn')
  assert.equal(trip.departure, '2026-10-26T08:00:00.000Z')
  assert.equal(trip.speedKn, 5)
  assert.equal(trip.verdict.text, 'Reef before 12h')
  assert.equal(trip.front.text, 'front at 13h, 20 nm out')
  assert.ok(trip.advice.some(a => a.type === 'rain'))
  assert.equal(trip.departureAdvice.better.day, 'tomorrow')
  assert.equal(trip.departureAdvice.better.departure, '2026-10-27T08:00:00.000Z', 'same time of day, tomorrow')
  assert.match(trip.departureAdvice.better.reason, /no reefing weather, dry/)
  // forecast fetched for several points along the route in one request
  const last = mockHttp.calls.filter(u => u.includes('api.open-meteo.com')).pop()
  assert.ok(new URL(last).searchParams.get('latitude').split(',').length >= 5)

  // change speed only: keeps route and departure
  r = await router.call('put', '/trip', { body: { speedKn: 6 } })
  assert.equal(r.body.trip.speedKn, 6)
  assert.equal(r.body.trip.departure, '2026-10-26T08:00:00.000Z')
  assert.ok(r.body.trip.durationH < trip.durationH)

  // waypoints tapped on the chart: from the boat, named after the nearest harbour or the position
  r = await router.call('put', '/trip', { body: { waypoints: [{ latitude: 54.395, longitude: 11.12 }, { latitude: 54.414, longitude: 11.197 }] } })
  trip = r.body.trip
  assert.equal(trip.name, 'Burgstaaken (Fehmarn)')
  assert.equal(trip.route.length, 3)
  assert.equal(r.body.waypoints.length, 2)
  r = await router.call('put', '/trip', { body: { waypoints: [{ latitude: 54.5, longitude: 11.5 }] } })
  assert.equal(r.body.trip.name, '54°30′N 11°30′E')

  r = await router.call('put', '/trip', { body: { destination: 'Atlantis' } })
  assert.equal(r.status, 400)

  r = await router.call('delete', '/trip')
  assert.equal(r.body.trip, null)
})
