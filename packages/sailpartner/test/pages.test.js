'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Feed, describeSource } = require('../lib/feed')
const { Logbook } = require('../lib/logbook')
const { History } = require('../lib/history')
const { weatherPage } = require('../lib/weather')
const { parseForecast, mergeWaves } = require('../lib/openmeteo')
const { forecastFor, marineFor, mockHttp } = require('./scenario')
const { mockApp, mockRouter } = require('./mockserver')
const createPlugin = require('..')

const TZ = 'Europe/Berlin'

test('feed: sources, rows per path and source, log and rates', () => {
  let t = 1_000_000
  const f = new Feed({ now: () => t, logSize: 5 })
  assert.deepEqual(describeSource({ label: 'can0', type: 'NMEA2000', pgn: 130306, src: '115' }, 'can0.115'),
    { type: 'NMEA 2000', code: 'PGN 130306', name: 'Wind data', label: 'can0', device: 'src 115', id: 'can0.115' })
  assert.equal(describeSource({ label: 'ttyUSB0', type: 'NMEA0183', talker: 'GP', sentence: 'RMC' }, 'ttyUSB0.GP').code, 'GPRMC')
  assert.equal(describeSource({ label: 'victron-ble', type: 'plugin' }, 'victron-ble').type, 'plugin')

  for (let i = 0; i < 10; i++) {
    t += 1000
    f.onDelta({ path: 'environment.wind.speedApparent', value: 7, source: { label: 'can0', type: 'NMEA2000', pgn: 130306, src: '115' }, $source: 'can0.115' })
    f.onDelta({ path: 'navigation.position', value: { latitude: 54.37, longitude: 11.0 }, source: { label: 'can0', type: 'NMEA2000', pgn: 129025, src: '3' }, $source: 'can0.3' })
  }
  f.onDelta({ path: 'navigation.position', value: { latitude: 54.37, longitude: 11.0 }, source: { label: 'ttyUSB0', type: 'NMEA0183', talker: 'GP', sentence: 'RMC' }, $source: 'ttyUSB0.GP' })
  f.onDelta({ path: '', value: 1 }) // ignored
  t += 2000
  const s = f.snapshot()
  assert.equal(s.paths.length, 3, 'position from two sources = two rows')
  const wind = s.paths.find(r => r.path === 'environment.wind.speedApparent')
  assert.equal(wind.count, 10)
  assert.equal(wind.ageMs, 2000)
  assert.ok(wind.perMin > 40 && wind.perMin < 60)
  assert.equal(s.log.length, 5, 'log is capped')
  assert.equal(s.sources[0].name, 'can0 src 115')
  assert.equal(s.updatesPerSec, 1.9)
  assert.equal(f.snapshot({ logSince: s.seq }).log.length, 0)
})

test('logbook: entries, events, hourly, season, csv', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-'))
  const lb = new Logbook(dir)
  const snap = { position: { latitude: 54.3735123, longitude: 11.0051 }, cog: 61.7, sog: 5.44, tws: 12.26, twd: 226.4, pressureHPa: 1016.33 }
  const t0 = Date.parse('2026-10-25T08:00:00Z')
  lb.tick({ t: t0, day: '2026-10-25', boatState: 'moored', snapshot: snap, placeName: 'Heiligenhafen' })
  assert.equal(lb.entries('2026-10-25').length, 0, 'first state seen: no event')
  lb.tick({ t: t0 + 60e3, day: '2026-10-25', boatState: 'underway', snapshot: snap })
  lb.tick({ t: t0 + 30 * 60e3, day: '2026-10-25', boatState: 'underway', snapshot: snap })
  lb.tick({ t: t0 + 61 * 60e3, day: '2026-10-25', boatState: 'underway', snapshot: snap })
  lb.add('2026-10-25', { t: t0 + 90 * 60e3, kind: 'manual', text: 'Reefed, "first" reef', snapshot: snap })
  lb.tick({ t: t0 + 120 * 60e3, day: '2026-10-25', boatState: 'moored', snapshot: snap, placeName: 'Burgstaaken' })
  const e = lb.entries('2026-10-25')
  assert.deepEqual(e.map(x => [x.kind, x.text]), [['event', 'Cast off'], ['auto', ''], ['manual', 'Reefed, "first" reef'], ['event', 'Moored · Burgstaaken']])
  assert.deepEqual(e[0].position, { latitude: 54.37351, longitude: 11.0051 })
  assert.equal(e[0].sog, 5.4)
  assert.equal(e[0].pressure, 1016.3)

  // persisted, reloadable
  const again = new Logbook(dir)
  assert.equal(again.entries('2026-10-25').length, 4)
  assert.deepEqual(again.days(), ['2026-10-25'])
  assert.equal(again.remove('2026-10-25', e[1].t), false, 'automatic entries stay')
  assert.equal(again.remove('2026-10-25', e[2].t), true)

  const csv = lb.csv('2026-10-25').split('\n')
  assert.equal(csv[0], 'time,latitude,longitude,cog,sog_kn,heading,wind_kn,wind_dir,pressure_hpa,kind,entry')
  assert.match(csv[3], /"Reefed, ""first"" reef"$/)

  lb.setDayTotals('2026-10-25', { distanceNm: 34.2, underwayH: 6.8, maxSog: 7.3 })
  lb.setDayTotals('2026-07-30', { distanceNm: 41.5, underwayH: 8, maxSog: 7 })
  lb.setDayTotals('2026-07-31', { distanceNm: 0, underwayH: 0, maxSog: 0 })
  lb.setDayTotals('2025-08-01', { distanceNm: 20, underwayH: 4, maxSog: 6 })
  assert.deepEqual(lb.season('2026'), { year: '2026', distanceNm: 75.7, underwayH: 14.8, daysUnderway: 2, daysAboard: 3, longest: { day: '2026-07-30', distanceNm: 41.5 } })
})

test('battery history: Ah per day and the 7-day curve', () => {
  const h = new History()
  const t0 = Date.parse('2026-10-25T00:00:00Z')
  // 2 h charging at 10 A, then 4 h using 5 A
  for (let m = 0; m <= 360; m++) {
    const a = m < 120 ? 10 : -5
    h.sample({ battery: { soc: 60 + Math.min(m, 120) / 12 - Math.max(0, m - 120) / 24, voltage: 12.6, current: a } }, t0 + m * 60e3, '2026-10-25')
  }
  const d = h.batteryDay('2026-10-25')
  assert.equal(d.chargedAh, 20)
  assert.equal(d.usedAh, 20)
  assert.equal(d.minSoc, 60)
  assert.equal(d.maxSoc, 70)
  const s = h.batterySeries(t0 + 361 * 60e3)
  assert.ok(s.length >= 36)
  assert.ok(s.every((p, i) => i === 0 || Date.parse(p.t) > Date.parse(s[i - 1].t)))
  const back = new History(JSON.parse(JSON.stringify(h.toJSON())))
  assert.equal(back.batteryDay('2026-10-25').chargedAh, 20)
})

test('weather page: 48 hours, day summaries, pressure low', () => {
  const fc = mergeWaves(parseForecast(forecastFor(54.37, 11.0)), marineFor(54.37, 11.0))
  const now = Date.parse('2026-10-26T07:56:00Z')
  const w = weatherPage({ forecast: fc, now, tz: TZ, thresholds: { reefWindKn: 18, reefGustKn: 24, strongGustKn: 28, stayWindKn: 25, stayGustKn: 32 } })
  assert.equal(w.hours.length, 48)
  assert.equal(w.hours[0].time, '2026-10-26T07:00:00.000Z')
  assert.equal(w.hours[0].hour, 8)
  assert.deepEqual(w.days.map(d => d.label), ['Today', 'Tomorrow', 'Wednesday'])
  assert.equal(w.days[0].level, 'red')
  assert.equal(w.days[1].level, 'green')
  assert.equal(w.days[1].windFrom, 'W')
  assert.equal(w.days[1].rainMm, 0)
  assert.ok(w.days[2].rainMm > 4)
  assert.equal(w.pressure.low.t, '2026-10-26T16:00:00.000Z')
  assert.equal(w.pressure.low.hPa, 1005)
})

test('plugin: data, weather, battery and logbook endpoints', async (t) => {
  const app = mockApp()
  const now = Date.parse('2026-10-26T07:56:00Z')
  const plugin = createPlugin(app, { http: mockHttp, now: () => now })
  t.after(() => plugin.stop())
  const router = mockRouter()
  plugin.registerWithRouter(router)
  plugin.start({})

  app.emit('environment.wind.speedApparent', 7.2, { label: 'can0', type: 'NMEA2000', pgn: 130306, src: '115' }, 'can0.115')
  app.emit('navigation.position', { latitude: 54.3733, longitude: 11.0052 }, { label: 'can0', type: 'NMEA2000', pgn: 129025, src: '3' }, 'can0.3')
  let r = await router.call('get', '/data')
  assert.equal(r.body.paths.length, 2)
  assert.equal(r.body.paths.find(p => p.path === 'environment.wind.speedApparent').source.name, 'Wind data')

  r = await router.call('get', '/weather')
  assert.equal(r.body.place, 'Heiligenhafen')
  assert.equal(r.body.hours.length, 48)
  assert.equal(r.body.days.length, 3)

  plugin._internals.tick()
  r = await router.call('get', '/battery')
  assert.equal(r.body.live.soc, 78)
  assert.equal(r.body.days.length, 7)
  assert.equal(r.body.days[6].label, 'Today')

  r = await router.call('post', '/logbook', { body: { text: 'Reefed' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.day, '2026-10-26')
  assert.equal(r.body.entries[0].text, 'Reefed')
  assert.equal(r.body.entries[0].kind, 'manual')
  r = await router.call('post', '/logbook', { body: { text: '  ' } })
  assert.equal(r.status, 400)
  r = await router.call('get', '/logbook/export', { query: { day: '2026-10-26' } })
  assert.match(r.body, /,manual,Reefed\n$/)
  assert.match(r.headers['Content-Disposition'], /logbook-2026-10-26\.csv/)
  const entry = (await router.call('get', '/logbook')).body.entries[0]
  r = await router.call('delete', '/logbook', { query: { day: '2026-10-26', t: entry.t } })
  assert.equal(r.body.entries.length, 0)
})
