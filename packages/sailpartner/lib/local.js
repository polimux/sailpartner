'use strict'

// The Brief: everything about "here", for today (or tomorrow once it's evening).
//   - which day and hours matter
//   - front detection
//   - verdict wording and the two-sentence headline
//   - the day ribbon (one bar per hour, mean wind + gusts)
//   - attention cards (only what needs you) and the quiet status line

const { beaufort, compass8, norm180 } = require('./units')
const { verdict, bftRange } = require('./brief')
const { at } = require('./openmeteo')
const { rainLevel, windLevel } = require('./routeweather')
const T = require('./time')

const RIBBON_FROM = 7
const RIBBON_TO = 19
const EVENING = 18 // from this local hour the brief looks at tomorrow

// Which day the brief is about, and its daylight.
function briefDay (now, tz, sunFor) {
  const local = T.parts(now, tz)
  const today = T.dayKey(now, tz)
  const isToday = local.h < EVENING
  const key = isToday ? today : T.addDays(today, 1)
  const sun = sunFor(T.localToDate(key, 12, 0, tz).toISOString())
  return { key, isToday, sun }
}

// Hours from now (or the morning, for tomorrow) until sunset.
function periodHours (forecast, now, day, tz) {
  if (!forecast) return []
  const morning = T.localToDate(day.key, RIBBON_FROM, 0, tz).getTime()
  const from = day.isToday ? Math.floor(now / 3600e3) * 3600e3 : morning
  const sunset = day.sun ? Date.parse(day.sun.sunset) : T.localToDate(day.key, RIBBON_TO, 0, tz).getTime()
  const to = Math.max(sunset, from + 6 * 3600e3)
  return forecast.hours.filter(h => Date.parse(h.time) >= from && Date.parse(h.time) <= to)
}

// A front: the wind turns by 35° or more within two hours, together with more wind or rain.
function detectFront (hours) {
  for (let i = 0; i + 2 < hours.length; i++) {
    const a = hours[i]; const b = hours[i + 2]
    if (typeof a.windDir !== 'number' || typeof b.windDir !== 'number') continue
    const turn = Math.abs(norm180(b.windDir - a.windDir))
    if (turn < 35) continue
    const moreWind = (b.windKn || 0) - (a.windKn || 0) >= 2
    const rain = hours.slice(i, i + 4).some(h => (h.rainMm || 0) >= 1)
    if (moreWind || rain) return { time: hours[i + 1].time, turnDeg: Math.round(norm180(b.windDir - a.windDir)) }
  }
  return null
}

function localVerdict ({ hours, warnings, barometer, thresholds, fmt, now, day, tz }) {
  if (!hours.length) return null
  const v = verdict({ hours, warnings, barometer, thresholds, fmt, now })
  if (v.level === 'caution' && v.firstBad) {
    const goodHours = (Date.parse(v.firstBad) - Math.max(now, Date.parse(hours[0].time))) / 3600e3
    if (goodHours >= 2) {
      const h = T.parts(v.firstBad, tz).h
      if (h <= 13) v.text = day.isToday ? 'Sail this morning' : 'Sail tomorrow morning'
      else v.text = day.isToday ? `Sail until ${fmt(v.firstBad)}` : `Tomorrow: sail until ${fmt(v.firstBad)}`
    } else if (!day.isToday) {
      v.text = 'Tomorrow: reef early'
    }
  } else if (!day.isToday && v.level !== 'stay') {
    v.text = `Tomorrow: ${v.text.toLowerCase()}`
  } else if (!day.isToday && v.level === 'stay') {
    v.text = 'Tomorrow: stay in'
  }
  return v
}

// Two sentences: what the wind does, and what to do about it.
function headline ({ hours, verdict: v, front, fmt, day, now }) {
  const valid = hours.filter(h => typeof h.windKn === 'number')
  if (!valid.length) return []
  const first = valid.slice(0, 2)
  const dir = compass8(first[first.length - 1].windDir)
  const startB = bftRange(first.map(h => h.windKn))
  const subject = day.isToday ? `${dir} ${startB} now` : `Tomorrow ${dir} ${startB} in the morning`
  const rainy = valid.filter(h => (h.rainMm || 0) >= 0.5)
  let line1

  if (front && Date.parse(front.time) > now) {
    const after = valid.filter(h => Date.parse(h.time) >= Date.parse(front.time))
    const nextDir = compass8((after[1] || after[0]).windDir)
    const range = bftRange(after.map(h => h.windKn))
    const gustB = beaufort(Math.max(...after.map(h => h.gustKn || h.windKn)))
    const withRain = after.slice(0, 4).some(h => (h.rainMm || 0) >= 0.5)
    const gusts = gustB > Math.max(...after.map(h => beaufort(h.windKn))) ? `, gusts ${gustB}` : ''
    line1 = `${subject}. A front brings ${nextDir} ${range}${gusts}${withRain ? ' and rain' : ''} from about ${fmt(front.time)}.`
  } else {
    const startMax = Math.max(...first.map(h => beaufort(h.windKn)))
    const peak = valid.reduce((a, h) => (h.windKn > a.windKn ? h : a), valid[0])
    const last = valid[valid.length - 1]
    let change
    if (beaufort(peak.windKn) > startMax) {
      const from = valid.find(h => beaufort(h.windKn) > startMax)
      change = `, increasing ${beaufort(peak.windKn)} from about ${fmt(from.time)}`
    } else if (beaufort(last.windKn) < startMax - 1) {
      change = `, easing to ${beaufort(last.windKn)} later`
    } else {
      change = ', steady all day'
    }
    const rain = rainy.length ? ` Rain from about ${fmt(rainy[0].time)}.` : ' Dry.'
    line1 = `${subject}${change}.${rain}`
  }

  const oil = rainy.length ? ' and pack oilskins' : ''
  let line2
  if (!v) line2 = ''
  else if (v.level === 'stay') line2 = `${v.reasons[0] ? v.reasons[0].replace(/^./, c => c.toUpperCase()) + ' — b' : 'B'}etter stay in harbour${day.isToday ? ' today' : ''}.`
  else if (v.level === 'caution' && v.firstBad) {
    const good = (Date.parse(v.firstBad) - Math.max(now, Date.parse(valid[0].time))) / 3600e3
    line2 = good >= 2 ? `Back in harbour by ${fmt(v.firstBad)}, or reef early${oil}.` : `Reef before you leave${oil}.`
  } else if (v.level === 'caution' && /barometer/i.test(v.text)) line2 = 'Pressure is dropping fast — keep an eye on the sky.'
  else if (v.level === 'caution') line2 = `Check the warnings before you go${oil}.`
  else if (/light/i.test(v.text)) line2 = 'Light winds, maybe motor-sailing.'
  else line2 = rainy.length ? 'Good sailing, pack oilskins.' : 'Fine sailing day.'

  return [line1, line2].filter(Boolean)
}

// One entry per hour 7h–19h of the brief day.
function ribbon ({ forecast, now, day, tz, thresholds }) {
  if (!forecast) return null
  const hours = []
  for (let h = RIBBON_FROM; h <= RIBBON_TO; h++) {
    const time = T.localToDate(day.key, h, 0, tz).toISOString()
    const f = at(forecast, time)
    hours.push({
      time,
      hour: h,
      windKn: f && typeof f.windKn === 'number' ? Math.round(f.windKn) : null,
      gustKn: f && typeof f.gustKn === 'number' ? Math.round(f.gustKn) : null,
      windDir: f ? f.windDir : null,
      rainMm: f ? f.rainMm : null,
      rainLevel: f ? rainLevel(f.rainMm) : 0,
      level: f ? windLevel(f.windKn, f.gustKn, thresholds) : 'unknown'
    })
  }
  const start = Date.parse(hours[0].time)
  const end = Date.parse(hours[hours.length - 1].time)
  const front = detectFront(hours.map(h => ({ ...h })))
  return {
    label: day.isToday ? 'Here today' : 'Here tomorrow',
    hours,
    now: now >= start && now <= end ? new Date(now).toISOString() : null,
    sunrise: day.sun ? day.sun.sunrise : null,
    sunset: day.sun ? day.sun.sunset : null,
    front: front ? front.time : null
  }
}

// ----- attention cards ----------------------------------------------------

const CATEGORY_TITLE = {
  weather: 'Weather warning',
  waterlevel: 'Water level warning',
  exercise: 'Firing or exercise area',
  gnss: 'GNSS interference',
  hazard: 'Hazard to navigation',
  aton: 'Light or buoy out of order',
  works: 'Works at sea',
  navigation: 'Navigational warning'
}

function smartCase (s) {
  if (!s) return ''
  if (s !== s.toUpperCase()) return s
  return s.toLowerCase()
    .replace(/\.(?=\S)/g, '. ')
    .replace(/(^|[\s'"(„“])([a-zäöüåø])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/\b(And|Or|Of|The|To|In|On|At|By|For|From|With)\b/g, (m, w, i) => (i === 0 ? w : w.toLowerCase()))
    .replace(/\b(Gnss|Ais|Dgps|Dgnss|Gps|Utc)\b/g, w => w.toUpperCase())
    .replace(/\b(Cm|Nm|Kn|M)\b/g, w => w.toLowerCase())
    .trim()
}

const LEVEL_RANK = { red: 3, amber: 2, blue: 1 }

function warningLevel (state) {
  return state === 'alarm' || state === 'emergency' ? 'red' : state === 'warn' ? 'amber' : 'blue'
}

function distanceText (w) {
  if (w.areaOnly && w.distanceNm === 0) return 'your sea area'
  if (w.relevance === 'here') return 'here'
  if (typeof w.distanceNm === 'number') return `${Math.round(w.distanceNm)} nm away`
  return ''
}

function attention ({ barometer, pressure3h, warnings, battery, anchor }) {
  const cards = []
  if (barometer && barometer.severity && typeof barometer.change3h === 'number') {
    const falling = barometer.change3h < 0
    cards.push({
      kind: 'barometer',
      level: barometer.severity === 'alert' ? 'amber' : 'red',
      title: `Pressure ${barometer.label}`,
      detail: `${barometer.change3h > 0 ? '+' : ''}${barometer.change3h} hPa in 3 h · now ${barometer.current} hPa`,
      note: falling ? 'A front or a low is on its way.' : 'Gusty, squally wind can follow.',
      spark: pressure3h
    })
  }
  if (anchor && typeof anchor.currentRadius === 'number' && typeof anchor.maxRadius === 'number' && anchor.currentRadius > 0.8 * anchor.maxRadius) {
    cards.push({ kind: 'anchor', level: 'red', title: 'Anchor drifting', detail: `${anchor.currentRadius} m from the anchor, alarm at ${anchor.maxRadius} m`, note: 'Check the anchor now.' })
  }
  if (battery && typeof battery.soc === 'number' && battery.soc < 65) {
    cards.push({
      kind: 'battery',
      level: battery.soc < 50 ? 'red' : 'amber',
      title: battery.soc < 50 ? 'Battery low' : 'Battery getting low',
      detail: `${battery.soc} % · ${battery.voltage ?? '–'} V · ${battery.current ?? '–'} A`,
      note: 'Charge today: engine, shore power or solar.'
    })
  }
  for (const w of warnings) {
    if (/onboard_pressure$/.test(w.path || '')) continue // shown by our own barometer card
    if (w.relevance === 'route' || w.relevance === 'far') continue // that's for the Passage tab
    cards.push({
      kind: 'warning',
      level: warningLevel(w.state),
      title: CATEGORY_TITLE[w.category] || 'Warning',
      detail: smartCase((w.title || '').length < 25 && w.detail ? `${(w.title || '').replace(/[.:]+$/, '')}: ${w.detail}` : (w.title || w.message || '')),
      note: [w.label, distanceText(w)].filter(Boolean).join(' · '),
      distanceNm: w.distanceNm
    })
  }
  const kindRank = { barometer: 3, anchor: 3, battery: 2, warning: 1 }
  cards.sort((a, b) => (LEVEL_RANK[b.level] - LEVEL_RANK[a.level]) || (kindRank[b.kind] - kindRank[a.kind]) || ((a.distanceNm ?? 99) - (b.distanceNm ?? 99)))
  return { cards: cards.slice(0, 3), more: Math.max(0, cards.length - 3) }
}

// The quiet line at the bottom: what's fine (or slightly off) at a glance.
function status ({ battery, wind, cabin }) {
  const out = []
  if (battery && typeof battery.soc === 'number') {
    let t = `Battery ${battery.soc} %`
    if (typeof battery.timeRemainingS === 'number') {
      const h = Math.floor(battery.timeRemainingS / 3600)
      t += ` · ${h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h`}`
    }
    out.push({ text: t, level: battery.soc < 50 ? 'red' : battery.soc < 65 ? 'amber' : 'green' })
  } else out.push({ text: 'Battery: no data', level: 'grey' })
  if (typeof wind.tws === 'number') {
    const g = typeof wind.gust10 === 'number' ? ` · gust ${Math.round(wind.gust10)}` : ''
    out.push({ text: `Wind now ${compass8(wind.twd)} ${Math.round(wind.tws)} kn${g}`.replace('now  ', 'now '), level: 'green' })
  } else if (typeof wind.aws === 'number') {
    // no true wind (needs boat speed and heading, e.g. signalk-derived-data): show apparent
    out.push({ text: `Wind now ${Math.round(wind.aws)} kn apparent`, level: 'green' })
  } else out.push({ text: 'Wind: no data', level: 'grey' })
  if (typeof cabin.temp === 'number') {
    const hum = typeof cabin.humidity === 'number' ? ` · ${cabin.humidity} %` : ''
    out.push({ text: `Cabin ${Math.round(cabin.temp)} °C${hum}`, level: (cabin.humidity || 0) > 85 ? 'amber' : 'green' })
  }
  return out
}

module.exports = { briefDay, periodHours, detectFront, localVerdict, headline, ribbon, attention, status, smartCase, CATEGORY_TITLE }
