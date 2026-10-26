'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseForecast, mergeWaves } = require('../lib/openmeteo')
const { timeline, distanceNm } = require('../lib/route')
const { routeWeather, tripAdvice, pointOfSail, windLevel } = require('../lib/routeweather')
const { verdict, summary } = require('../lib/brief')
const { History } = require('../lib/history')
const { beaufort, compass8 } = require('../lib/units')
const T = require('../lib/time')
const DEST = require('../lib/destinations')
const { forecastFor, marineFor } = require('./scenario')

const TZ = 'Europe/Berlin'
const fmt = (iso, bare) => T.hourLabel(iso, TZ, bare)
const HH = DEST.home
const KB = DEST.list.find(d => d.name === 'Kühlungsborn')
const fc = mergeWaves(parseForecast(forecastFor(54.37, 11.0)), marineFor(54.37, 11.0))

test('units', () => {
  assert.equal(beaufort(12), 4)
  assert.equal(beaufort(21), 5)
  assert.equal(beaufort(22), 6)
  assert.equal(compass8(228), 'SW')
  assert.equal(compass8(270), 'W')
})

test('time zone helpers', () => {
  assert.equal(T.hourLabel('2026-10-26T08:00:00Z', TZ), '9h') // CET after DST ended on 25 Oct
  assert.equal(T.hourLabel('2026-07-01T08:00:00Z', TZ), '10h') // CEST
  assert.equal(T.localToDate('2026-10-26', 9, 0, TZ).toISOString(), '2026-10-26T08:00:00.000Z')
  assert.equal(T.dayKey('2026-10-25T23:30:00Z', TZ), '2026-10-26')
})

test('Open-Meteo parsing and waves', () => {
  assert.equal(fc.hours.length, 72)
  const h = fc.hours.find(x => x.time === '2026-10-26T14:00:00.000Z') // 15h local
  assert.equal(h.windDir, 270)
  assert.equal(h.rainMm, 2.8)
  assert.ok(h.waveM > 0.9)
  assert.equal(fc.sunset[0], '2026-10-26T15:41:00.000Z')
})

test('route timeline at 5 kn', () => {
  const pts = [HH, ...KB.via, KB]
  const tl = timeline(pts, '2026-10-26T08:00:00Z', 5)
  assert.ok(tl.totalNm > 30 && tl.totalNm < 45, `distance ${tl.totalNm}`)
  const last = tl.hours[tl.hours.length - 1]
  assert.equal(last.arrival, true)
  assert.ok(distanceNm(last.position, KB) < 0.01)
  assert.equal(tl.hours[1].distanceNm, 5)
  // second hour is through Fehmarnsund heading roughly east
  assert.ok(tl.hours[2].course > 60 && tl.hours[2].course < 120, `course ${tl.hours[2].course}`)
})

test('points of sail and wind levels', () => {
  assert.equal(pointOfSail(30), 'beat')
  assert.equal(pointOfSail(-60), 'close reach')
  assert.equal(pointOfSail(90), 'beam reach')
  assert.equal(pointOfSail(140), 'broad reach')
  assert.equal(pointOfSail(-175), 'run')
  assert.equal(windLevel(12, 16), 'green')
  assert.equal(windLevel(16, 22), 'green')
  assert.equal(windLevel(18, 22), 'amber')
  assert.equal(windLevel(15, 24), 'amber')
  assert.equal(windLevel(20, 28), 'red')
})

test('weather along the route to Kühlungsborn', () => {
  const trip = { destination: 'Kühlungsborn', points: [HH, ...KB.via, KB], departure: '2026-10-26T08:00:00Z', speedKn: 5 }
  const rw = routeWeather(trip, () => fc, { sunsetFor: () => fc.sunset[0] })
  assert.equal(fmt(rw.hours[0].time), '9h')
  const at15 = rw.hours.find(h => fmt(h.time) === '15h')
  assert.equal(at15.windFrom, 'W')
  assert.equal(at15.pointOfSail, 'broad reach') // last leg heads SE, westerly wind on the quarter
  assert.equal(at15.rainLevel, 3)
  assert.equal(at15.level, 'red')
  assert.equal(rw.hours[0].level, 'green')
  assert.ok(rw.sunsetMarginMin !== null)

  const advice = tripAdvice(rw, fmt)
  const types = advice.map(a => a.type)
  assert.ok(types.includes('reef'))
  assert.ok(types.includes('rain'))
  assert.equal(advice.find(a => a.type === 'sea').text, 'following sea 1.1 m')
  assert.ok(!types.includes('preventer'), 'no dead run in this scenario')
  assert.match(advice.find(a => a.type === 'reef').text, /^reef before \d+h$/)
})

test('verdict and written summary', () => {
  const now = Date.parse('2026-10-26T07:00:00Z')
  const hours = fc.hours.filter(h => Date.parse(h.time) >= now && Date.parse(h.time) < Date.parse('2026-10-26T16:00:00Z'))
  const baro = { label: 'falling fast', severity: 'warn', change3h: -3.1 }
  const v = verdict({ hours, barometer: baro, fmt, now })
  assert.equal(v.level, 'caution')
  assert.match(v.text, /^Reef before \d+h$/)

  const lines = summary({ hours, barometer: baro, verdict: v, fmt })
  const text = lines.map(l => l.text)
  assert.match(text[0], /^SW 4 now, increasing W [56], gusts [67] from about \d+h\.$/)
  assert.match(text[1], /^Heavy rain 1[34]–1[78]h/)
  assert.equal(text[2], 'Pressure falling fast.')
  assert.match(text[3], /^Fine until \d+h\. Reef early, pack oilskins\.$/)
  assert.equal(lines[3].emphasis, true)

  // stay in on a gale
  const gale = hours.map(h => ({ ...h, windKn: 28, gustKn: 38 }))
  assert.equal(verdict({ hours: gale, fmt, now }).text, 'Stay in')
  // calm
  const calm = hours.map(h => ({ ...h, windKn: 9, gustKn: 12, rainMm: 0 }))
  const vc = verdict({ hours: calm, fmt, now })
  assert.equal(vc.text, 'Good sailing')
  assert.equal(summary({ hours: calm, verdict: vc, fmt }).slice(-1)[0].text, 'Fine sailing day.')
})

test('history: gusts, wind trend, barometer, distance', () => {
  const h = new History()
  const t0 = Date.parse('2026-10-26T05:00:00Z')
  // 3 h: wind veers 213 -> 228 and builds 11 -> 14 kn, pressure falls 3.3 hPa
  for (let s = 0; s <= 3 * 3600; s += 20) {
    const f = s / (3 * 3600)
    h.sample({ tws: 11 + 3 * f + (s % 300 === 0 ? 4 : 0), twd: 213 + 15 * f, pressureHPa: 1012.1 - 3.3 * f }, t0 + s * 1000, '2026-10-26')
  }
  const now = t0 + 3 * 3600e3
  const wh = h.windHistory(now)
  assert.equal(wh.points.length, 7)
  assert.ok(wh.trend.veerDeg >= 12 && wh.trend.veerDeg <= 16, `veer ${wh.trend.veerDeg}`)
  assert.match(wh.trend.text, /^turned right 1\d° · 3 kn stronger$/)
  assert.ok(h.gust(10, now) >= 17)
  const b = h.barometer(now)
  assert.equal(b.label, 'falling fast')
  assert.equal(b.severity, 'warn')
  assert.ok(h.pressureSeries(24, now).length >= 6)

  // distance: 1 hour at 5 kn heading north
  const d = new History()
  const start = { latitude: 54.3, longitude: 11.0 }
  for (let m = 0; m <= 60; m++) {
    d.sample({ sog: 5, position: { latitude: start.latitude + (5 / 60) * (m / 60), longitude: 11.0 } }, t0 + m * 60e3, '2026-10-25')
  }
  const day = d.day('2026-10-25')
  assert.ok(Math.abs(day.distanceNm - 5) < 0.1, `distance ${day.distanceNm}`)
  assert.ok(Math.abs(day.underwayH - 1) < 0.05)
})

test('front detection, local verdict and headline', () => {
  const L = require('../lib/local')
  const now = Date.parse('2026-10-26T07:56:00Z')
  const day = { key: '2026-10-26', isToday: true }
  const hours = fc.hours.filter(h => Date.parse(h.time) >= Date.parse('2026-10-26T07:00:00Z') && Date.parse(h.time) <= Date.parse('2026-10-26T15:41:00Z'))
  const front = L.detectFront(hours)
  assert.equal(front.time, '2026-10-26T12:00:00.000Z')
  assert.equal(front.turnDeg, 45)
  const v = L.localVerdict({ hours, warnings: [], barometer: null, fmt, now, day, tz: TZ })
  assert.equal(v.text, 'Sail this morning')
  const h = L.headline({ hours, verdict: v, front, fmt, day, now })
  assert.equal(h[0], 'SW 4 now. A front brings W 5, gusts 7 and rain from about 13h.')
  assert.equal(h[1], 'Back in harbour by 13h, or reef early and pack oilskins.')

  // a quiet day: no front, steady wind
  const calm = hours.map(x => ({ ...x, windKn: 10, gustKn: 13, windDir: 250, rainMm: 0 }))
  assert.equal(L.detectFront(calm), null)
  const vc = L.localVerdict({ hours: calm, warnings: [], fmt, now, day, tz: TZ })
  assert.equal(vc.text, 'Good sailing')
  assert.deepEqual(L.headline({ hours: calm, verdict: vc, front: null, fmt, day, now }), ['W 3 now, steady all day. Dry.', 'Fine sailing day.'])

  // evening: the brief looks at tomorrow
  const tomorrow = { key: '2026-10-27', isToday: false }
  const vt = L.localVerdict({ hours: calm, warnings: [], fmt, now, day: tomorrow, tz: TZ })
  assert.equal(vt.text, 'Tomorrow: good sailing')
})

test('attention cards and status line', () => {
  const L = require('../lib/local')
  const a = L.attention({
    barometer: { label: 'falling fast', severity: 'warn', change3h: -3.1, current: 1008.8 },
    pressure3h: [],
    battery: { soc: 45, voltage: 12.1, current: -4 },
    warnings: [
      { path: 'x.a', state: 'alert', category: 'gnss', title: 'GNSS INTERFERENCE', label: 'BALTIC SEA NAV WARN 30/26', relevance: 'here', distanceNm: 0, areaOnly: true },
      { path: 'x.b', state: 'warn', category: 'exercise', title: 'SOUTHERN BALTIC. POLISH COAST', label: 'POLISH NAV WARN 276/26', relevance: 'route', distanceNm: 120 },
      { path: 'x.c', state: 'warn', category: 'waterlevel', title: 'LOW SEA LEVEL', detail: 'WESTERN BALTIC: AROUND -60 TO -70 CM BELOW CHART DATUM.', label: 'BALTIC SEA NAV WARN 32/26', relevance: 'nearby', distanceNm: 13.6 }
    ]
  })
  assert.deepEqual(a.cards.map(c => c.kind), ['barometer', 'battery', 'warning'])
  assert.equal(a.cards[1].title, 'Battery low')
  assert.equal(a.cards[2].title, 'Water level warning')
  assert.equal(a.cards[2].detail, 'Low Sea Level: Western Baltic: Around -60 to -70 cm Below Chart Datum.')
  assert.equal(a.cards[2].note, 'BALTIC SEA NAV WARN 32/26 · 14 nm away')
  assert.equal(a.more, 1, 'GNSS card left out, Polish warning is route-only')
  assert.equal(L.smartCase('WESTERN BALTIC.FEHMARN. PROHIBITED AREA.'), 'Western Baltic. Fehmarn. Prohibited Area.')

  const st = L.status({ battery: { soc: 78, timeRemainingS: 151200 }, wind: { tws: 14.1, twd: 230, gust10: 18 }, cabin: { temp: 14.2, humidity: 90 } })
  assert.deepEqual(st.map(s => s.text), ['Battery 78 % · 1d 18h', 'Wind now SW 14 kn · gust 18', 'Cabin 14 °C · 90 %'])
  assert.equal(st[2].level, 'amber', 'damp cabin')
})

test('better departure search', () => {
  const { bestDeparture, scoreTrip } = require('../lib/passage')
  const { routeWeather } = require('../lib/routeweather')
  const sunFor = iso => { const i = fc.sunset.findIndex(s => s.slice(0, 10) === new Date(iso).toISOString().slice(0, 10)); return i >= 0 ? { sunrise: fc.sunrise[i], sunset: fc.sunset[i] } : null }
  const trip = { points: [HH, ...KB.via, KB], departure: '2026-10-26T08:00:00Z', speedKn: 5 }
  const rw = routeWeather(trip, () => fc, { sunsetFor: iso => sunFor(iso).sunset })
  const s = scoreTrip(rw, sunFor(trip.departure).sunrise)
  assert.equal(s.strongHours, 3)
  assert.equal(s.rainyHours, 3)
  const r = bestDeparture({ trip, forecastFor: () => fc, sunFor, now: Date.parse('2026-10-26T07:56:00Z'), tz: TZ })
  assert.equal(r.better.departure, '2026-10-27T08:00:00.000Z')
  assert.equal(r.better.reason, 'no reefing weather, dry')
  // already the best: no suggestion
  const r2 = bestDeparture({ trip: { ...trip, departure: '2026-10-27T08:00:00Z' }, forecastFor: () => fc, sunFor, now: Date.parse('2026-10-26T07:56:00Z'), tz: TZ })
  assert.equal(r2.better, null)
})
