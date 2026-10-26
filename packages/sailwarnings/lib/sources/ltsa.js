'use strict'

// Lithuanian navigational warnings (LTSA, hydro.eltsa.lt/nw). The page is an
// ArcGIS map application: the warnings come from an ArcGIS service whose
// address sits in the app's JavaScript. It is found there once, then queried
// as GeoJSON. Lithuania's coastal NAVTEX warnings also arrive through BALTICO.

const { featuresToWarnings } = require('./discover')

const PAGE = 'https://hydro.eltsa.lt/nw/en.html'
const SERVICE = /https?:\/\/[^"'\s\\)]+?\/(?:FeatureServer|MapServer)(?:\/\d+)?/g

let layers = null

function scriptUrls (html, base) {
  return [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => new URL(m[1], base).href)
}

function serviceUrls (js) {
  return [...new Set((js.match(SERVICE) || []).map(u => u.replace(/\/$/, '')))]
}

async function discover (http, raw) {
  const html = await http.fetchText(PAGE)
  raw.push({ url: PAGE, body: html })
  const found = []
  for (const src of scriptUrls(html, PAGE).filter(u => u.includes('eltsa.lt'))) {
    const js = await http.fetchText(src)
    raw.push({ url: src, body: js })
    found.push(...serviceUrls(js))
  }
  if (!found.length) throw Object.assign(new Error('no ArcGIS service address found in the LTSA page'), { raw })
  const out = []
  for (const svc of found) {
    if (/\/\d+$/.test(svc)) { out.push(svc); continue }
    try {
      const { json } = await http.fetchJson(`${svc}?f=json`)
      for (const l of json.layers || []) out.push(`${svc}/${l.id}`)
    } catch (e) { /* skip */ }
  }
  if (!out.length) throw Object.assign(new Error(`ArcGIS services found but no layers: ${found.join(', ')}`), { raw })
  return out
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
  async fetch ({ http, now }) {
    const raw = []
    if (!layers) layers = await discover(http, raw)
    const warnings = []
    for (const l of layers) {
      const url = `${l}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson`
      const { json, body } = await http.fetchJson(url)
      raw.push({ url, body })
      warnings.push(...featuresToWarnings(json.features || [], { issuer: 'LITHUANIAN', prefix: 'lithuanian-local', url: PAGE, now }))
    }
    return { warnings, raw }
  },
  _reset () { layers = null }
}
