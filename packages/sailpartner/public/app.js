/* Sailpartner — Brief (here), Passage (a trip) and Instruments, drawn on a 1280x800 SVG. */
'use strict'

const API = '/plugins/sailpartner'
const WARN_API = '/plugins/signalk-baltic-warnings'
const NS = 'http://www.w3.org/2000/svg'
const C = {
  bg: '#0b1520', panel: '#13202e', panel2: '#0f1a26', line: '#24364a', grid: '#1f3044', text: '#e8eef5', muted: '#8aa0b5', dim: '#5d7085',
  soft: '#c9d6e3', blue: '#4fa3e8', lightBlue: '#85b7eb', green: '#2fbf8f', amber: '#f0a33a', red: '#ef5b5b',
  redText: '#ffb3b3', redBright: '#ff8a8a', amberText: '#ffd28a', greenText: '#9fe1cb', yellow: '#ffd84a', starboard: '#3fcf6f', sea: '#0e2233'
}
const DROP = 'M0 -7 C3.5 -2.5 5 1 5 2.6 A5 5 0 0 1 -5 2.6 C-5 1 -3.5 -2.5 0 -7 Z'
const ARROW = 'M0 -11 L6 5 L0 2 L-6 5 Z'
const PAGES = ['brief', 'passage', 'instruments', 'weather', 'warnings', 'battery', 'logbook', 'nmea']
const TABS = [['Brief', 'brief'], ['Passage', 'passage'], ['Instruments', 'instruments'], ['Weather', 'weather'], ['Warnings', 'warnings'], ['Battery', 'battery'], ['Logbook', 'logbook'], ['NMEA', 'nmea']]

const state = {
  page: PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'brief',
  brief: null,
  passage: null,
  warnings: null, // full list from signalk-baltic-warnings, null = not reachable
  sources: null,
  weather: null,
  battery: null,
  logbook: null,
  data: null,
  ui: { warnFilter: 'near', warnSel: null, warnPage: 0, nmeaFilter: 'All', nmeaPage: 0, logDay: null, logPage: 0, logSel: null },
  tz: undefined
}

// ---------------------------------------------------------------- helpers
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
const P = pts => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('')
const panel = (x, y, w, h) => R(x, y, w, h, C.panel, { rx: 12 })
const fmtNum = (v, d = 1) => (typeof v === 'number' ? v.toFixed(d) : '–')
function tap (node, fn) { node.setAttribute('class', 'tap'); node.addEventListener('click', e => { e.stopPropagation(); fn(e) }); return node }
// Shrinks, then truncates an SVG text until it fits maxW user units
function fit (t, maxW, minSize) {
  if (!t || !t.getComputedTextLength || t.getComputedTextLength() <= maxW) return t
  let size = Number(t.getAttribute('font-size'))
  while (minSize && size > minSize && t.getComputedTextLength() > maxW) { size -= 1; t.setAttribute('font-size', size) }
  let s = t.textContent
  while (s.length > 4 && t.getComputedTextLength() > maxW) { s = s.slice(0, -2); t.textContent = s.replace(/[\s,.·]+$/, '') + '…' }
  return t
}
function arrowAt (x, y, fromDeg, color = C.soft, scale = 1) {
  if (typeof fromDeg !== 'number') return
  const g = el('g', { transform: `translate(${x} ${y}) rotate(${fromDeg + 180}) scale(${scale})` })
  el('path', { d: ARROW, fill: color }, null, g)
}
function drops (x, y, n) { for (let k = 0; k < n; k++) el('path', { d: DROP, transform: `translate(${x - (n - 1) * 7 + k * 14} ${y})`, fill: C.blue }) }
function localParts (iso) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: state.tz, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const o = {}
  for (const p of f.formatToParts(new Date(iso))) o[p.type] = p.value
  o.hour = String(Number(o.hour) % 24).padStart(2, '0')
  return o
}
const hh = iso => `${Number(localParts(iso).hour)}h`
const clock = iso => { const p = localParts(iso); return `${p.hour}:${p.minute}` }
const dayKey = iso => { const p = localParts(iso); return `${p.year}-${p.month}-${p.day}` }
function compass (d) { return typeof d === 'number' ? ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((d % 360) + 360) % 360 / 22.5) % 16] : '' }
const levelFill = l => (l === 'red' ? C.red : l === 'amber' ? C.amber : l === 'blue' ? C.lightBlue : l === 'green' ? C.green : C.dim)
const severityLevel = s => (s === 'alarm' || s === 'emergency' ? 'red' : s === 'warn' ? 'amber' : 'blue')
function smartCase (s) {
  if (!s || s !== s.toUpperCase()) return s || ''
  return s.toLowerCase().replace(/\.(?=\S)/g, '. ')
    .replace(/(^|[\s'"(„“])([a-zäöüåø])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/\b(And|Or|Of|The|To|In|On|At|By|For|From|With)\b/g, w => w.toLowerCase())
    .replace(/^./, c => c.toUpperCase())
    .replace(/\b(Gnss|Ais|Dgps|Dgnss|Gps|Utc)\b/g, w => w.toUpperCase()).replace(/\b(Cm|Nm|Kn|M)\b/g, w => w.toLowerCase()).trim()
}
function distNm (a, b) {
  const r = Math.PI / 180
  const dLat = (b.latitude - a.latitude) * r; const dLon = (b.longitude - a.longitude) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin(dLon / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.sqrt(h))
}

// One bar per hour: solid = mean wind, lighter top = up to the gust.
function gustBars (cols, { x0, cw, base, top, max = 32, bw, reefGust = 24, strongGust = 28, reefWind = 18, stayWind = 25, labelEvery = 1 }) {
  const Y = v => base - (base - top) * Math.min(v, max) / max
  const xe = x0 + cw * cols.length
  const meanCol = w => (w >= stayWind ? C.red : w >= reefWind ? C.amber : C.green)
  const gustCol = g => (g >= strongGust ? C.red : g >= reefGust ? C.amber : C.green)
  ;[10, 20, 30].forEach(v => { el('line', { x1: x0 - 6, x2: xe, y1: Y(v), y2: Y(v), stroke: C.grid }); T(x0 - 12, Y(v) + 5, v, 13, C.dim, { 'text-anchor': 'end' }) })
  el('line', { x1: x0 - 6, x2: xe, y1: Y(reefGust), y2: Y(reefGust), stroke: C.amber, 'stroke-dasharray': '6 6', 'stroke-width': 1.5, opacity: 0.8 })
  T(x0 - 4, Y(reefGust) - 6, `reef gusts ${reefGust}`, 13, C.amber)
  cols.forEach((c, i) => {
    if (typeof c.w !== 'number') return
    const cx = x0 + cw * i + cw / 2
    const g = typeof c.g === 'number' ? Math.max(c.g, c.w) : c.w
    if (g > c.w) {
      R(cx - bw / 2, Y(g), bw, Y(c.w) - Y(g), gustCol(g), { opacity: 0.32, rx: 3 })
      el('line', { x1: cx - bw / 2, x2: cx + bw / 2, y1: Y(g), y2: Y(g), stroke: gustCol(g), 'stroke-width': 3 })
      if (i % labelEvery === 0) T(cx, Y(g) - 6, Math.round(g), 13, gustCol(g) === C.green ? C.muted : gustCol(g), { 'text-anchor': 'middle' })
    }
    R(cx - bw / 2, Y(c.w), bw, base - Y(c.w), meanCol(c.w), { rx: Math.min(3, bw / 4) })
    if (i % labelEvery === 0 && base - Y(c.w) > 20) T(cx, base - 7, Math.round(c.w), labelEvery > 1 ? 13 : 16, '#04221a', { 'text-anchor': 'middle', 'font-weight': 500 })
  })
  return Y
}

function nav (active) {
  R(0, 752, 1280, 48, C.panel2)
  const w = 1280 / TABS.length
  TABS.forEach(([label, page], i) => {
    const cx = w * i + w / 2
    const a = page === active
    T(cx, 783, label, 18, a ? C.text : C.muted, { 'text-anchor': 'middle', 'font-weight': a ? 500 : 400 })
    if (a) R(cx - 40, 794, 80, 4, C.green)
    tap(R(w * i, 752, w, 48, 'transparent'), () => (page ? go(page) : toast(`${label} page is coming in a later version`)))
  })
  const n = state.brief && state.brief.attention ? state.brief.attention.cards.filter(c => c.kind === 'warning').length + state.brief.attention.more : 0
  if (n) {
    const cx = w * 4 + w / 2
    el('circle', { cx: cx + 46, cy: 768, r: 11, fill: C.red })
    T(cx + 46, 773, n, 15, '#fff', { 'text-anchor': 'middle', 'font-weight': 500 })
  }
}

// ---------------------------------------------------------------- Brief
function renderBrief () {
  const b = state.brief
  const p = localParts(b.now)
  T(40, 44, `${p.weekday} ${p.day} ${p.month} · ${clock(b.now)}`, 22, C.muted)
  const st = b.place.state
  const where = st === 'anchored' ? `At anchor · ${b.place.name}` : st === 'underway' ? 'Under way' : `Moored · ${b.place.name}`
  T(1240, 44, where, 22, C.green, { 'text-anchor': 'end' })

  const v = b.verdict
  const vCol = !v ? C.muted : v.level === 'stay' ? C.red : v.level === 'caution' ? C.amber : C.green
  fit(T(40, 112, v ? v.text : (b.forecast.error ? 'No forecast' : 'Waiting for the forecast…'), 60, vCol, { 'font-weight': 500 }), 1200, 40)
  const lines = b.headline || []
  if (!lines.length && b.forecast.error) lines.push(`Forecast not available: ${b.forecast.error}`)
  if (lines[0]) fit(T(40, 156, lines[0], 25, C.text), 1200, 19)
  if (lines[1]) fit(T(40, 188, lines[1], 25, C.soft), 1200, 19)

  // day ribbon
  panel(20, 206, 1240, 282)
  const rb = b.ribbon
  if (rb) {
    T(40, 232, `${rb.label} · kn`, 16, C.muted)
    const x0 = 60; const cw = 1180 / rb.hours.length
    const t7 = Date.parse(rb.hours[0].time)
    const xOf = iso => x0 + cw * ((Date.parse(iso) - t7) / 3600e3) + cw / 2
    if (rb.sunset && xOf(rb.sunset) < 1250) {
      const xs = Math.max(30, xOf(rb.sunset))
      R(xs, 216, 1250 - xs, 262, '#000', { opacity: 0.28 })
      T(xs + 8, 232, `sunset ${clock(rb.sunset)}`, 14, C.muted)
    }
    if (rb.sunrise && xOf(rb.sunrise) > 40) R(30, 216, xOf(rb.sunrise) - 30, 262, '#000', { opacity: 0.28 })
    gustBars(rb.hours.map(h => ({ w: h.windKn, g: h.gustKn })), { x0, cw, base: 420, top: 262, bw: cw * 0.56, ...thresholdOpts(b.thresholds) })
    rb.hours.forEach((h, i) => {
      const cx = x0 + cw * i + cw / 2
      arrowAt(cx, 244, h.windDir)
      drops(cx, 442, h.rainLevel || 0)
      T(cx, 470, `${h.hour}h`, 15, C.muted, { 'text-anchor': 'middle' })
    })
    if (rb.now) {
      const x = xOf(rb.now)
      el('line', { x1: x, x2: x, y1: 224, y2: 426, stroke: C.text, 'stroke-width': 2, 'stroke-dasharray': '4 4' })
      T(x + 6, 232, 'now', 14, C.text)
    }
    if (rb.front) {
      const x = xOf(rb.front)
      el('line', { x1: x, x2: x, y1: 262, y2: 426, stroke: C.red, 'stroke-width': 2.5 })
      R(x + 5, 258, 54, 20, C.red, { rx: 4 })
      T(x + 32, 273, 'front', 14, '#3a0a0a', { 'text-anchor': 'middle', 'font-weight': 500 })
    }
  } else {
    T(40, 350, b.forecast.error ? `No forecast: ${b.forecast.error}` : 'The day ribbon appears once the forecast has loaded.', 20, C.muted)
  }

  // attention cards
  const at = b.attention || { cards: [], more: 0 }
  T(40, 522, 'NEEDS YOUR ATTENTION', 19, C.muted, { 'letter-spacing': 0.5 })
  if (at.more) T(1240, 522, `+${at.more} more in Warnings`, 16, C.muted, { 'text-anchor': 'end' })
  if (!at.cards.length) {
    R(20, 536, 1240, 152, C.panel, { rx: 12 })
    R(20, 536, 8, 152, C.green)
    T(48, 600, 'Nothing needs your attention', 26, C.text, { 'font-weight': 500 })
    T(48, 638, 'No warnings near you, barometer steady, battery fine.', 19, C.muted)
  }
  at.cards.forEach((c, i) => {
    const x = 20 + i * 416; const y = 536
    R(x, y, 400, 152, C.panel, { rx: 12 })
    R(x, y, 8, 152, levelFill(c.level))
    fit(T(x + 28, y + 42, c.title, 23, C.text, { 'font-weight': 500 }), 356, 18)
    fit(T(x + 28, y + 78, c.detail, 18, C.soft), 356, 14)
    if (c.spark && c.spark.length > 1) {
      const vals = c.spark.map(s => s.hPa)
      const mn = Math.min(...vals) - 0.2; const mx = Math.max(...vals) + 0.2
      el('path', { d: P(c.spark.map((s, j) => [x + 28 + j * (340 / (c.spark.length - 1)), y + 140 - (s.hPa - mn) / (mx - mn) * 30])), fill: 'none', stroke: C.blue, 'stroke-width': 3, 'stroke-linejoin': 'round' })
      fit(T(x + 28, y + 106, c.note, 17, C.muted), 356, 14)
    } else {
      fit(T(x + 28, y + 108, c.note, 17, C.muted), 356, 14)
    }
  })

  // quiet status line
  R(20, 700, 1240, 44, C.panel2, { rx: 10 })
  const items = (b.status || []).slice()
  items.push(sourcesStatus())
  items.slice(0, 4).forEach((it, i) => {
    const x = 44 + 310 * i
    el('circle', { cx: x, cy: 722, r: 6, fill: it.level === 'grey' ? C.dim : levelFill(it.level) })
    fit(T(x + 16, 728, it.text, 18, C.soft), 280, 14)
  })
  nav('brief')
}

function sourcesStatus () {
  if (!state.sources) return { text: 'Warnings plugin not reachable', level: 'amber' }
  const enabled = state.sources.filter(s => s.enabled && !s.probeOnly)
  const failing = enabled.filter(s => s.lastError)
  const short = n => n.replace(/ \(.*\)$/, '').split(' / ')[0]
  if (failing.length) return { text: `${failing.length === 1 ? short(failing[0].name) : failing.length + ' warning sources'} failing — see Warnings`, level: 'amber' }
  const last = enabled.map(s => s.lastSuccess).filter(Boolean).sort().pop()
  return { text: last ? `Warning sources OK ${clock(last)}` : 'Warning sources starting…', level: last ? 'green' : 'grey' }
}

function thresholdOpts (t) {
  return t ? { reefGust: t.reefGustKn, strongGust: t.strongGustKn, reefWind: t.reefWindKn, stayWind: t.stayWindKn } : {}
}

// ---------------------------------------------------------------- Passage
const MAP = { x: 20, y: 66, w: 600, h: 400 }
const TILE = 256
const map = { center: null, zoom: 10, routeKey: null, tileError: false, drag: null, layer: null }
const lon2x = (lon, z) => (lon + 180) / 360 * TILE * 2 ** z
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * TILE * 2 ** z }
const x2lon = (x, z) => x / (TILE * 2 ** z) * 360 - 180
const y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / (TILE * 2 ** z); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) }
function toScreen (p) {
  return [MAP.x + MAP.w / 2 + lon2x(p.longitude, map.zoom) - lon2x(map.center.longitude, map.zoom),
    MAP.y + MAP.h / 2 + lat2y(p.latitude, map.zoom) - lat2y(map.center.latitude, map.zoom)]
}
function fromScreen (sx, sy) {
  return {
    latitude: y2lat(lat2y(map.center.latitude, map.zoom) + sy - (MAP.y + MAP.h / 2), map.zoom),
    longitude: x2lon(lon2x(map.center.longitude, map.zoom) + sx - (MAP.x + MAP.w / 2), map.zoom)
  }
}
function fitMap (points) {
  if (!points.length) return
  const lats = points.map(p => p.latitude); const lons = points.map(p => p.longitude)
  const box = { n: Math.max(...lats), s: Math.min(...lats), e: Math.max(...lons), w: Math.min(...lons) }
  let z = 13
  for (; z > 5; z--) {
    const w = lon2x(box.e, z) - lon2x(box.w, z); const h = lat2y(box.s, z) - lat2y(box.n, z)
    if (w <= MAP.w - 100 && h <= MAP.h - 110) break
  }
  map.zoom = points.length === 1 ? 10 : z
  map.center = { latitude: y2lat((lat2y(box.n, map.zoom) + lat2y(box.s, map.zoom)) / 2, map.zoom), longitude: (box.e + box.w) / 2 }
}

function routePoints () {
  const ps = state.passage
  if (!ps) return []
  if (ps.trip) return ps.trip.route
  return [ps.boat.position, ...(ps.waypoints || [])]
}

function warningColor (w, onRoute) {
  if (!onRoute) return C.dim
  return w.severity === 'alarm' || w.severity === 'emergency' ? C.red : w.severity === 'warn' ? C.amber : C.lightBlue
}

function drawMap () {
  const g = map.layer
  while (g.firstChild) g.removeChild(g.firstChild)
  const saved = root
  root = g
  R(MAP.x, MAP.y, MAP.w, MAP.h, C.sea)
  // tiles: OpenStreetMap (darkened) with OpenSeaMap seamarks on top
  const z = map.zoom
  const cx = lon2x(map.center.longitude, z); const cy = lat2y(map.center.latitude, z)
  const left = cx - MAP.w / 2; const topPx = cy - MAP.h / 2
  const n = 2 ** z
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + MAP.w) / TILE); tx++) {
    for (let ty = Math.floor(topPx / TILE); ty <= Math.floor((topPx + MAP.h) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue
      const x = MAP.x + tx * TILE - left; const y = MAP.y + ty * TILE - topPx
      const wx = ((tx % n) + n) % n
      const osm = el('image', { href: `https://tile.openstreetmap.org/${z}/${wx}/${ty}.png`, x, y, width: TILE, height: TILE, style: 'filter: invert(1) hue-rotate(180deg) brightness(0.8) contrast(0.85) saturate(0.6)' })
      osm.addEventListener('error', () => { osm.remove(); if (!map.tileError) { map.tileError = true; drawMap() } })
      if (z >= 9) {
        const sea = el('image', { href: `https://tiles.openseamap.org/seamark/${z}/${wx}/${ty}.png`, x, y, width: TILE, height: TILE })
        sea.addEventListener('error', () => sea.remove())
      }
    }
  }
  // warnings
  const trip = state.passage && state.passage.trip
  for (const w of state.warnings || []) {
    const onRoute = trip ? (w.relevance === 'route' || w.relevance === 'here') : (w.relevance === 'here' || w.relevance === 'nearby')
    if (!onRoute && w.relevance !== 'nearby' && w.relevance !== 'route') continue
    const col = warningColor(w, onRoute)
    const geo = w.geometry || {}
    if (geo.polygon && geo.polygon.length >= 3) {
      el('path', { d: P(geo.polygon.map(toScreen)) + 'Z', fill: col, 'fill-opacity': 0.18, stroke: col, 'stroke-width': 2, 'stroke-dasharray': '6 4' })
    }
    if (geo.circle) {
      const c = toScreen(geo.circle.center)
      const edge = toScreen({ latitude: geo.circle.center.latitude + geo.circle.radiusNm / 60, longitude: geo.circle.center.longitude })
      el('circle', { cx: c[0], cy: c[1], r: Math.abs(c[1] - edge[1]), fill: col, 'fill-opacity': 0.18, stroke: col, 'stroke-width': 2 })
    }
    for (const p of geo.positions || []) {
      const [x, y] = toScreen(p)
      el('path', { d: `M${x} ${y - 9} L${x + 8} ${y} L${x} ${y + 9} L${x - 8} ${y} Z`, fill: col, stroke: C.bg, 'stroke-width': 1.5 })
    }
  }
  // route
  const pts = routePoints()
  if (pts.length > 1) {
    el('path', { d: P(pts.map(toScreen)), fill: 'none', stroke: C.blue, 'stroke-width': 4, 'stroke-dasharray': '10 6', 'stroke-linejoin': 'round' })
    pts.slice(1, -1).forEach(p => { const [x, y] = toScreen(p); el('circle', { cx: x, cy: y, r: 6, fill: C.text, stroke: C.blue, 'stroke-width': 2 }) })
    const [tx, ty] = toScreen(pts[pts.length - 1])
    el('path', { d: `M${tx} ${ty} C${tx - 8} ${ty - 12} ${tx - 11} ${ty - 18} ${tx - 11} ${ty - 24} A11 11 0 0 1 ${tx + 11} ${ty - 24} C${tx + 11} ${ty - 18} ${tx + 8} ${ty - 12} ${tx} ${ty} Z`, fill: C.red })
    el('circle', { cx: tx, cy: ty - 24, r: 4, fill: C.bg })
  }
  // boat
  const boat = state.passage && state.passage.boat
  if (boat && boat.position) {
    const [bx, by] = toScreen(boat.position)
    const bg = el('g', { transform: `translate(${bx} ${by}) rotate(${typeof boat.heading === 'number' ? boat.heading : 0})` })
    el('path', { d: 'M0 -13 L8 10 L0 5 L-8 10 Z', fill: C.green, stroke: C.bg, 'stroke-width': 1.5 }, null, bg)
  }
  // capture layer for pan / tap
  const cap = R(MAP.x, MAP.y, MAP.w, MAP.h, 'transparent', { style: 'touch-action: none' })
  cap.addEventListener('pointerdown', mapPointerDown)
  // controls
  const btn = (x, y, w, label, fn) => { R(x, y, w, 40, 'rgba(11,21,32,0.85)', { rx: 8, stroke: C.line, 'stroke-width': 1.5 }); T(x + w / 2, y + 27, label, 18, C.text, { 'text-anchor': 'middle' }); tap(R(x, y, w, 40, 'transparent'), fn) }
  btn(MAP.x + MAP.w - 52, MAP.y + 12, 40, '+', () => { map.zoom = Math.min(16, map.zoom + 1); drawMap() })
  btn(MAP.x + MAP.w - 52, MAP.y + 58, 40, '−', () => { map.zoom = Math.max(5, map.zoom - 1); drawMap() })
  btn(MAP.x + 12, MAP.y + 12, 110, 'Harbours', openPicker)
  if (pts.length > 1) {
    btn(MAP.x + 12, MAP.y + MAP.h - 52, 84, 'Undo', undoWaypoint)
    btn(MAP.x + 104, MAP.y + MAP.h - 52, 84, 'Clear', clearTrip)
  } else {
    R(MAP.x + 12, MAP.y + MAP.h - 46, 330, 30, 'rgba(11,21,32,0.85)', { rx: 6 })
    T(MAP.x + 24, MAP.y + MAP.h - 26, 'Tap the chart to add waypoints', 16, C.soft)
  }
  if (map.tileError) T(MAP.x + MAP.w / 2, MAP.y + 36, 'Chart tiles need internet', 16, C.muted, { 'text-anchor': 'middle' })
  T(MAP.x + MAP.w - 8, MAP.y + MAP.h - 6, '© OpenStreetMap · OpenSeaMap', 11, C.muted, { 'text-anchor': 'end' })
  root = saved
}

function svgPoint (e) {
  const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY
  return pt.matrixTransform(svg.getScreenCTM().inverse())
}
function mapPointerDown (e) {
  const p = svgPoint(e)
  map.drag = { x: p.x, y: p.y, cx: lon2x(map.center.longitude, map.zoom), cy: lat2y(map.center.latitude, map.zoom), moved: false }
  window.addEventListener('pointermove', mapPointerMove)
  window.addEventListener('pointerup', mapPointerUp, { once: true })
}
let raf = null
function mapPointerMove (e) {
  const d = map.drag
  if (!d) return
  const p = svgPoint(e)
  const dx = p.x - d.x; const dy = p.y - d.y
  if (!d.moved && Math.hypot(dx, dy) < 8) return
  d.moved = true
  map.center = { longitude: x2lon(d.cx - dx, map.zoom), latitude: y2lat(d.cy - dy, map.zoom) }
  if (!raf) raf = requestAnimationFrame(() => { raf = null; drawMap() })
}
function mapPointerUp (e) {
  window.removeEventListener('pointermove', mapPointerMove)
  const d = map.drag
  map.drag = null
  if (!d || d.moved) return
  const p = svgPoint(e)
  addWaypoint(fromScreen(p.x, p.y))
}

function renderPassage () {
  const ps = state.passage
  T(40, 44, 'Passage', 30, C.text, { 'font-weight': 500 })
  const p = localParts(ps.now)
  T(1240, 44, `${p.weekday} ${p.day} ${p.month} · ${clock(ps.now)}`, 22, C.muted, { 'text-anchor': 'end' })

  // chart
  const defs = el('defs', {})
  const cp = el('clipPath', { id: 'mapclip' }, null, defs)
  el('rect', { x: MAP.x, y: MAP.y, width: MAP.w, height: MAP.h, rx: 12 }, null, cp)
  map.layer = el('g', { 'clip-path': 'url(#mapclip)' })
  const pts = routePoints()
  const key = JSON.stringify(pts)
  if (!map.center || key !== map.routeKey) { fitMap(pts.length ? pts : [ps.boat.position]); map.routeKey = key }
  drawMap()

  panel(636, 66, 624, 400)
  const tr = ps.trip
  if (tr) tripPanel(ps, tr)
  else pickPanel(ps)

  // along the route
  panel(20, 478, 840, 266)
  T(40, 506, 'Along the route · kn', 18, C.text, { 'font-weight': 500 })
  if (tr) {
    T(840, 506, `where you are each hour at ${fmtNum(tr.speedKn)} kn`, 15, C.muted, { 'text-anchor': 'end' })
    let rows = tr.hours.filter(h => !h.arrival)
    if (rows.length > 10) { const step = Math.ceil(rows.length / 10); rows = rows.filter((r, i) => i % step === 0) }
    const x0 = 60; const cw = 780 / Math.max(rows.length, 5)
    gustBars(rows.map(r => ({ w: r.windKn, g: r.gustKn })), { x0, cw, base: 678, top: 574, bw: Math.min(cw * 0.5, 64), ...thresholdOpts(ps.thresholds) })
    rows.forEach((r, i) => {
      const cx = x0 + cw * i + cw / 2
      T(cx, 530, hh(r.time), 17, C.text, { 'text-anchor': 'middle', 'font-weight': 500 })
      T(cx, 546, `${Math.round(r.distanceNm)} nm`, 13, C.dim, { 'text-anchor': 'middle' })
      arrowAt(cx, 566, r.windDir)
      fit(T(cx, 700, r.pointOfSail || '', 14, C.muted, { 'text-anchor': 'middle' }), cw - 6, 11)
      drops(cx, 726, r.rainLevel || 0)
    })
  } else {
    T(40, 600, 'Choose a target to see wind, gusts and rain', 20, C.muted)
    T(40, 630, 'for every hour of the way, where you will be at that time.', 20, C.muted)
  }

  // warnings on the route
  panel(876, 478, 384, 266)
  T(896, 506, tr ? 'Warnings on this route' : 'Warnings near you', 18, C.text, { 'font-weight': 500 })
  routeWarnings(!!tr)
  nav('passage')
}

function tripPanel (ps, tr) {
  fit(T(660, 108, tr.name, 38, C.text, { 'font-weight': 500 }), 580, 26)
  const legs = tr.route.length - 1
  T(660, 142, `${fmtNum(tr.distanceNm)} nm${legs > 1 ? ` · ${legs} legs` : ''} · ${durationText(tr.durationH)}`, 20, C.soft)
  const depLabel = dayKey(tr.departure) === dayKey(ps.now) ? clock(tr.departure) : `${localParts(tr.departure).weekday} ${clock(tr.departure)}`
  const etaLabel = dayKey(tr.eta) === dayKey(tr.departure) ? clock(tr.eta) : `${localParts(tr.eta).weekday} ${clock(tr.eta)}`
  stepper(660, 'Depart', depLabel, () => setTrip({ departure: new Date(Date.parse(tr.departure) - 30 * 60e3).toISOString() }), () => setTrip({ departure: new Date(Date.parse(tr.departure) + 30 * 60e3).toISOString() }))
  stepper(870, 'Speed', `${fmtNum(tr.speedKn)} kn`, () => setTrip({ speedKn: Math.max(2, tr.speedKn - 0.5) }), () => setTrip({ speedKn: Math.min(9, tr.speedKn + 0.5) }))
  T(1060, 184, 'Arrive', 16, C.muted)
  R(1060, 194, 180, 52, C.bg, { rx: 8 })
  fit(T(1150, 229, etaLabel, 22, C.text, { 'text-anchor': 'middle', 'font-weight': 500 }), 170, 16)

  const v = tr.verdict
  const vBg = v.level === 'stay' ? '#4a1717' : v.level === 'caution' ? '#4a3510' : '#0f3a2c'
  const vTx = v.level === 'stay' ? C.redText : v.level === 'caution' ? C.amberText : C.greenText
  R(660, 266, 580, 60, vBg, { rx: 10 })
  fit(T(680, 304, [v.text, tr.front && tr.front.text].filter(Boolean).join(' · '), 22, vTx, { 'font-weight': 500 }), 540, 16)

  T(660, 360, 'Better departure', 17, C.muted)
  const da = tr.departureAdvice || {}
  if (da.better) {
    const b = da.better
    const when = `${b.day === 'today' ? '' : 'Tomorrow '}${clock(b.departure)}`
    const line = fit(T(660, 392, `${when} → arrive ${clock(b.eta)} · ${b.reason}`, 20, C.green, { 'font-weight': 500 }), 520, 15)
    T(1240, 392, 'Use', 18, C.blue, { 'text-anchor': 'end', 'font-weight': 500 })
    tap(R(656, 368, 588, 34, 'transparent'), () => setTrip({ departure: b.departure }))
    line.setAttribute('class', 'tap')
  } else {
    T(660, 392, 'Your departure is the best time today and tomorrow.', 19, C.soft)
  }
  const extra = []
  if (tr.sunsetMarginMin !== null) extra.push(tr.sunsetMarginMin >= 0 ? `Arrival ${durationText(tr.sunsetMarginMin / 60)} before sunset` : `Arrival ${durationText(-tr.sunsetMarginMin / 60)} after sunset`)
  const adv = (tr.advice || []).filter(a => a.type !== 'reef' && a.type !== 'darkness').map(a => a.text)
  if (adv.length) extra.push(adv.join(', '))
  if (extra[0]) fit(T(660, 426, extra[0], 18, tr.sunsetMarginMin !== null && tr.sunsetMarginMin < 30 ? C.amberText : C.soft), 580, 14)
  if (extra[1]) fit(T(660, 452, extra[1].replace(/^./, c => c.toUpperCase()), 18, C.soft), 580, 14)
}

function durationText (h) {
  const hrs = Math.floor(h); const min = Math.round((h - hrs) * 60)
  return hrs ? `${hrs}h${String(min).padStart(2, '0')}` : `${min} min`
}

function stepper (x, label, value, minus, plus) {
  T(x, 184, label, 16, C.muted)
  R(x, 194, 180, 52, C.bg, { rx: 8, stroke: C.line, 'stroke-width': 2 })
  T(x + 18, 229, '−', 26, C.muted)
  T(x + 162, 229, '+', 26, C.muted, { 'text-anchor': 'end' })
  fit(T(x + 90, 229, value, 21, C.text, { 'text-anchor': 'middle', 'font-weight': 500 }), 110, 14)
  tap(R(x, 194, 60, 52, 'transparent'), minus)
  tap(R(x + 120, 194, 60, 52, 'transparent'), plus)
}

function pickPanel (ps) {
  T(660, 108, 'Where to?', 38, C.text, { 'font-weight': 500 })
  T(660, 142, 'Tap the chart to add waypoints — the last one is your target.', 18, C.soft)
  T(660, 168, 'Or pick a harbour:', 18, C.soft)
  const here = ps.boat.position
  const list = ps.destinations.filter(d => !here || distNm(here, d) > 1.5).slice(0, 8)
  list.forEach((d, i) => {
    const x = 660 + (i % 2) * 292; const y = 186 + Math.floor(i / 2) * 66
    R(x, y, 280, 56, C.bg, { rx: 10, stroke: C.line, 'stroke-width': 2 })
    fit(T(x + 16, y + 26, d.name, 19, C.text), 250, 14)
    if (here) T(x + 16, y + 46, `${Math.round(distNm(here, d))} nm direct`, 14, C.muted)
    tap(R(x, y, 280, 56, 'transparent'), () => setTrip({ destination: d.name }, true))
  })
}

function routeWarnings (hasTrip) {
  if (!state.warnings) {
    T(896, 550, 'Warnings plugin not reachable.', 17, C.muted)
    T(896, 576, 'Enable Baltic Warnings in Signal K.', 17, C.muted)
    return
  }
  const onRoute = w => (hasTrip ? (w.relevance === 'route' || w.relevance === 'here') : (w.relevance === 'here' || w.relevance === 'nearby'))
  const rank = { alarm: 4, emergency: 4, warn: 3, alert: 2 }
  const main = state.warnings.filter(onRoute).sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0))
  const side = hasTrip ? state.warnings.filter(w => w.relevance === 'nearby').sort((a, b) => (a.distanceNm ?? 99) - (b.distanceNm ?? 99)) : []
  const list = main.concat(side).slice(0, 4)
  if (!list.length) {
    T(896, 556, hasTrip ? 'Nothing on this route.' : 'Nothing near you.', 19, C.green)
    return
  }
  list.forEach((w, i) => {
    const y = 526 + i * 52
    const isMain = main.includes(w)
    R(896, y, 8, 40, warningColor(w, isMain))
    fit(T(916, y + 17, smartCase(w.title), 17, isMain ? C.text : C.muted, { 'font-weight': 500 }), 326, 13)
    let where
    if (w.areaOnly && (w.routeDistanceNm === 0 || w.distanceNm === 0)) where = hasTrip ? 'whole passage area' : 'your sea area'
    else if (isMain && hasTrip && typeof w.routeDistanceNm === 'number') where = `${w.routeDistanceNm} nm from route`
    else if (typeof w.distanceNm === 'number') where = hasTrip ? `${Math.round(w.distanceNm)} nm away, not on route` : `${Math.round(w.distanceNm)} nm away`
    fit(T(916, y + 37, [w.label, where].filter(Boolean).join(' · '), 15, C.muted), 326, 12)
  })
  const rest = main.length + side.length - list.length
  if (rest > 0) T(1240, 736, `+${rest} more`, 14, C.muted, { 'text-anchor': 'end' })
}

// ---------------------------------------------------------------- Instruments
function renderInstruments () {
  const b = state.brief
  T(40, 44, 'Instruments', 30, C.text, { 'font-weight': 500 })
  T(1240, 44, `${clock(b.now)}`, 22, C.muted, { 'text-anchor': 'end' })
  const s = 1.35
  const g = el('g', { transform: `translate(${20 - 796 * s} ${66 - 138 * s}) scale(${s})` })
  const saved = root; root = g; windTile(b); root = saved

  // boat
  panel(20, 556, 626, 186)
  const st = b.place.state
  T(40, 592, st === 'anchored' ? `At anchor · ${b.place.name}` : st === 'underway' ? 'Under way' : `Moored · ${b.place.name}`, 22, C.green, { 'font-weight': 500 })
  const rows = []
  if (st === 'anchored' && b.boat.anchor) rows.push(`Anchor: ${b.boat.anchor.currentRadius ?? '–'} m from the anchor, alarm at ${b.boat.anchor.maxRadius ?? '–'} m`)
  if (b.boat.overnightMax) rows.push(`Max wind last 12 h: ${b.boat.overnightMax.kn} kn at ${clock(b.boat.overnightMax.at)}`)
  if (typeof b.boat.cabinTemp === 'number') rows.push(`Cabin ${fmtNum(b.boat.cabinTemp)} °C${typeof b.boat.cabinHumidity === 'number' ? ` · humidity ${b.boat.cabinHumidity} %` : ''}`)
  const lg = b.log || {}
  if (lg.today && lg.today.distanceNm > 0) rows.push(`Today ${fmtNum(lg.today.distanceNm)} nm · ${fmtNum(lg.today.underwayH)} h under way`)
  if (lg.yesterday && lg.yesterday.distanceNm > 0) rows.push(`Yesterday ${fmtNum(lg.yesterday.distanceNm)} nm · ${fmtNum(lg.yesterday.underwayH)} h`)
  rows.slice(0, 4).forEach((r, i) => fit(T(40, 630 + i * 30, r, 19, C.soft), 590, 14))

  batteryPanel(b)
  barometerPanel(b)
  nav('instruments')
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
    if (typeof p.twd === 'number') arrowAt(x, 436, p.twd, i === 6 ? C.blue : C.soft, sc * 1.15)
    T(x, 464, typeof p.tws === 'number' ? `${Math.round(p.tws)} kn` : '–', 16, i === 6 ? C.text : C.soft, { 'text-anchor': 'middle', 'font-weight': i === 6 ? 500 : 400 })
    T(x, 482, labels[i], 13, C.muted, { 'text-anchor': 'middle' })
  })
}

function batteryPanel (b) {
  panel(662, 66, 598, 230)
  T(682, 100, 'House bank', 22, C.text, { 'font-weight': 500 })
  const bt = b.battery
  if (!bt) { T(682, 160, 'No battery data yet.', 20, C.muted); T(682, 190, 'Check signalk-victron-ble (SmartShunt).', 17, C.muted); return }
  const soc = typeof bt.soc === 'number' ? bt.soc : null
  const r = 64; const circ = 2 * Math.PI * r
  el('circle', { cx: 762, cy: 196, r, fill: 'none', stroke: C.line, 'stroke-width': 16 })
  if (soc !== null) el('circle', { cx: 762, cy: 196, r, fill: 'none', stroke: soc < 50 ? C.red : soc < 65 ? C.amber : C.green, 'stroke-width': 16, 'stroke-linecap': 'round', 'stroke-dasharray': `${circ * soc / 100} ${circ}`, transform: 'rotate(-90 762 196)' })
  T(762, 208, soc === null ? '–' : `${soc}%`, 34, C.text, { 'text-anchor': 'middle', 'font-weight': 500 })
  const left = typeof bt.timeRemainingS === 'number' ? (() => { const h = Math.floor(bt.timeRemainingS / 3600); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h` })() : '–'
  ;[['Voltage', `${fmtNum(bt.voltage, 2)} V`, C.text], ['Current', `${fmtNum(bt.current)} A`, (bt.current || 0) < 0 ? C.redBright : C.green], ['Used', typeof bt.consumedAh === 'number' ? `${bt.consumedAh} Ah` : '–', C.text], ['Time to go', left, C.text]].forEach(([l, v, col], i) => {
    const y = 140 + i * 38
    T(870, y, l, 17, C.muted)
    T(1240, y, v, 22, col, { 'text-anchor': 'end', 'font-weight': 500 })
  })
}

function barometerPanel (b) {
  panel(662, 306, 598, 436)
  T(682, 340, 'Barometer · 24 h', 22, C.text, { 'font-weight': 500 })
  const br = b.barometer || {}
  const cur = T(1240, 342, typeof br.current === 'number' ? fmtNum(br.current) + ' ' : '–', 30, C.text, { 'text-anchor': 'end', 'font-weight': 500 })
  if (typeof br.current === 'number') el('tspan', { 'font-size': 17, fill: C.muted }, 'hPa', cur)
  if (typeof br.change3h === 'number') {
    const label = `${br.label} · ${br.change3h > 0 ? '+' : ''}${fmtNum(br.change3h)} hPa / 3 h`.replace(/^./, c => c.toUpperCase())
    const sev = br.severity
    R(682, 360, 556, 40, sev === 'alert' ? '#4a3510' : sev ? '#4a1717' : C.panel2, { rx: 8 })
    T(960, 387, label, 19, sev === 'alert' ? C.amberText : sev ? C.redBright : C.soft, { 'text-anchor': 'middle', 'font-weight': 500 })
  } else {
    T(682, 386, 'The 3-hour trend appears after 2½ hours of data.', 17, C.muted)
  }
  const series = br.series || []
  if (series.length < 2) { T(682, 560, 'Collecting pressure history…', 18, C.muted); return }
  const vals = series.map(s => s.hPa)
  const mn = Math.floor(Math.min(...vals) - 1); const mx = Math.ceil(Math.max(...vals) + 1)
  const x0 = 730; const x1 = 1236; const y0 = 420; const y1 = 700
  const t0 = Date.parse(b.now) - 24 * 3600e3; const t1 = Date.parse(b.now)
  const X = t => x0 + (x1 - x0) * (Date.parse(t) - t0) / (t1 - t0)
  const Y = v => y1 - (y1 - y0) * (v - mn) / (mx - mn)
  const step = Math.max(1, Math.round((mx - mn) / 4))
  for (let v = mn; v <= mx; v += step) { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: C.grid }); T(x0 - 8, Y(v) + 5, v, 14, C.dim, { 'text-anchor': 'end' }) }
  R(X(new Date(t1 - 3 * 3600e3).toISOString()), y0, x1 - X(new Date(t1 - 3 * 3600e3).toISOString()), y1 - y0, br.severity ? C.red : C.line, { 'fill-opacity': 0.15 })
  el('path', { d: P(series.map(s => [X(s.t), Y(s.hPa)])), fill: 'none', stroke: C.blue, 'stroke-width': 4, 'stroke-linejoin': 'round' })
  ;[[0, '−24h'], [12, '−12h'], [21, '−3h'], [24, 'now']].forEach(([h, l]) => T(x0 + (x1 - x0) * h / 24, 726, l, 14, C.muted, { 'text-anchor': h === 24 ? 'end' : h === 0 ? 'start' : 'middle' }))
}

// ---------------------------------------------------------------- shared bits
function header (title, right) {
  T(40, 44, title, 30, C.text, { 'font-weight': 500 })
  if (right) fit(T(1240, 44, right, 20, C.muted, { 'text-anchor': 'end' }), 560, 14)
}
function button (x, y, w, h, label, fn, { active = false, size = 17, primary = false } = {}) {
  R(x, y, w, h, primary ? C.blue : active ? '#16304a' : C.bg, { rx: 8, stroke: active ? C.blue : C.line, 'stroke-width': 2 })
  fit(T(x + w / 2, y + h / 2 + size * 0.35, label, size, primary ? '#04223a' : C.text, { 'text-anchor': 'middle', 'font-weight': primary || active ? 500 : 400 }), w - 12, 11)
  tap(R(x, y, w, h, 'transparent'), fn)
}
// Wraps text into lines that fit maxW; returns the y after the last line
function wrap (x, y, text, size, fill, maxW, lineH, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  let line = ''; let n = 0; let t = T(x, y, '', size, fill)
  for (const w of words) {
    const test = line ? line + ' ' + w : w
    t.textContent = test
    if (t.getComputedTextLength() > maxW && line) {
      t.textContent = line
      n++
      if (n >= maxLines) { t.textContent = line + ' …'; return y + n * lineH }
      line = w
      t = T(x, y + n * lineH, w, size, fill)
    } else line = test
  }
  t.textContent = line
  return y + (n + 1) * lineH
}
function pager (x, y, page, pages, onChange) {
  if (pages <= 1) return
  button(x, y, 52, 40, '▲', () => onChange(Math.max(0, page - 1)))
  T(x + 86, y + 26, `${page + 1}/${pages}`, 15, C.muted, { 'text-anchor': 'middle' })
  button(x + 120, y, 52, 40, '▼', () => onChange(Math.min(pages - 1, page + 1)))
}
const weekdayLabel = iso => { const p = localParts(iso); return `${p.weekday} ${p.day} ${p.month}` }
function fmtPos (p) {
  if (!p || typeof p.latitude !== 'number') return '–'
  const f = (v, a, b) => `${Math.floor(Math.abs(v))}°${(Math.abs(v) % 1 * 60).toFixed(2).padStart(5, '0')}′${v >= 0 ? a : b}`
  return `${f(p.latitude, 'N', 'S')} ${f(p.longitude, 'E', 'W')}`
}

// ---------------------------------------------------------------- Weather
function renderWeather () {
  const w = state.weather
  header(`Weather · ${w.place}`, w.forecast.updated ? `Open-Meteo · updated ${clock(w.forecast.updated)}` : (w.forecast.error || ''))
  const th = thresholdOpts(w.thresholds)
  const hrs = w.hours
  panel(20, 66, 1240, 300)
  T(40, 92, '48 hours · wind and gusts, kn', 16, C.muted)
  if (!hrs.length) { T(40, 220, 'No forecast yet.', 20, C.muted); nav('weather'); return }
  const x0 = 60; const cw = 1180 / hrs.length
  const t0 = Date.parse(hrs[0].time)
  const xOf = t => x0 + cw * ((Date.parse(t) - t0) / 3600e3) + cw / 2
  // nights
  const suns = w.days.map(d => [Date.parse(d.sunrise), Date.parse(d.sunset)])
  const tEnd = Date.parse(hrs[hrs.length - 1].time) + 3600e3
  let nightFrom = t0 - 3600e3
  for (const [rise, set] of suns.concat([[tEnd + 86400e3, tEnd + 86400e3]])) {
    const a = Math.max(nightFrom, t0 - 1800e3); const b = Math.min(rise, tEnd)
    if (b > a) R(Math.max(30, xOf(new Date(a).toISOString())), 100, Math.min(1250, xOf(new Date(b).toISOString())) - Math.max(30, xOf(new Date(a).toISOString())), 256, '#000', { opacity: 0.28 })
    nightFrom = set
  }
  gustBars(hrs.map(h => ({ w: h.windKn, g: h.gustKn })), { x0, cw, base: 316, top: 150, bw: cw * 0.62, labelEvery: 3, ...th })
  hrs.forEach((h, i) => {
    const cx = x0 + cw * i + cw / 2
    if (i % 3 === 0) { arrowAt(cx, 132, h.windDir, C.soft, 0.85); T(cx, 340, `${h.hour}h`, 13, C.muted, { 'text-anchor': 'middle' }) }
    if (h.hour === 0 && i > 0) {
      el('line', { x1: cx - cw / 2, x2: cx - cw / 2, y1: 100, y2: 350, stroke: C.line, 'stroke-width': 2 })
      T(cx - cw / 2 + 6, 116, weekdayLabel(h.time), 14, C.soft)
    }
  })
  T(x0, 116, weekdayLabel(hrs[0].time), 14, C.soft)

  // rain and waves
  panel(20, 376, 820, 180)
  T(40, 402, 'Rain mm/h', 16, C.muted)
  T(820, 402, 'waves m', 16, C.amber, { 'text-anchor': 'end' })
  const bx0 = 60; const bcw = 760 / hrs.length; const by = 532; const btop = 420
  const RY = v => by - (by - btop) * Math.min(v, 4) / 4
  const WY = v => by - (by - btop) * Math.min(v, 2.5) / 2.5
  ;[1, 2, 3].forEach(v => { el('line', { x1: bx0, x2: bx0 + 760, y1: RY(v), y2: RY(v), stroke: C.grid }); T(bx0 - 8, RY(v) + 5, v, 12, C.dim, { 'text-anchor': 'end' }) })
  hrs.forEach((h, i) => {
    const x = bx0 + bcw * i
    if ((h.rainMm || 0) >= 0.1) R(x + 1, RY(h.rainMm), bcw - 2, by - RY(h.rainMm), h.rainMm >= 1 ? C.blue : C.lightBlue, { rx: 1 })
    if (i % 6 === 0) T(x + bcw / 2, 550, `${h.hour}h`, 12, C.muted, { 'text-anchor': 'middle' })
  })
  const wv = hrs.map((h, i) => [bx0 + bcw * i + bcw / 2, h.waveM]).filter(p => typeof p[1] === 'number')
  if (wv.length > 1) {
    el('path', { d: P(wv.map(p => [p[0], WY(p[1])])), fill: 'none', stroke: C.amber, 'stroke-width': 2.5 })
    const top = wv.reduce((a, p) => (p[1] > a[1] ? p : a), wv[0])
    T(Math.min(top[0], 800), WY(top[1]) - 8, `${top[1]} m`, 13, C.amber, { 'text-anchor': 'middle' })
  }
  const totalRain = hrs.reduce((a, h) => a + (h.rainMm || 0), 0)
  if (totalRain < 0.2) T(440, 480, 'Dry for the next 48 hours', 18, C.green, { 'text-anchor': 'middle' })

  // pressure: measured + forecast
  panel(20, 566, 820, 176)
  T(40, 592, 'Pressure hPa · measured (solid) and forecast (dashed)', 16, C.muted)
  const pm = w.pressure.measured || []; const pf = w.pressure.forecast || []
  const all = pm.map(p => p.hPa).concat(pf.map(p => p.hPa))
  if (all.length > 1) {
    const mn = Math.floor(Math.min(...all) - 1); const mx = Math.ceil(Math.max(...all) + 1)
    const nowT = Date.parse(w.now); const px0 = 80; const px1 = 820; const py0 = 606; const py1 = 716
    const PX = t => px0 + (px1 - px0) * (Date.parse(t) - (nowT - 24 * 3600e3)) / (72 * 3600e3)
    const PY = v => py1 - (py1 - py0) * (v - mn) / (mx - mn)
    const step = Math.max(2, Math.round((mx - mn) / 3))
    for (let v = mn; v <= mx; v += step) { el('line', { x1: px0, x2: px1, y1: PY(v), y2: PY(v), stroke: C.grid }); T(px0 - 8, PY(v) + 5, v, 12, C.dim, { 'text-anchor': 'end' }) }
    if (pm.length > 1) el('path', { d: P(pm.map(p => [PX(p.t), PY(p.hPa)])), fill: 'none', stroke: C.blue, 'stroke-width': 3.5 })
    if (pf.length > 1) el('path', { d: P(pf.map(p => [PX(p.t), PY(p.hPa)])), fill: 'none', stroke: C.blue, 'stroke-width': 2.5, 'stroke-dasharray': '7 5' })
    const nx = PX(w.now)
    el('line', { x1: nx, x2: nx, y1: py0, y2: py1, stroke: C.text, 'stroke-dasharray': '4 4' })
    T(nx + 5, py0 + 10, 'now', 12, C.text)
    const low = w.pressure.low
    if (low && low.hPa < (pf[0] ? pf[0].hPa : 9999) - 1) T(PX(low.t), PY(low.hPa) + 18, `low ${Math.round(low.hPa)} · ${localParts(low.t).weekday} ${hh(low.t)}`, 13, C.redText, { 'text-anchor': 'middle' })
    ;[[-24, '−24h'], [0, ''], [24, '+24h'], [48, '+48h']].forEach(([h, l]) => { if (l) T(px0 + (px1 - px0) * (h + 24) / 72, 734, l, 12, C.muted, { 'text-anchor': h === 48 ? 'end' : 'middle' }) })
  }

  // next days
  panel(856, 376, 404, 366)
  T(876, 404, 'Next days', 18, C.text, { 'font-weight': 500 })
  w.days.forEach((d, i) => {
    const y = 420 + i * 106
    if (i) el('line', { x1: 876, x2: 1240, y1: y, y2: y, stroke: C.line })
    el('circle', { cx: 884, cy: y + 30, r: 7, fill: levelFill(d.level === 'green' ? 'green' : d.level) })
    T(900, y + 36, d.label, 20, C.text, { 'font-weight': 500 })
    arrowAt(1226, y + 30, d.windDir, C.soft, 1.1)
    const bft = d.bft.min === d.bft.max ? `${d.bft.min}` : `${d.bft.min}–${d.bft.max}`
    fit(T(900, y + 62, `${d.windFrom} ${bft} Bft · ${d.windKn.min}–${d.windKn.max} kn · gusts ${d.gustMaxKn}`, 16, C.soft), 330, 12)
    const rain = d.rainMm >= 0.2 ? `rain ${d.rainMm} mm` : 'dry'
    fit(T(900, y + 86, `${rain}${d.waveMaxM !== null ? ` · waves ${d.waveMaxM} m` : ''} · ☀ ${clock(d.sunrise)}–${clock(d.sunset)}`, 15, C.muted), 340, 11)
  })
  nav('weather')
}

// ---------------------------------------------------------------- Battery
function renderBattery () {
  const b = state.battery
  header('Battery · house bank', b.live ? `SmartShunt · ${clock(b.now)}` : 'no live data')
  panel(20, 66, 840, 350)
  T(40, 92, 'State of charge · 7 days', 16, C.muted)
  const s = b.series || []
  const x0 = 80; const x1 = 840; const y0 = 110; const y1 = 370
  const nowT = Date.parse(b.now); const t0 = nowT - 7 * 86400e3
  const X = t => x0 + (x1 - x0) * (Date.parse(t) - t0) / (nowT - t0)
  const Y = v => y1 - (y1 - y0) * v / 100
  ;[25, 50, 75, 100].forEach(v => { el('line', { x1: x0, x2: x1, y1: Y(v), y2: Y(v), stroke: v === 50 ? C.red : C.grid, 'stroke-dasharray': v === 50 ? '8 6' : null, opacity: v === 50 ? 0.7 : 1 }); T(x0 - 8, Y(v) + 5, `${v}%`, 13, v === 50 ? C.redText : C.dim, { 'text-anchor': 'end' }) })
  if (s.length > 1) {
    el('path', { d: P(s.map(p => [X(p.t), Y(p.soc)])) + `L${X(s[s.length - 1].t)} ${y1}L${X(s[0].t)} ${y1}Z`, fill: C.green, 'fill-opacity': 0.12 })
    el('path', { d: P(s.map(p => [X(p.t), Y(p.soc)])), fill: 'none', stroke: C.green, 'stroke-width': 3, 'stroke-linejoin': 'round' })
  } else T(460, 250, 'The curve fills while Sailpartner runs.', 18, C.muted, { 'text-anchor': 'middle' })
  b.days.forEach((d, i) => T(x0 + (x1 - x0) * (i + 0.5) / 7, 396, d.label, 14, C.muted, { 'text-anchor': 'middle' }))

  panel(20, 426, 840, 316)
  T(40, 452, 'Charged and used per day · Ah', 16, C.muted)
  T(840, 452, 'green charged · red used', 14, C.muted, { 'text-anchor': 'end' })
  const vals = b.days.flatMap(d => [d.chargedAh || 0, d.usedAh || 0])
  const mx = Math.max(20, ...vals)
  const base = 590; const hMax = 110
  el('line', { x1: 60, x2: 840, y1: base, y2: base, stroke: C.dim })
  b.days.forEach((d, i) => {
    const cx = 60 + 780 * (i + 0.5) / 7
    if (d.chargedAh !== null) {
      const hc = hMax * d.chargedAh / mx; const hu = hMax * d.usedAh / mx
      R(cx - 30, base - hc, 26, hc, C.green, { rx: 3 })
      R(cx + 4, base, 26, hu, C.red, { rx: 3 })
      T(cx - 17, base - hc - 6, d.chargedAh, 13, C.greenText, { 'text-anchor': 'middle' })
      T(cx + 17, base + hu + 16, d.usedAh, 13, C.redText, { 'text-anchor': 'middle' })
    } else T(cx, base - 8, '–', 14, C.dim, { 'text-anchor': 'middle' })
    T(cx, 732, d.label, 14, C.muted, { 'text-anchor': 'middle' })
  })

  panel(876, 66, 384, 676)
  const lv = b.live
  const soc = lv && typeof lv.soc === 'number' ? lv.soc : null
  const r = 80; const circ = 2 * Math.PI * r
  el('circle', { cx: 1068, cy: 200, r, fill: 'none', stroke: C.line, 'stroke-width': 20 })
  if (soc !== null) el('circle', { cx: 1068, cy: 200, r, fill: 'none', stroke: soc < 50 ? C.red : soc < 65 ? C.amber : C.green, 'stroke-width': 20, 'stroke-linecap': 'round', 'stroke-dasharray': `${circ * soc / 100} ${circ}`, transform: 'rotate(-90 1068 200)' })
  T(1068, 214, soc === null ? '–' : `${soc}%`, 42, C.text, { 'text-anchor': 'middle', 'font-weight': 500 })
  const left = lv && typeof lv.timeRemainingS === 'number' ? (() => { const h = Math.floor(lv.timeRemainingS / 3600); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h` })() : '–'
  const rows = [
    ['Voltage', lv ? `${fmtNum(lv.voltage, 2)} V` : '–', C.text],
    ['Current', lv ? `${fmtNum(lv.current)} A` : '–', lv && (lv.current || 0) < 0 ? C.redBright : C.green],
    ['Power', lv && typeof lv.power === 'number' ? `${lv.power} W` : '–', C.text],
    ['Used since full', lv && typeof lv.consumedAh === 'number' ? `${lv.consumedAh} Ah` : '–', C.text],
    ['Time to go', left, C.text],
    ['Lowest this week', b.lowest ? `${b.lowest.soc} % · ${b.lowest.day}` : '–', b.lowest && b.lowest.soc < 50 ? C.amberText : C.text],
    ['Last full charge', b.lastFull ? `${weekdayLabel(b.lastFull)} ${clock(b.lastFull)}` : '–', C.text]
  ]
  rows.forEach(([l, v, col], i) => {
    const y = 336 + i * 44
    T(896, y, l, 17, C.muted)
    fit(T(1240, y, v, 21, col, { 'text-anchor': 'end', 'font-weight': 500 }), 200, 14)
    el('line', { x1: 896, x2: 1240, y1: y + 14, y2: y + 14, stroke: C.line })
  })
  if (b.advice) wrap(896, 668, b.advice.text, 17, b.advice.level === 'amber' ? C.amberText : C.greenText, 344, 22, 3)
  else if (!lv) wrap(896, 668, 'No live battery data — check signalk-victron-ble (SmartShunt).', 17, C.muted, 344, 22, 3)
  nav('battery')
}

// ---------------------------------------------------------------- Logbook
const QUICK = ['Cast off', 'Reefed', 'Unreefed', 'Tacked', 'Gybed', 'Engine on', 'Engine off', 'Moored', 'Anchored', 'Note…']
function renderLogbook () {
  const lb = state.logbook
  const ui = state.ui
  header('Logbook')
  const isToday = lb.day === lb.today
  const idx = lb.days.indexOf(lb.day)
  if (idx > 0) button(700, 16, 52, 40, '◀', () => logGo(lb.days[idx - 1]))
  T(870, 44, isToday ? `Today · ${weekdayLabel(lb.day + 'T12:00:00Z')}` : weekdayLabel(lb.day + 'T12:00:00Z'), 20, C.text, { 'text-anchor': 'middle', 'font-weight': 500 })
  if (idx < lb.days.length - 1) button(988, 16, 52, 40, '▶', () => logGo(lb.days[idx + 1]))
  if (!isToday) button(1050, 16, 90, 40, 'Today', () => logGo(lb.today))
  button(1150, 16, 110, 40, 'Export CSV', () => window.open(`${API}/logbook/export?day=${lb.day}`, '_blank'))

  panel(20, 66, 840, 676)
  const cols = [[36, 'Time'], [104, 'Position'], [330, 'COG'], [392, 'SOG'], [452, 'Wind'], [552, 'Baro'], [628, 'Entry']]
  cols.forEach(([x, l]) => T(x, 98, l, 15, C.muted))
  el('line', { x1: 36, x2: 844, y1: 108, y2: 108, stroke: C.line })
  const per = 14
  const pages = Math.max(1, Math.ceil(lb.entries.length / per))
  ui.logPage = Math.min(ui.logPage, pages - 1)
  const rows = lb.entries.slice(ui.logPage * per, ui.logPage * per + per)
  if (!rows.length) T(40, 160, isToday ? 'No entries yet today. Entries are written automatically when you leave and reach a berth, and every hour under way.' : 'No entries on this day.', 17, C.muted)
  rows.forEach((e, i) => {
    const y = 134 + i * 36
    const own = e.kind !== 'auto'
    const sel = ui.logSel === e.t
    if (own || sel) R(28, y - 23, 824, 32, sel ? '#16304a' : '#1a2c40', { rx: 6 })
    const v = [clock(e.t), fmtPos(e.position), e.cog === null ? '–' : `${e.cog}°`, e.sog === null ? '–' : fmtNum(e.sog), e.tws === null ? '–' : `${compass(e.twd)} ${Math.round(e.tws)}`, e.pressure === null ? '–' : Math.round(e.pressure)]
    v.forEach((t, j) => fit(T(cols[j][0], y, t, 15, C.soft), (cols[j + 1] ? cols[j + 1][0] : 860) - cols[j][0] - 8, 11))
    fit(T(628, y, e.text || (e.kind === 'auto' ? 'hourly' : ''), 16, own ? C.text : C.dim, { 'font-weight': own ? 500 : 400 }), sel && e.kind === 'manual' ? 130 : 210, 12)
    if (e.kind === 'manual') tap(R(28, y - 23, 824, 32, 'transparent'), () => { ui.logSel = sel ? null : e.t; render() })
    if (sel && e.kind === 'manual') button(764, y - 21, 80, 28, 'Delete', () => deleteEntry(lb.day, e.t), { size: 14 })
  })
  pager(668, 604, ui.logPage, pages, p => { ui.logPage = p; render() })
  if (isToday) {
    QUICK.forEach((q, i) => button(32 + i * 82, 660, 78, 64, q, () => (q === 'Note…' ? openNote() : addEntry(q)), { size: 15 }))
  } else {
    T(40, 700, 'New entries can only be added for today.', 16, C.muted)
  }

  panel(876, 66, 384, 330)
  T(896, 100, isToday ? 'Today' : 'This day', 20, C.text, { 'font-weight': 500 })
  const st = lb.stats || {}
  ;[['Distance', typeof st.distanceNm === 'number' ? `${fmtNum(st.distanceNm)} nm` : '–'], ['Under way', typeof st.underwayH === 'number' ? durationText(st.underwayH) : '–'], ['Max speed', typeof st.maxSog === 'number' ? `${fmtNum(st.maxSog)} kn` : '–'], ['Entries', String(lb.entries.length)]].forEach(([l, v], i) => {
    const y = 150 + i * 56
    T(896, y, l, 17, C.muted)
    T(1240, y, v, 24, C.text, { 'text-anchor': 'end', 'font-weight': 500 })
    el('line', { x1: 896, x2: 1240, y1: y + 18, y2: y + 18, stroke: C.line })
  })

  panel(876, 406, 384, 336)
  const se = lb.season
  T(896, 440, `Season ${se.year}`, 20, C.text, { 'font-weight': 500 })
  ;[['Distance', `${fmtNum(se.distanceNm, 0)} nm`], ['Days under way', String(se.daysUnderway)], ['Days with the system on', String(se.daysAboard)], ['Hours under way', fmtNum(se.underwayH, 0)], ['Longest day', se.longest ? `${fmtNum(se.longest.distanceNm)} nm · ${weekdayLabel(se.longest.day + 'T12:00:00Z')}` : '–']].forEach(([l, v], i) => {
    const y = 488 + i * 50
    T(896, y, l, 17, C.muted)
    fit(T(1240, y, v, 20, C.text, { 'text-anchor': 'end', 'font-weight': 500 }), 180, 13)
    el('line', { x1: 896, x2: 1240, y1: y + 16, y2: y + 16, stroke: C.line })
  })
  nav('logbook')
}

function logGo (day) {
  if (!day) return
  state.ui.logDay = day
  state.ui.logPage = 0
  state.ui.logSel = null
  loadOne('logbook', `${API}/logbook?day=${day}`).then(render)
}
async function addEntry (text) {
  try {
    state.logbook = await getJson(`${API}/logbook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    const pages = Math.ceil(state.logbook.entries.length / 14)
    state.ui.logPage = Math.max(0, pages - 1)
    toast(`Logged: ${text}`)
    render()
    return true
  } catch (e) { toast(`Could not save: ${e.message}`); return false }
}
async function deleteEntry (day, t) {
  try {
    state.logbook = await getJson(`${API}/logbook?day=${day}&t=${encodeURIComponent(t)}`, { method: 'DELETE' })
    state.ui.logSel = null
    render()
  } catch (e) { toast(`Could not delete: ${e.message}`) }
}
const noteOpen = () => !document.getElementById('note').hidden
function openNote () {
  const inp = document.getElementById('note-text')
  inp.value = ''
  document.getElementById('note-error').hidden = true
  document.getElementById('note').hidden = false
  setTimeout(() => inp.focus(), 50)
}
document.getElementById('note-cancel').addEventListener('click', () => { document.getElementById('note').hidden = true })
async function saveNote () {
  const text = document.getElementById('note-text').value.trim()
  if (!text) { const e = document.getElementById('note-error'); e.textContent = 'Write something first.'; e.hidden = false; return }
  if (await addEntry(text)) document.getElementById('note').hidden = true
}
document.getElementById('note-save').addEventListener('click', saveNote)
document.getElementById('note-text').addEventListener('input', () => { document.getElementById('note-error').hidden = true })
document.getElementById('note-text').addEventListener('keydown', e => { if (e.key === 'Enter') saveNote() })

// ---------------------------------------------------------------- Warnings
const WARN_FILTERS = [['near', 'Near me'], ['route', 'On route'], ['all', 'All Baltic']]
function warnFilterFn (f) {
  if (f === 'route') return w => w.relevance === 'route' || w.relevance === 'here'
  if (f === 'all') return () => true
  return w => w.relevance === 'here' || w.relevance === 'nearby'
}
function whereText (w) {
  if (w.onboard) return 'on board'
  if (w.areaOnly && w.distanceNm === 0) return 'your sea area'
  if (w.relevance === 'here') return 'here'
  if (w.relevance === 'route' && typeof w.routeDistanceNm === 'number') return `${w.routeDistanceNm} nm from route`
  if (typeof w.distanceNm === 'number') return `${Math.round(w.distanceNm)} nm away`
  return (w.areas || []).join(', ').toLowerCase()
}
function renderWarnings () {
  const ui = state.ui
  header('Warnings')
  if (!state.warnings) {
    T(40, 140, 'The warnings plugin is not reachable.', 22, C.muted)
    T(40, 176, 'Install and enable "Baltic Warnings" (signalk-baltic-warnings) in Signal K.', 18, C.muted)
    nav('warnings'); return
  }
  const rank = { emergency: 4, alarm: 4, warn: 3, alert: 2 }
  const relRank = { here: 4, route: 3, nearby: 2, far: 1, unknown: 0 }
  WARN_FILTERS.forEach(([k, l], i) => {
    const n = state.warnings.filter(warnFilterFn(k)).length
    button(250 + i * 170, 16, 160, 40, `${l} · ${n}`, () => { ui.warnFilter = k; ui.warnPage = 0; ui.warnSel = null; render() }, { active: ui.warnFilter === k })
  })
  button(1130, 16, 130, 40, 'Refresh', refreshWarnings)
  const list = state.warnings.filter(warnFilterFn(ui.warnFilter))
    .sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0) || (relRank[b.relevance] || 0) - (relRank[a.relevance] || 0) || (a.distanceNm ?? 1e9) - (b.distanceNm ?? 1e9))
  if (!ui.warnSel || !list.some(w => w.id === ui.warnSel)) ui.warnSel = list[0] ? list[0].id : null

  panel(20, 66, 760, 676)
  const per = 8
  const pages = Math.max(1, Math.ceil(list.length / per))
  ui.warnPage = Math.min(ui.warnPage, pages - 1)
  if (!list.length) T(40, 120, ui.warnFilter === 'route' ? 'Nothing on your route (or no route planned in Passage).' : 'No warnings here.', 19, C.green)
  list.slice(ui.warnPage * per, ui.warnPage * per + per).forEach((w, i) => {
    const y = 78 + i * 76
    const sel = w.id === ui.warnSel
    R(32, y, 736, 68, sel ? '#16304a' : C.panel2, { rx: 8 })
    R(32, y, 8, 68, warningColor(w, true))
    fit(T(56, y + 28, smartCase(w.title), 19, C.text, { 'font-weight': 500 }), 690, 14)
    const until = w.validTo ? ` · until ${weekdayLabel(w.validTo)} ${clock(w.validTo)}` : ''
    fit(T(56, y + 54, `${w.label} · ${whereText(w)}${until}`, 15, C.muted), 690, 12)
    tap(R(32, y, 736, 68, 'transparent'), () => { ui.warnSel = w.id; render() })
  })
  pager(590, 694, ui.warnPage, pages, p => { ui.warnPage = p; render() })

  panel(796, 66, 464, 456)
  const w = list.find(x => x.id === ui.warnSel)
  if (w) {
    fit(T(816, 100, w.label, 19, warningColor(w, true), { 'font-weight': 500 }), 424, 13)
    const meta = [w.issued ? `issued ${weekdayLabel(w.issued)} ${clock(w.issued)}` : null, w.validTo ? `valid until ${weekdayLabel(w.validTo)} ${clock(w.validTo)}` : null].filter(Boolean).join(' · ')
    fit(T(816, 126, meta || 'no end time given', 15, C.muted), 424, 12)
    fit(T(816, 150, `${whereText(w)}${(w.areas || []).length ? ' · ' + w.areas.join(', ').toLowerCase() : ''}`, 15, C.muted), 424, 12)
    let y = 186
    for (const para of String(w.text || '').split('\n')) {
      y = wrap(816, y, para, 16, C.soft, 424, 21, Math.max(1, Math.floor((506 - y) / 21)))
      if (y > 500) break
    }
    fit(T(816, 512, `Source: ${(w.sources || []).join(', ')}${w.attribution ? ' · ' + w.attribution : ''}`, 13, C.dim), 424, 11)
  }

  panel(796, 532, 464, 210)
  T(816, 562, 'Sources', 18, C.text, { 'font-weight': 500 })
  let y = 592
  for (const s of (state.sources || []).filter(x => x.enabled).concat((state.sources || []).filter(x => !x.enabled))) {
    if (y > 730) break
    const col = !s.enabled ? C.dim : s.lastError ? C.amber : s.lastSuccess ? C.green : C.dim
    el('circle', { cx: 824, cy: y - 5, r: 5, fill: col })
    fit(T(838, y, s.name.replace(/ \(.*\)$/, ''), 15, s.enabled ? C.soft : C.dim), 250, 11)
    const st = !s.enabled ? 'off' : s.probeOnly ? 'probe only' : s.lastError ? `failed ${clock(s.lastError.at)}` : s.lastSuccess ? `OK ${clock(s.lastSuccess)} · ${s.count}` : 'waiting'
    T(1240, y, st, 14, s.lastError ? C.amber : C.muted, { 'text-anchor': 'end' })
    if (s.enabled && s.lastError) {
      y += 20
      fit(T(838, y, s.lastError.message, 13, C.amberText), 402, 10)
    }
    y += 25
  }
  nav('warnings')
}
async function refreshWarnings () {
  toast('Fetching warnings…')
  try { await getJson(`${WARN_API}/refresh`, { method: 'POST' }) } catch (e) { toast(`Refresh failed: ${e.message}`) }
  await loadWarnings()
  render()
}

// ---------------------------------------------------------------- NMEA
const NMEA_FILTERS = ['All', 'Navigation', 'Environment', 'Electrical', 'Other']
function nmeaGroup (path) {
  const top = path.split('.')[0]
  return top === 'navigation' ? 'Navigation' : top === 'environment' ? 'Environment' : top === 'electrical' ? 'Electrical' : 'Other'
}
function fmtValue (path, v) {
  if (v === null || v === undefined) return '–'
  if (typeof v === 'object' && typeof v.latitude === 'number') return fmtPos(v)
  if (typeof v === 'object') return v.state ? `${v.state}: ${v.message || ''}` : JSON.stringify(v)
  if (typeof v !== 'number') return String(v)
  const p = path
  if (/rateOfTurn/i.test(p)) return `${(v * 180 / Math.PI * 60).toFixed(0)} °/min`
  if (/(angle|heading|courseOverGround|direction|magneticVariation|attitude|rudder|bearing|cog)/i.test(p) && !/speed/i.test(p)) return `${(v * 180 / Math.PI).toFixed(0)}°`
  if (/(speed|velocity|sog|stw)/i.test(p)) return `${(v * 1.943844).toFixed(1)} kn`
  if (/temperature/i.test(p)) return `${(v - 273.15).toFixed(1)} °C`
  if (/pressure/i.test(p)) return v > 2000 ? `${(v / 100).toFixed(1)} hPa` : `${v}`
  if (/(stateOfCharge|relativeHumidity|ratio|currentLevel|stateOfHealth)/i.test(p)) return `${Math.round(v * 100)} %`
  if (/voltage/i.test(p)) return `${v.toFixed(2)} V`
  if (/current/i.test(p)) return `${v.toFixed(1)} A`
  if (/power/i.test(p)) return `${Math.round(v)} W`
  if (/(depth|belowTransducer|belowKeel|belowSurface|surfaceToTransducer)/i.test(p)) return `${v.toFixed(1)} m`
  if (/(log|trip|distance)/i.test(p)) return `${(v / 1852).toFixed(1)} nm`
  if (/consumedCharge|dischargeSinceFull/i.test(p)) return `${(v / 3600).toFixed(1)} Ah`
  if (/timeRemaining/i.test(p)) return `${(v / 3600).toFixed(1)} h`
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}
function ageText (ms) {
  if (ms < 1500) return 'now'
  if (ms < 60e3) return `${Math.round(ms / 1000)} s`
  if (ms < 3600e3) return `${Math.round(ms / 60e3)} min`
  return `${Math.round(ms / 3600e3)} h`
}
function renderNmea () {
  const d = state.data
  const ui = state.ui
  header('NMEA', `${fmtNum(d.updatesPerSec)} updates/s`)
  NMEA_FILTERS.forEach((f, i) => {
    const n = f === 'All' ? d.paths.length : d.paths.filter(r => nmeaGroup(r.path) === f).length
    button(170 + i * 150, 16, 140, 40, `${f} · ${n}`, () => { ui.nmeaFilter = f; ui.nmeaPage = 0; render() }, { active: ui.nmeaFilter === f, size: 15 })
  })
  const rows = d.paths.filter(r => ui.nmeaFilter === 'All' || nmeaGroup(r.path) === ui.nmeaFilter)

  panel(20, 66, 820, 676)
  const cx = [[36, 'Path'], [356, 'Value'], [530, 'From'], [770, 'Age'], [826, '/min']]
  cx.forEach(([x, l], i) => T(x, 96, l, 15, C.muted, { 'text-anchor': i >= 3 ? 'end' : 'start' }))
  el('line', { x1: 36, x2: 826, y1: 106, y2: 106, stroke: C.line })
  const per = 21
  const pages = Math.max(1, Math.ceil(rows.length / per))
  ui.nmeaPage = Math.min(ui.nmeaPage, pages - 1)
  if (!rows.length) {
    T(40, 150, 'No data received yet.', 20, C.muted)
    T(40, 180, 'Check Server → Data Connections in Signal K (CAN bus, NMEA 0183, plugins).', 17, C.muted)
  }
  rows.slice(ui.nmeaPage * per, ui.nmeaPage * per + per).forEach((r, i) => {
    const y = 130 + i * 27
    if (i % 2) R(28, y - 18, 804, 26, C.panel2, { rx: 4 })
    fit(T(36, y, r.path, 14, C.soft, { 'font-family': 'ui-monospace, Menlo, Consolas, monospace' }), 312, 10)
    fit(T(356, y, fmtValue(r.path, r.value), 15, C.text, { 'font-weight': 500 }), 166, 11)
    const src = r.source.code ? `${r.source.code}${r.source.name ? ' ' + r.source.name : ''}` : r.source.label
    fit(T(530, y, src, 14, r.source.type === 'NMEA 2000' ? C.lightBlue : r.source.type === 'NMEA 0183' ? C.amberText : C.muted), 196, 10)
    T(770, y, ageText(r.ageMs), 14, r.ageMs < 5000 ? C.green : r.ageMs < 60e3 ? C.soft : C.amber, { 'text-anchor': 'end' })
    T(826, y, r.perMin >= 100 ? Math.round(r.perMin) : fmtNum(r.perMin), 14, C.muted, { 'text-anchor': 'end' })
  })
  pager(652, 694, ui.nmeaPage, pages, p => { ui.nmeaPage = p; render() })
  T(40, 720, 'Blue: NMEA 2000 (PGN) · yellow: NMEA 0183 (sentence) · grey: plugins and sensors', 14, C.dim)

  panel(856, 66, 404, 430)
  T(876, 96, 'Live feed', 18, C.text, { 'font-weight': 500 })
  d.log.slice(-15).reverse().forEach((l, i) => {
    const y = 124 + i * 24
    const t = localParts(l.t)
    T(876, y, `${t.hour}:${t.minute}:${String(new Date(l.t).getSeconds()).padStart(2, '0')}`, 13, C.dim, { 'font-family': 'ui-monospace, Menlo, Consolas, monospace' })
    fit(T(950, y, l.source.code || l.source.label, 13, l.source.type === 'NMEA 2000' ? C.lightBlue : l.source.type === 'NMEA 0183' ? C.amberText : C.muted), 82, 9)
    fit(T(1038, y, `${l.path.split('.').slice(-2).join('.')} = ${fmtValue(l.path, l.value)}`, 13, C.soft), 206, 9)
  })

  panel(856, 506, 404, 236)
  T(876, 536, 'Sources', 18, C.text, { 'font-weight': 500 })
  d.sources.slice(0, 7).forEach((s, i) => {
    const y = 566 + i * 25
    el('circle', { cx: 882, cy: y - 5, r: 5, fill: s.ageMs < 10e3 ? C.green : s.ageMs < 120e3 ? C.amber : C.dim })
    fit(T(896, y, s.name, 15, C.soft), 200, 10)
    T(1130, y, s.type, 13, C.muted, { 'text-anchor': 'end' })
    T(1240, y, `${s.count}`, 14, C.muted, { 'text-anchor': 'end' })
  })
  if (!d.sources.length) T(876, 570, 'Nothing yet.', 16, C.muted)
  nav('nmea')
}

// ---------------------------------------------------------------- render, data
function render () {
  while (svg.firstChild) svg.removeChild(svg.firstChild)
  root = svg
  R(0, 0, 1280, 800, C.bg)
  const need = { passage: state.passage, weather: state.weather, battery: state.battery, logbook: state.logbook, nmea: state.data, warnings: true }
  const ready = state.page in need ? need[state.page] : state.brief
  if (!ready) { T(640, 400, 'Loading…', 28, C.muted, { 'text-anchor': 'middle' }); nav(state.page); return }
  const pages = { passage: renderPassage, instruments: renderInstruments, weather: renderWeather, warnings: renderWarnings, battery: renderBattery, logbook: renderLogbook, nmea: renderNmea }
  ;(pages[state.page] || renderBrief)()
}

async function getJson (url, opts) {
  const r = await fetch(url, { credentials: 'include', ...opts })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
  return body
}

async function loadBrief () {
  try { state.brief = await getJson(`${API}/brief`); state.tz = state.brief.timezone } catch (e) { toast(`Could not load the brief: ${e.message}`) }
}
async function loadPassage () {
  try { state.passage = await getJson(`${API}/passage`); state.tz = state.passage.timezone } catch (e) { toast(`Could not load the passage: ${e.message}`) }
}
async function loadWarnings () {
  try {
    const [w, s] = await Promise.all([getJson(`${WARN_API}/warnings?scope=all`), getJson(`${WARN_API}/status`)])
    state.warnings = w.warnings || []
    state.sources = s.sources || []
  } catch (e) { state.warnings = null; state.sources = null }
}

async function loadOne (key, url) {
  try { state[key] = await getJson(url); if (state[key].timezone) state.tz = state[key].timezone } catch (e) { toast(`Could not load ${key}: ${e.message}`) }
}

async function load () {
  const p = state.page
  const brief = state.brief ? null : loadBrief()
  if (p === 'passage') await Promise.all([loadPassage(), loadWarnings(), brief])
  else if (p === 'weather') await Promise.all([loadOne('weather', `${API}/weather`), brief])
  else if (p === 'battery') await Promise.all([loadOne('battery', `${API}/battery`), brief])
  else if (p === 'logbook') await Promise.all([loadOne('logbook', `${API}/logbook${state.ui.logDay ? `?day=${state.ui.logDay}` : ''}`), brief])
  else if (p === 'nmea') await Promise.all([loadOne('data', `${API}/data`), brief])
  else if (p === 'warnings') await Promise.all([loadWarnings(), brief])
  else await Promise.all([loadBrief(), loadWarnings()])
  if (!map.drag) render()
}

function go (page) {
  if (state.page === page) return
  state.page = page
  try { history.replaceState(null, '', `#${page}`) } catch (e) { location.hash = page }
  render()
  load()
}

// ---------------------------------------------------------------- trip actions
let tripBusy = Promise.resolve()
function setTrip (body, refit) {
  tripBusy = tripBusy.then(async () => {
    try {
      state.passage = await getJson(`${API}/trip`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (refit) map.routeKey = null
      await syncWarningsRoute()
      render()
    } catch (e) { toast(`Could not plan the trip: ${e.message}`) }
  })
  return tripBusy
}

function addWaypoint (pt) {
  const wps = ((state.passage && state.passage.waypoints) || []).concat([{ latitude: Math.round(pt.latitude * 1e5) / 1e5, longitude: Math.round(pt.longitude * 1e5) / 1e5 }])
  state.passage = { ...state.passage, waypoints: wps } // draw it right away
  drawMap()
  setTrip({ waypoints: wps })
}

function undoWaypoint () {
  const wps = ((state.passage && state.passage.waypoints) || []).slice(0, -1)
  if (!wps.length) return clearTrip()
  setTrip({ waypoints: wps })
}

async function clearTrip () {
  try {
    state.passage = await getJson(`${API}/trip`, { method: 'DELETE' })
    map.routeKey = null
    await syncWarningsRoute()
  } catch (e) { toast(`Could not clear the trip: ${e.message}`) }
  render()
}

// Tell signalk-baltic-warnings about the route so warnings near it are flagged "on route".
async function syncWarningsRoute () {
  const tr = state.passage && state.passage.trip
  try {
    if (tr) await getJson(`${WARN_API}/route`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: tr.name, points: tr.route }) })
    else await getJson(`${WARN_API}/route`, { method: 'DELETE' })
  } catch (e) { /* warnings plugin not installed */ }
  await loadWarnings()
}

// ---------------------------------------------------------------- harbour picker, toast
const $ = id => document.getElementById(id)
function openPicker () {
  const ps = state.passage
  if (!ps) return
  const list = $('dest-list')
  list.innerHTML = ''
  const here = ps.boat.position
  for (const d of ps.destinations) {
    const nm = here ? Math.round(distNm(here, d)) : null
    if (nm !== null && nm < 1.5) continue
    const b = document.createElement('button')
    b.innerHTML = `${d.name}${nm !== null ? `<small>${nm} nm direct</small>` : ''}`
    if (ps.trip && ps.trip.name === d.name) b.classList.add('selected')
    b.addEventListener('click', () => { $('picker').hidden = true; setTrip({ destination: d.name }, true) })
    list.appendChild(b)
  }
  $('picker-error').hidden = true
  $('picker').hidden = false
}
$('cancel').addEventListener('click', () => { $('picker').hidden = true })

let toastTimer = null
function toast (msg) {
  const t = $('toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, 3500)
}

window.addEventListener('hashchange', () => { const p = location.hash.slice(1); if (PAGES.includes(p)) go(p) })

render()
load()
// NMEA every second; live pages every 30 s; passage and weather every 5 minutes
let ticks = 0
setInterval(() => {
  ticks++
  const p = state.page
  if (p === 'nmea') { if (!noteOpen()) load(); return }
  if (ticks % 30 !== 0) return
  if (p === 'passage' || p === 'weather') { if (ticks % 300 === 0) load(); return }
  if (!noteOpen()) load()
}, 1000)
