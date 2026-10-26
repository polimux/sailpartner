'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { Barometer } = require('../lib/barometer')
const { assess } = require('../lib/relevance')
const { Store } = require('../lib/store')
const sjo = require('../lib/sources/sjofartsverket')
const sk = require('../lib/signalk')

const NOW = new Date('2026-10-26T08:00:00Z')
const HEILIGENHAFEN = { latitude: 54.373, longitude: 11.004 }
// Heiligenhafen -> Fehmarnsund -> Kühlungsborn
const ROUTE = [HEILIGENHAFEN, { latitude: 54.40, longitude: 11.13 }, { latitude: 54.39, longitude: 11.45 }, { latitude: 54.16, longitude: 11.76 }]
const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'sjofartsverket-navtex.html'), 'utf8')
const warnings = () => sjo.parsePage(html, { url: 'x', channel: 'NAVTEX' }, NOW)

test('barometer: 3-hour tendency and classes', () => {
  const t0 = NOW.getTime() - 3 * 3600e3
  const b = new Barometer()
  // falls 3.1 hPa over 3 h
  for (let i = 0; i <= 36; i++) b.add(101190 - i * (310 / 36), t0 + i * 5 * 60e3)
  const c = b.classify(NOW.getTime())
  assert.equal(c.change3h, -3.1)
  assert.equal(c.label, 'falling fast')
  assert.equal(c.severity, 'warn')
  const w = b.toWarning(HEILIGENHAFEN, NOW.getTime())
  assert.equal(w.title, 'Pressure falling fast')
  assert.match(w.text, /-3.1 hPa in 3 h/)

  const steady = new Barometer()
  for (let i = 0; i <= 36; i++) steady.add(101300 + (i % 2) * 20, t0 + i * 5 * 60e3)
  assert.equal(steady.classify(NOW.getTime()).label, 'steady')
  assert.equal(steady.toWarning(HEILIGENHAFEN, NOW.getTime()), null)

  const young = new Barometer()
  young.add(101300, NOW.getTime() - 3600e3)
  young.add(101000, NOW.getTime())
  assert.equal(young.classify(NOW.getTime()), null, 'needs 2.5 h of history')
})

test('relevance for a boat in Heiligenhafen with a route to Kühlungsborn', () => {
  const byId = Object.fromEntries(warnings().map(w => [w.id, assess(w, { position: HEILIGENHAFEN, route: ROUTE, radiusNm: 30, corridorNm: 5 })]))

  // Fehmarn prohibited-area buoy (NE of Fehmarn): ~14 nm away, but the route
  // through Fehmarnsund passes ~8 nm south of it -> nearby, not on route
  const f = byId['german-580-26']
  assert.ok(f.distanceNm > 10 && f.distanceNm < 15, `fehmarn ${f.distanceNm}`)
  assert.ok(f.routeDistanceNm > 5 && f.routeDistanceNm < 10, `route ${f.routeDistanceNm}`)
  assert.equal(f.relevance, 'nearby')

  // Going round the north of Fehmarn instead puts it on the route
  const north = [HEILIGENHAFEN, { latitude: 54.48, longitude: 11.05 }, { latitude: 54.55, longitude: 11.25 }, { latitude: 54.5, longitude: 11.45 }]
  const fn = assess(warnings().find(w => w.id === 'german-580-26'), { position: HEILIGENHAFEN, route: north })
  assert.equal(fn.relevance, 'route')
  assert.ok(fn.routeDistanceNm < 2)

  // GNSS interference listed for Western Baltic, no coordinates -> your sea area
  const g = byId['baltic-sea-30-26']
  assert.equal(g.areaOnly, true)
  assert.equal(g.distanceNm, 0)
  assert.equal(g.relevance, 'here')

  // Darsser Ort light: ~55 nm away, not near route
  assert.equal(byId['german-592-26'].relevance, 'far')
  // Kaliningrad exercise area: far
  assert.equal(byId['kaliningrad-224-26'].relevance, 'far')
})

test('store merges sources, retires withdrawn and cancelled warnings', () => {
  const s = new Store(null)
  const list = warnings()
  s.update('sjofartsverket', list, NOW)
  assert.equal(s.list().length, 10)

  // a second source reporting the same warning merges into one
  const dup = { ...list.find(w => w.id === 'german-580-26'), areas: ['THE BELTS'] }
  s.update('other', [dup], NOW)
  const merged = s.state.warnings['german-580-26']
  assert.deepEqual(merged.sources, ['sjofartsverket', 'other'])
  assert.ok(merged.areas.includes('THE BELTS') && merged.areas.includes('WESTERN BALTIC'))

  // warning disappears from the primary source but other still has it -> stays
  s.update('sjofartsverket', list.filter(w => w.id !== 'german-580-26'), NOW)
  assert.ok(s.state.warnings['german-580-26'])
  // gone from both -> history
  s.update('other', [], NOW)
  assert.equal(s.state.warnings['german-580-26'], undefined)
  assert.equal(s.state.history['german-580-26'].removedReason, 'withdrawn')

  // explicit cancellation: a new warning cancels DANISH 417/26
  const cancel = { ...list.find(w => w.id === 'danish-417-26'), id: 'danish-430-26', number: '430/26', label: 'DANISH NAV WARN 430/26', cancels: ['417/26'] }
  s.update('sjofartsverket', list.filter(w => w.id !== 'german-580-26').concat([cancel]), NOW)
  assert.equal(s.state.warnings['danish-417-26'], undefined)
  assert.match(s.state.history['danish-417-26'].removedReason, /cancelled by DANISH NAV WARN 430\/26/)
})

test('signal k conversions', () => {
  const ws = warnings().map(w => assess({ ...w, sources: ['sjofartsverket'] }, { position: HEILIGENHAFEN, route: ROUTE }))
  const f = ws.find(w => w.id === 'german-580-26')
  assert.equal(sk.notificationPath(f), 'notifications.navigation.warnings.german_580_26')
  const v = sk.notificationValue(f)
  assert.equal(v.state, 'warn')
  assert.match(v.message, /^GERMAN NAV WARN 580\/26: WESTERN BALTIC\.FEHMARN\. PROHIBITED AREA\. \(\d+(\.\d)? nm\)$/)

  const note = sk.toNote(f)
  assert.equal(note.position.latitude, 54.525)
  const region = sk.toRegion(ws.find(w => w.id === 'kaliningrad-224-26'))
  assert.equal(region.feature.geometry.coordinates[0].length, 5, 'closed ring')
  const circle = sk.toRegion(ws.find(w => w.id === 'petersburg-121-26'))
  assert.equal(circle.feature.geometry.coordinates[0].length, 25)

  assert.match(sk.uuidFor('german-580-26'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(sk.uuidFor('a'), sk.uuidFor('a'))
})
