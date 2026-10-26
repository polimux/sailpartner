'use strict'

// Fintraffic Digitraffic — Finnish nautical warnings (open API, GeoJSON, CC BY 4.0).
// Endpoint: /api/nautical-warning/v1/warnings/active
// Property names are read defensively (several naming variants) because the exact
// schema should be confirmed with `npm run probe` on first deployment.

const { parseValidity, classify, SEVERITY } = require('../navtext')
const { geometryFromText } = require('../geo')

const URL = 'https://meri.digitraffic.fi/api/nautical-warning/v1/warnings/active'

function pick (obj, keys) {
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null && String(v).trim() !== '') return v
  }
  return null
}

function langKeys (base, lang) {
  const order = lang === 'fi' ? ['Fi', 'Sv', 'En'] : lang === 'sv' ? ['Sv', 'En', 'Fi'] : ['En', 'Sv', 'Fi']
  return order.flatMap(s => [base + s, base + s.toUpperCase(), base + '_' + s.toLowerCase()])
}

function toPos (c) { return { latitude: c[1], longitude: c[0] } }

function geometryFromGeoJson (g) {
  const out = { positions: [] }
  if (!g) return out
  switch (g.type) {
    case 'Point': out.positions.push(toPos(g.coordinates)); break
    case 'MultiPoint': out.positions.push(...g.coordinates.map(toPos)); break
    case 'LineString': out.positions.push(...g.coordinates.map(toPos)); break
    case 'MultiLineString': g.coordinates.forEach(l => out.positions.push(...l.map(toPos))); break
    case 'Polygon': out.polygon = g.coordinates[0].map(toPos); break
    case 'MultiPolygon': out.polygon = g.coordinates[0][0].map(toPos); break
    case 'GeometryCollection': {
      for (const sub of g.geometries || []) {
        const s = geometryFromGeoJson(sub)
        out.positions.push(...s.positions)
        if (s.polygon && !out.polygon) out.polygon = s.polygon
      }
      break
    }
  }
  return out
}

function parse (json, { lang = 'en', now = new Date() } = {}) {
  const features = Array.isArray(json) ? json : (json.features || [])
  return features.map(f => {
    const p = f.properties || f
    const contents = pick(p, langKeys('contents', lang)) || ''
    const location = pick(p, langKeys('location', lang)) || ''
    const areas = pick(p, langKeys('areas', lang)) || ''
    const type = pick(p, langKeys('type', lang)) || ''
    const number = pick(p, ['number', 'id'])
    const text = [location, contents].filter(Boolean).join('\n')
    let geometry = geometryFromGeoJson(f.geometry)
    if (!geometry.polygon && geometry.positions.length === 0) geometry = geometryFromText(text)
    const textValidity = parseValidity(text, now)
    const category = classify(`${type} ${text}`)
    const vFrom = pick(p, ['validityStartTime', 'validFrom', 'validityStart'])
    const vTo = pick(p, ['validityEndTime', 'validTo', 'validityEnd'])
    return {
      id: `finnish-local-${number}`,
      issuer: 'FINNISH',
      number: String(number),
      label: `FINNISH WARNING ${number}`,
      title: (location || type || contents.split('\n')[0] || '').slice(0, 120),
      text,
      areas: areas ? [String(areas).toUpperCase()] : [],
      category,
      severity: SEVERITY[category] || 'alert',
      issued: pick(p, ['publishingTime', 'creationTime', 'created']) || null,
      validFrom: vFrom || textValidity.validFrom,
      validTo: vTo || textValidity.validTo,
      cancels: [],
      geometry,
      url: 'https://www.digitraffic.fi/en/marine-traffic/',
      navtex: p.navtex === true
    }
  })
}

module.exports = {
  id: 'digitraffic',
  name: 'Digitraffic (Finland, local warnings)',
  defaultEnabled: true,
  urls: [URL],
  defaultIntervalMin: 15,
  attribution: 'Source: Fintraffic / digitraffic.fi, license CC 4.0 BY',
  parse,
  async fetch ({ http, now, options }) {
    const { json, body } = await http.fetchJson(URL, { headers: { 'Digitraffic-User': 'sailwarnings/0.2' } })
    return { warnings: parse(json, { lang: options.language, now }), raw: [{ url: URL, body }] }
  }
}
