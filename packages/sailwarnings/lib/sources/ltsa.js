'use strict'

// Lithuanian navigational warnings (LTSA, hydro.eltsa.lt/nw). The page is an
// ArcGIS map application backed by the feature service
// .../arcgis/rest/services/Hosted/MaritimeWarnings_LT/FeatureServer.
// Its point, line and polygon layers carry only shapes and a "warn_globalid";
// the warning texts sit in a table of the same service, joined by that id.
// The service address is read from the app script, so a move is picked up.
// Lithuania's coastal NAVTEX warnings also arrive through BALTICO.

const { featureToWarning } = require('./discover')
const { geometryFromGeoJson } = require('../geojson')

const PAGE = 'https://hydro.eltsa.lt/nw/en.html'
const SERVICE = /https?:\/\/[^"'\s\\)]+?\/(?:FeatureServer|MapServer)(?:\/\d+)?/g
const NOT_DATA = /arcgisonline\.com|js\.arcgis\.com|basemaps|World_|Canvas|Ocean_Base|SampleWorldCities|\/exts\//i

let services = null

function scriptUrls (html, base) {
  return [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => new URL(m[1], base).href)
}

function serviceUrls (js) {
  const all = [...new Set((js.match(SERVICE) || []).map(u => u.replace(/\/\d+$/, '').replace(/\/$/, '')))].filter(u => !NOT_DATA.test(u))
  const warn = all.filter(u => /warn/i.test(u))
  return warn.length ? warn : all
}

function configUrls (js, base) {
  const rel = [...js.matchAll(/["']((?:\.\/|\/)?[\w./-]+\.json)["']/g)].map(m => m[1]).filter(u => !/package|manifest|nls|i18n/i.test(u))
  return [...new Set(rel)].slice(0, 10).map(u => new URL(u, base).href)
}

const gid = v => String(v || '').replace(/[{}]/g, '').toUpperCase()

// table rows (attributes) + shapes (GeoJSON features with warn_globalid) -> warnings
function join (rows, shapes, { now = new Date() } = {}) {
  const byWarn = new Map()
  for (const f of shapes) {
    const k = gid(f.properties && (f.properties.warn_globalid || f.properties.WARN_GLOBALID))
    if (!k) continue
    if (!byWarn.has(k)) byWarn.set(k, [])
    byWarn.get(k).push(f)
  }
  const out = []
  for (const attrs of rows) {
    const w = featureToWarning({ properties: attrs }, { issuer: 'LITHUANIAN', prefix: 'lithuanian-local', url: PAGE, now })
    const geo = { positions: [] }
    for (const f of byWarn.get(gid(attrs.globalid || attrs.GLOBALID)) || []) {
      const g = geometryFromGeoJson(f.geometry)
      geo.positions.push(...g.positions)
      if (g.polygon && !geo.polygon) geo.polygon = g.polygon
    }
    if (geo.positions.length || geo.polygon) w.geometry = geo
    if (w.text) out.push(w)
  }
  return out
}

async function discover (http, raw) {
  const html = await http.fetchText(PAGE)
  raw.push({ url: PAGE, body: html })
  const found = []
  for (const src of scriptUrls(html, PAGE).filter(u => u.includes('eltsa.lt'))) {
    const js = await http.fetchText(src)
    raw.push({ url: src, body: js })
    found.push(...serviceUrls(js))
    if (!found.length) {
      for (const cfg of configUrls(js, src)) {
        try { const body = await http.fetchText(cfg); raw.push({ url: cfg, body }); found.push(...serviceUrls(body)) } catch (e) { /* not there */ }
      }
    }
  }
  if (!found.length) throw Object.assign(new Error('no warnings service address found in the LTSA page'), { raw })
  return [...new Set(found)]
}

module.exports = {
  id: 'ltsa',
  name: 'LTSA (Lithuania)',
  defaultEnabled: false,
  defaultIntervalMin: 60,
  experimental: true,
  coveredBy: 'BALTICO',
  urls: [PAGE],
  attribution: 'Lithuanian Transport Safety Administration',
  serviceUrls,
  configUrls,
  join,
  async fetch ({ http, now }) {
    const raw = []
    try {
      if (!services) services = await discover(http, raw)
      const warnings = []
      for (const svc of services) {
        const { json: info, body: infoBody } = await http.fetchJson(`${svc}?f=json`)
        raw.push({ url: `${svc}?f=json`, body: infoBody })
        const rows = []; const shapes = []
        for (const t of info.tables || []) {
          const url = `${svc}/${t.id}/query?where=1%3D1&outFields=*&f=json`
          const { json, body } = await http.fetchJson(url)
          raw.push({ url, body })
          rows.push(...(json.features || []).map(f => f.attributes || {}))
        }
        const seen = new Set()
        for (const l of info.layers || []) {
          const url = `${svc}/${l.id}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson`
          const { json, body } = await http.fetchJson(url)
          raw.push({ url, body })
          for (const f of json.features || []) {
            const k = gid(f.properties && f.properties.globalid)
            if (k && seen.has(k)) continue // the same shape published in two layers
            seen.add(k); shapes.push(f)
          }
        }
        if (!rows.length) throw Object.assign(new Error(`${svc}: no warnings table found (layers: ${(info.layers || []).map(l => l.id + ' ' + l.name).join(', ')})`), { raw })
        warnings.push(...join(rows, shapes, { now }))
      }
      return { warnings, raw, note: `service: ${services.join(', ')}` }
    } catch (e) {
      services = null
      if (!e.raw) e.raw = raw
      throw e
    }
  },
  _reset () { services = null }
}
