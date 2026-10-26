/* Sailpartner morning brief — renders /plugins/sailpartner/brief onto a 1280x800 SVG. */
'use strict'

const API = '/plugins/sailpartner'
const WARN_API = '/plugins/signalk-baltic-warnings'
const NS = 'http://www.w3.org/2000/svg'
const C = {
  bg: '#0b1520', panel: '#13202e', panel2: '#0f1a26', line: '#24364a', text: '#e8eef5', muted: '#8aa0b5', dim: '#5d7085',
  soft: '#c9d6e3', blue: '#4fa3e8', lightBlue: '#85b7eb', green: '#2fbf8f', amber: '#f0a33a', red: '#ef5b5b',
  redText: '#ffb3b3', redBright: '#ff8a8a', amberText: '#ffd28a', yellow: '#ffd84a', starboard: '#3fcf6f'
}
const DROP = 'M0 -9 C4 -3 7 1 7 4 A7 7 0 0 1 -7 4 C-7 1 -4 -3 0 -9 Z'
const ARROW = 'M0 -13 L7 6 L0 2 L-7 6 Z'

let brief = null
let sources = null
let tz = undefined

// ---------- helpers ----------
const svg = document.getElementById('screen')
let root = svg

function el (tag, attrs, text, parent) {
  const e = document.createElementNS(NS, tag)
  for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k])
  if (text !== undefined && text !== null) e.textContent = text
  ;(parent || root).appendChild(e)
  return e
}
const T = (x, y, s, size, fill, o = {}) => el('text', { x, y, 'font-size': size, fill, ...o }, s)
const R = (x, y, w, h, fill, o = {}) => el('rect', { x, y, width: w, height: h, fill, ...o })
const P = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('')
function panel (x, y, w, h) { return R(x, y, w, h, C.panel, { rx: 12 }) }
function arrowAt (x, y, fromDeg, color, scale = 1) {
  if (typeof fromDeg !== 'number') return
  const g = el('g', { transform: `translate(${x} ${y}) rotate(${fromDeg + 180}) scale(${scale})` })
  el('path', { d: ARROW, fill: color }, null, g)
}
const fmtNum = (v, d = 1) => (typeof v === 'number' ? v.toFixed(d) : '–')
function localParts (iso) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short', day: 'numeric', month: 'short' })
  const o = {}
  for (const p of f.formatToParts(new Date(iso))) o[p.type] = p.value
  return o
}
const hh = iso => `${Number(localParts(iso).hour) % 24}h`
const clock = iso => { const p = localParts(iso); return `${p.hour}:${p.minute}` }
const levelColor = l => (l === 'red' ? C.red : l === 'amber' ? C.amber : l === 'green' ? C.green : C.line)
const stateColor = s => (s === 'alarm' || s === 'emergency' ? C.red : s === 'warn' ? C.amber : C.lightBlue)
const stateText = s => (s === 'alarm' || s === 'emergency' ? C.redText : s === 'warn' ? C.amberText : C.soft)
function clip (s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : s || '' }
// Shrinks then truncates an SVG text element until it fits maxW (user units)
function fit (t, maxW, minSize) {
  if (!t || t.getComputedTextLength() <= maxW) return t
  let size = Number(t.getAttribute('font-size'))
  while (minSize && size > minSize && t.getComputedTextLength() > maxW) { size -= 1; t.setAttribute('font-size', size) }
  let s = t.textContent
  while (s.length > 4 && t.getComputedTextLength() > maxW) { s = s.slice(0, -2); t.textContent = s.replace(/[\s,.·]+$/, '') + '…' }
  return t
}

// ---------- sections ----------
function header (b) {
  const p = localParts(b.now)
  T(30, 46, `${p.weekday} ${p.day} ${p.month}`, 32, C.text, { 'font-weight': 500 })
  const sun = b.sun ? ` · sunrise ${clock(b.sun.sunrise)} · sunset ${clock(b.sun.sunset)}` : ''
  T(230, 44, `${b.place.name}${sun}`, 20, C.muted)
  T(975, 46, clock(b.now), 32, C.text, { 'text-anchor': 'end', 'font-weight': 500 })
  const v = b.verdict || { level: 'unknown', text: 'No forecast yet' }
  const fill = v.level === 'stay' ? C.red : v.level === 'caution' ? C.amber : v.level === 'go' ? C.green : C.line
  const ink = v.level === 'stay' ? '#3a0a0a' : v.level === 'caution' ? '#3a2404' : v.level === 'go' ? '#04342c' : C.text
  R(995, 14, 260, 44, fill, { rx: 8 })
  T(1125, 44, clip(v.text, 20), 22, ink, { 'text-anchor': 'middle', 'font-weight': 500 })
}

function warningsStrip (b) {
  R(20, 70, 1240, 58, C.panel, { rx: 12 })
  T(40, 106, 'Warnings', 20, C.text, { 'font-weight': 500 })
  const ws = b.warnings || []
  if (!ws.length) {
    T(150, 106, 'Nothing near you or on your route', 20, C.green)
  } else {
    ws.slice(0, 2).forEach((w, i) => {
      const x = 140 + i * 450
      R(x, 85, 10, 28, stateColor(w.state))
      fit(T(x + 20, 106, w.message, 19, stateText(w.state)), 415, 16)
    })
  }
  let right = ''
  let color = C.muted
  if (ws.length > 2) right = `+${ws.length - 2} more · `
  if (sources) {
    const enabled = sources.filter(s => s.enabled && !s.probeOnly)
    const failing = enabled.filter(s => s.lastError)
    const last = enabled.map(s => s.lastSuccess).filter(Boolean).sort().pop()
    if (failing.length) { right += `${failing.length} source${failing.length > 1 ? 's' : ''} failing`; color = C.amber } else if (last) right += `sources OK ${clock(last)}`
  } else {
    right += 'warnings plugin not reachable'; color = C.amber
  }
  T(1240, 106, right.replace(/ · $/, ''), 16, color, { 'text-anchor': 'end' })
}

function todayBrief (b) {
  panel(20, 138, 760, 164)
  T(40, 170, 'Today in brief', 22, C.text, { 'font-weight': 500 })
  ;(b.summary || []).slice(0, 4).forEach((l, i) => fit(T(40, 204 + i * 28, l.text, 20, l.emphasis ? C.amberText : C.text), 480, 17))
  if (!b.summary || !b.summary.length) T(40, 210, b.forecast && b.forecast.error ? 'No forecast: ' + clip(b.forecast.error, 34) : 'Waiting for the forecast…', 19, C.muted)
  // rain next 12 h
  el('line', { x1: 536, y1: 152, x2: 536, y2: 290, stroke: C.line })
  T(556, 170, 'Rain', 17, C.muted)
  const st = b.rain.status
  T(760, 170, st, 17, st.startsWith('dry') ? C.green : C.lightBlue, { 'text-anchor': 'end' })
  const hours = b.rain.hours || []
  const x0 = 556; const x1 = 760; const y0 = 186; const y1 = 266
  const bw = (x1 - x0) / Math.max(12, hours.length)
  const Y = v => y1 - (y1 - y0) * Math.min(v, 3) / 3
  el('line', { x1: x0, x2: x1, y1, y2: y1, stroke: C.line })
  let peak = null
  hours.forEach((h, i) => {
    const x = x0 + bw * i
    const mm = h.mm || 0
    if (mm >= 0.1) R(x + 2, Y(mm), bw - 4, y1 - Y(mm), mm >= 1 ? C.blue : C.lightBlue, { rx: 2 })
    else R(x + 2, y1 - 3, bw - 4, 3, C.line)
    if (!peak || mm > peak.mm) peak = { mm, i, time: h.time }
    if (i % 3 === 0) T(x + bw / 2, 288, hh(h.time), 14, C.muted, { 'text-anchor': 'middle' })
  })
}

function tripPanel (b) {
  panel(20, 312, 760, 430)
  T(40, 346, 'Where do you want to go today?', 22, C.text, { 'font-weight': 500 })
  const tr = b.trip
  R(40, 362, 420, 46, C.bg, { rx: 8, stroke: tr ? C.blue : C.line, 'stroke-width': 2 })
  T(60, 393, tr ? tr.destination : 'Tap to choose a destination', 22, tr ? C.text : C.muted)
  R(474, 362, 140, 46, C.bg, { rx: 8, stroke: C.line, 'stroke-width': 2 })
  T(544, 393, tr ? `dep ${clock(tr.departure)}` : 'dep –', 20, C.text, { 'text-anchor': 'middle' })
  R(628, 362, 132, 46, C.bg, { rx: 8, stroke: C.line, 'stroke-width': 2 })
  T(694, 393, `${fmtNum(tr ? tr.speedKn : (window.__speed || 5))} kn`, 20, C.text, { 'text-anchor': 'middle' })
  const tapLayer = R(40, 362, 720, 46, 'transparent', { class: 'tap' })
  tapLayer.addEventListener('click', openPicker)

  if (tr) routeColumns(tr)
  else windChart(b.windToday || [], b.thresholds)
}

function routeColumns (tr) {
  const sailing = tr.hours.filter(h => !h.arrival).slice(0, 8)
  const w = 720 / 8
  sailing.forEach((r, i) => {
    const cx = 40 + w * i + w / 2
    T(cx, 440, hh(r.time), 20, C.text, { 'text-anchor': 'middle', 'font-weight': 500 })
    T(cx, 460, `${Math.round(r.distanceNm)} nm`, 15, C.muted, { 'text-anchor': 'middle' })
    arrowAt(cx, 488, r.windDir, C.soft)
    T(cx, 528, r.windKn === null ? '–' : `${r.windFrom} ${r.windKn}`, 21, C.text, { 'text-anchor': 'middle', 'font-weight': 500 })
    T(cx, 550, r.gustKn === null ? '' : `G${r.gustKn}`, 17, levelColor(r.level), { 'text-anchor': 'middle' })
    T(cx, 572, r.pointOfSail || '', 15, C.muted, { 'text-anchor': 'middle' })
    T(cx, 594, r.waveM === null ? '' : `${fmtNum(r.waveM)} m`, 15, C.muted, { 'text-anchor': 'middle' })
    if (!r.rainLevel) T(cx, 620, 'dry', 15, C.dim, { 'text-anchor': 'middle' })
    else for (let k = 0; k < r.rainLevel; k++) el('path', { d: DROP, transform: `translate(${cx - (r.rainLevel - 1) * 9 + k * 18} 614)`, fill: C.blue })
    R(40 + w * i + 3, 634, w - 6, 12, levelColor(r.level), { rx: 3 })
  })
  T(40, 668, `${brief.place.name} ${clock(tr.departure)}`, 15, C.muted)
  T(760, 668, `${tr.destination} ${clock(tr.eta)}`, 15, C.muted, { 'text-anchor': 'end' })
  const h = Math.floor(tr.durationH); const m = Math.round((tr.durationH - h) * 60)
  let line = `${fmtNum(tr.distanceNm)} nm · ${h}h${String(m).padStart(2, '0')} · ETA ${clock(tr.eta)}`
  if (tr.sunsetMarginMin !== null) line += tr.sunsetMarginMin >= 0 ? ` · ${tr.sunsetMarginMin} min before sunset` : ` · ${-tr.sunsetMarginMin} min after sunset`
  T(40, 694, line, 20, tr.sunsetMarginMin !== null && tr.sunsetMarginMin < 30 ? C.amberText : C.text, { 'font-weight': 500 })
  const adv = (tr.advice || []).map(a => a.text)
  if (adv.length) fit(T(40, 724, adv.join(', ').replace(/^./, c => c.toUpperCase()), 18, C.muted), 720, 15)
  else T(40, 724, 'No surprises on the way.', 18, C.muted)
}

function windChart (hours, th) {
  const list = hours.slice(0, 16)
  if (!list.length) { T(40, 460, 'Wind forecast appears here once the forecast has loaded.', 18, C.muted); return }
  T(40, 440, 'No trip planned · wind here today (kn)', 17, C.muted)
  const x0 = 86; const x1 = 760; const y0 = 480; const y1 = 660; const mx = 32
  const bw = (x1 - x0) / list.length
  const Y = v => y1 - (y1 - y0) * Math.min(v, mx) / mx
  ;[10, 20, 30].forEach(v => { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: C.line }); T(x0 - 10, Y(v) + 6, v, 16, C.muted, { 'text-anchor': 'end' }) })
  list.forEach((h, i) => {
    const cx = x0 + bw * i + bw / 2
    if (h.windKn !== null) R(cx - bw * 0.33, Y(h.windKn), bw * 0.66, y1 - Y(h.windKn), h.level === 'green' ? C.blue : C.amber, { rx: 3 })
    if (h.gustKn !== null) el('line', { x1: cx - bw * 0.36, x2: cx + bw * 0.36, y1: Y(h.gustKn), y2: Y(h.gustKn), stroke: h.level === 'red' ? C.red : C.soft, 'stroke-width': 4 })
    arrowAt(cx, 462, h.windDir, C.soft, 0.85)
    if (i % 2 === 0) T(cx, 686, hh(h.time), 16, C.muted, { 'text-anchor': 'middle' })
  })
  const reef = (th && th.reefWindKn) || 18
  el('line', { x1: x0, x2: x1, y1: Y(reef), y2: Y(reef), stroke: C.red, 'stroke-dasharray': '8 6', 'stroke-width': 2 })
  T(40, 724, `Bars mean wind · ticks gusts · dashed line reef at ${reef} kn`, 16, C.muted)
}

function windTile (b) {
  panel(796, 138, 464, 352)
  const w = b.wind
  const cx = 920; const cy = 262; const Rr = 112
  const Pt = (a, r) => [cx + r * Math.sin(a * Math.PI / 180), cy - r * Math.cos(a * Math.PI / 180)]
  const arc = (a1, a2, r, col, sw) => { const p1 = Pt(a1, r); const p2 = Pt(a2, r); el('path', { d: `M${p1[0].toFixed(1)} ${p1[1].toFixed(1)} A${r} ${r} 0 0 1 ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`, fill: 'none', stroke: col, 'stroke-width': sw }) }
  el('circle', { cx, cy, r: Rr, fill: '#1c2a3a' })
  el('circle', { cx, cy, r: Rr - 18, fill: C.panel2 })
  arc(-60, -20, Rr - 9, C.red, 16); arc(20, 60, Rr - 9, C.starboard, 16); arc(130, 170, Rr - 9, C.amber, 16); arc(-170, -130, Rr - 9, C.amber, 16)
  for (let a = 0; a < 360; a += 10) {
    const maj = a % 30 === 0
    const p1 = Pt(a, Rr - 18); const p2 = Pt(a, Rr - 18 - (maj ? 12 : 6))
    el('line', { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], stroke: maj ? C.text : C.dim, 'stroke-width': maj ? 2.5 : 1.5 })
  }
  ;[[0, 0], [180, 180], [30, 30], [-30, 30], [60, 60], [-60, 60], [90, 90], [-90, 90], [120, 120], [-120, 120], [150, 150], [-150, 150]].forEach(([x, a]) => { const p = Pt(x, Rr - 42); T(p[0], p[1] + 5, a, 14, C.soft, { 'text-anchor': 'middle' }) })
  el('path', { d: `M${cx} ${cy - 48} C${cx + 16} ${cy - 30} ${cx + 18} ${cy - 12} ${cx + 16} ${cy - 2} M${cx} ${cy - 48} C${cx - 16} ${cy - 30} ${cx - 18} ${cy - 12} ${cx - 16} ${cy - 2}`, fill: 'none', stroke: C.muted, 'stroke-width': 2 })
  T(cx, cy + 16, 'APPARENT', 12, C.muted, { 'text-anchor': 'middle' })
  T(cx, cy + 46, fmtNum(w.aws), 32, C.text, { 'text-anchor': 'middle', 'font-weight': 500 })
  T(cx, cy + 64, 'kn', 13, C.muted, { 'text-anchor': 'middle' })
  const ptr = (a, col, lab, len) => {
    if (typeof a !== 'number') return
    const tip = Pt(a, Rr - 2); const b1 = Pt(a - 7, Rr - len); const b2 = Pt(a + 7, Rr - len); const l = Pt(a, Rr - len * 0.55)
    el('path', { d: `M${tip[0]} ${tip[1]} L${b1[0]} ${b1[1]} L${b2[0]} ${b2[1]} Z`, fill: col, stroke: C.bg, 'stroke-width': 1.5 })
    T(l[0], l[1] + 5, lab, 13, '#2a1a02', { 'text-anchor': 'middle', 'font-weight': 500 })
  }
  ptr(w.twa, C.yellow, 'T', 34)
  ptr(w.awa, C.amber, 'A', 44)

  T(1040, 176, 'True wind speed', 17, C.muted)
  const tws = T(1040, 212, fmtNum(w.tws) + ' ', 34, C.text, { 'font-weight': 500 })
  el('tspan', { 'font-size': 18, fill: C.muted }, 'kn', tws)
  T(1040, 250, 'True direction', 17, C.muted)
  T(1040, 280, typeof w.twd === 'number' ? `${w.twd}° ${compass(w.twd)}` : '–', 24, C.text, { 'font-weight': 500 })
  T(1040, 318, 'Gust, last 10 min', 17, C.muted)
  T(1040, 348, typeof w.gust10 === 'number' ? `${Math.round(w.gust10)} kn` : '–', 24, C.text, { 'font-weight': 500 })

  el('line', { x1: 816, y1: 388, x2: 1240, y2: 388, stroke: C.line })
  T(816, 412, 'Last 3 hours', 16, C.muted)
  if (w.trend) T(1240, 412, w.trend.text, 16, Math.abs(w.trend.veerDeg) >= 10 || Math.abs(w.trend.deltaKn) >= 2 ? C.amberText : C.muted, { 'text-anchor': 'end' })
  const pts = w.points || []
  const labels = ['−3h', '−2½h', '−2h', '−1½h', '−1h', '−½h', 'now']
  const known = pts.filter(p => typeof p.tws === 'number')
  const lo = known.length ? Math.min(...known.map(p => p.tws)) : 0
  const hi = known.length ? Math.max(...known.map(p => p.tws)) : 1
  const step = 424 / 7
  pts.forEach((p, i) => {
    const x = 816 + step * i + step / 2
    const sc = hi > lo ? 0.8 + 0.25 * (p.tws - lo) / (hi - lo) : 0.9
    if (typeof p.twd === 'number') arrowAt(x, 436, p.twd, i === 6 ? C.blue : C.soft, sc)
    T(x, 464, typeof p.tws === 'number' ? `${Math.round(p.tws)} kn` : '–', 16, i === 6 ? C.text : C.soft, { 'text-anchor': 'middle', 'font-weight': i === 6 ? 500 : 400 })
    T(x, 482, labels[i], 13, C.muted, { 'text-anchor': 'middle' })
  })
}

function compass (d) { return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((d % 360) + 360) % 360 / 22.5) % 16] }

function batteryTile (b) {
  panel(796, 500, 464, 100)
  T(816, 528, 'House bank', 20, C.text, { 'font-weight': 500 })
  const bt = b.battery
  if (!bt) { T(816, 570, 'No battery data (SmartShunt not seen yet)', 17, C.muted); return }
  const right = []
  if (typeof bt.consumedAh === 'number') right.push(`${bt.consumedAh} Ah`)
  if (typeof bt.timeRemainingS === 'number') { const h = Math.floor(bt.timeRemainingS / 3600); right.push(h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h to go` : `${h}h to go`) }
  T(1240, 528, right.join(' · '), 15, C.muted, { 'text-anchor': 'end' })
  const soc = typeof bt.soc === 'number' ? bt.soc : null
  const circ = 2 * Math.PI * 22
  el('circle', { cx: 840, cy: 568, r: 22, fill: 'none', stroke: C.line, 'stroke-width': 7 })
  if (soc !== null) el('circle', { cx: 840, cy: 568, r: 22, fill: 'none', stroke: soc < 50 ? C.red : soc < 65 ? C.amber : C.green, 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-dasharray': `${circ * soc / 100} ${circ}`, transform: 'rotate(-90 840 568)' })
  T(840, 573, soc === null ? '–' : `${soc}%`, 13, C.text, { 'text-anchor': 'middle', 'font-weight': 500 })
  T(884, 560, 'Voltage', 15, C.muted); T(884, 586, `${fmtNum(bt.voltage, 2)} V`, 22, C.text, { 'font-weight': 500 })
  T(1060, 560, 'Current', 15, C.muted); T(1060, 586, `${fmtNum(bt.current)} A`, 22, (bt.current || 0) < 0 ? C.redBright : C.green, { 'font-weight': 500 })
}

function barometerTile (b) {
  panel(796, 610, 464, 64)
  T(816, 648, 'Barometer', 20, C.text, { 'font-weight': 500 })
  const br = b.barometer || {}
  const series = br.series || []
  if (series.length > 1) {
    const vals = series.map(s => s.hPa)
    const mn = Math.min(...vals) - 0.5; const mx = Math.max(...vals) + 0.5
    const x0 = 940; const x1 = 1080; const y0 = 622; const y1 = 662
    const t0 = Date.parse(series[0].t); const t1 = Date.parse(series[series.length - 1].t)
    const X = t => x0 + (x1 - x0) * (Date.parse(t) - t0) / Math.max(1, t1 - t0)
    const Y = v => y1 - (y1 - y0) * (v - mn) / (mx - mn)
    const three = t1 - 3 * 3600e3
    if (three > t0) R(X(new Date(three).toISOString()), y0, x1 - X(new Date(three).toISOString()), y1 - y0, br.severity ? C.red : C.line, { 'fill-opacity': 0.18 })
    el('path', { d: P(series.map(s => [X(s.t), Y(s.hPa)])), fill: 'none', stroke: C.blue, 'stroke-width': 3, 'stroke-linejoin': 'round' })
  }
  const cur = T(1240, 640, typeof br.current === 'number' ? fmtNum(br.current) + ' ' : '–', 20, C.text, { 'text-anchor': 'end', 'font-weight': 500 })
  if (typeof br.current === 'number') el('tspan', { 'font-size': 14, fill: C.muted }, 'hPa', cur)
  if (typeof br.change3h === 'number') {
    const sev = br.severity
    const label = `${br.label} · ${br.change3h > 0 ? '+' : ''}${fmtNum(br.change3h)} / 3h`
    if (sev) {
      const wdt = 18 + label.length * 7.6
      R(1240 - wdt, 646, wdt, 24, sev === 'alert' ? '#4a3510' : '#4a1717', { rx: 6 })
      T(1240 - wdt / 2, 663, label.replace(/^./, c => c.toUpperCase()), 14, sev === 'alert' ? C.amberText : C.redBright, { 'text-anchor': 'middle', 'font-weight': 500 })
    } else {
      T(1240, 664, label, 14, C.muted, { 'text-anchor': 'end' })
    }
  } else {
    T(1240, 664, 'trend after 3 h of data', 13, C.muted, { 'text-anchor': 'end' })
  }
}

function boatTile (b) {
  panel(796, 684, 464, 58)
  const st = b.place.state
  const title = st === 'anchored' ? `At anchor · ${b.place.name}` : st === 'underway' ? 'Under way' : `Moored · ${b.place.name}`
  T(816, 708, title, 18, C.green, { 'font-weight': 500 })
  const bits = []
  if (st === 'anchored' && b.boat.anchor) {
    const a = b.boat.anchor
    bits.push(`drift ${a.currentRadius ?? '–'} m of ${a.maxRadius ?? '–'} m`)
  }
  if (b.boat.overnightMax) bits.push(`max ${b.boat.overnightMax.kn} kn at ${clock(b.boat.overnightMax.at)}`)
  if (typeof b.boat.cabinTemp === 'number') bits.push(`cabin ${fmtNum(b.boat.cabinTemp)} °C${typeof b.boat.cabinHumidity === 'number' ? ', ' + b.boat.cabinHumidity + ' %' : ''}`)
  if (b.log && b.log.yesterday && b.log.yesterday.distanceNm > 0) bits.push(`yesterday ${fmtNum(b.log.yesterday.distanceNm)} nm`)
  fit(T(816, 731, bits.join(' · '), 15, C.soft), 424, 13)
}

function navBar () {
  R(0, 752, 1280, 48, C.panel2)
  const tabs = ['Brief', 'Weather', 'Warnings', 'Battery', 'Logbook', 'Chart']
  const w = 1280 / tabs.length
  tabs.forEach((t, i) => {
    const cx = w * i + w / 2
    const active = i === 0
    T(cx, 783, t, 20, active ? C.text : C.muted, { 'text-anchor': 'middle', 'font-weight': active ? 500 : 400 })
    if (active) R(cx - 50, 794, 100, 4, C.green)
    const hit = R(w * i, 752, w, 48, 'transparent', { class: 'tap' })
    if (!active) hit.addEventListener('click', () => toast(`${t} page is coming in the next version`))
  })
  const n = brief && brief.warnings ? brief.warnings.length : 0
  if (n) {
    const cx = w * 2 + w / 2
    el('circle', { cx: cx + 56, cy: 770, r: 12, fill: C.red })
    T(cx + 56, 776, n, 16, '#fff', { 'text-anchor': 'middle', 'font-weight': 500 })
  }
}

function render () {
  while (svg.firstChild) svg.removeChild(svg.firstChild)
  root = svg
  R(0, 0, 1280, 800, C.bg)
  if (!brief) { T(640, 400, 'Loading…', 28, C.muted, { 'text-anchor': 'middle' }); return }
  header(brief)
  warningsStrip(brief)
  todayBrief(brief)
  tripPanel(brief)
  windTile(brief)
  batteryTile(brief)
  barometerTile(brief)
  boatTile(brief)
  navBar()
}

// ---------- data ----------
async function load () {
  try {
    const r = await fetch(`${API}/brief`, { credentials: 'include' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    brief = await r.json()
    tz = brief.timezone
  } catch (e) {
    toast(`Could not load the brief: ${e.message}`)
  }
  try {
    const r = await fetch(`${WARN_API}/status`, { credentials: 'include' })
    sources = r.ok ? (await r.json()).sources : null
  } catch (e) { sources = null }
  render()
}

let toastTimer = null
function toast (msg) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, 3500)
}

// ---------- trip picker ----------
const picker = { dest: null, depMin: 9 * 60, speed: 5 }
const $ = id => document.getElementById(id)

async function openPicker () {
  let data
  try { data = await (await fetch(`${API}/destinations`, { credentials: 'include' })).json() } catch (e) { toast('Could not load destinations'); return }
  const tr = brief && brief.trip
  picker.speed = tr ? tr.speedKn : data.speedKn
  picker.dest = tr ? tr.destination : null
  const now = new Date(brief ? brief.now : Date.now()) // the boat's clock, not the browser's
  const p = localParts(tr ? tr.departure : new Date(Math.ceil(now.getTime() / 1800e3) * 1800e3).toISOString())
  picker.depMin = Number(p.hour) % 24 * 60 + Number(p.minute)
  const here = brief && brief.place.position
  const list = $('dest-list')
  list.innerHTML = ''
  for (const d of data.destinations) {
    const b = document.createElement('button')
    const nm = here ? Math.round(dist(here, d)) : null
    if (nm !== null && nm < 1.5) continue // that's where we are
    b.innerHTML = `${d.name}${nm !== null ? `<small>${nm} nm direct</small>` : ''}`
    if (d.name === picker.dest) b.classList.add('selected')
    b.addEventListener('click', () => { picker.dest = d.name; list.querySelectorAll('button').forEach(x => x.classList.toggle('selected', x === b)) })
    list.appendChild(b)
  }
  updatePickerValues()
  $('picker-error').hidden = true
  $('picker').hidden = false
}

function dist (a, b) {
  const r = Math.PI / 180
  const dLat = (b.latitude - a.latitude) * r; const dLon = (b.longitude - a.longitude) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin(dLon / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.sqrt(h))
}

function updatePickerValues () {
  const m = ((picker.depMin % 1440) + 1440) % 1440
  $('dep-out').textContent = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  $('spd-out').textContent = `${picker.speed.toFixed(1)} kn`
}

document.querySelectorAll('[data-dep]').forEach(b => b.addEventListener('click', () => { picker.depMin += Number(b.dataset.dep); updatePickerValues() }))
document.querySelectorAll('[data-spd]').forEach(b => b.addEventListener('click', () => { picker.speed = Math.min(9, Math.max(2, picker.speed + Number(b.dataset.spd))); updatePickerValues() }))
$('cancel').addEventListener('click', () => { $('picker').hidden = true })

$('save-trip').addEventListener('click', async () => {
  if (!picker.dest) { $('picker-error').textContent = 'Choose a destination first.'; $('picker-error').hidden = false; return }
  try {
    const r = await fetch(`${API}/trip`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: picker.dest, departure: $('dep-out').textContent, speedKn: picker.speed })
    })
    const body = await r.json()
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
    brief = body
    $('picker').hidden = true
    render()
    // tell the warnings plugin about the route so "on route" filtering works
    if (brief.trip && brief.trip.route) {
      fetch(`${WARN_API}/route`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: brief.trip.destination, points: brief.trip.route }) })
        .then(() => setTimeout(load, 1500)).catch(() => {})
    }
  } catch (e) {
    $('picker-error').textContent = `Could not plan the trip: ${e.message}`
    $('picker-error').hidden = false
  }
})

$('clear-trip').addEventListener('click', async () => {
  try {
    await fetch(`${API}/trip`, { method: 'DELETE', credentials: 'include' })
    fetch(`${WARN_API}/route`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
  } catch (e) { /* ignore */ }
  $('picker').hidden = true
  load()
})

render()
load()
setInterval(load, 30000)
