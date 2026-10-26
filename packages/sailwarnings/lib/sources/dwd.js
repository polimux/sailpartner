'use strict'

// Deutscher Wetterdienst — official coastal wind and storm warnings (Starkwind,
// Sturm, Orkan) for the German North Sea and Baltic coasts.
//
// Main source: DWD GeoServer layer dwd:Warnungen_Kueste (GeoJSON with the
// warning area polygons and names, so warnings can be matched to the boat).
// Fallback: the WarnWetter app file, which has the same warnings but only
// area numbers.

const { geometryFromGeoJson, looksLatFirst } = require('../geojson')

const WFS = 'https://maps.dwd.de/geoserver/dwd/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=dwd:Warnungen_Kueste&outputFormat=application/json&srsName=EPSG:4326'
const APP = 'https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16/warnings_coast_en.json'

// strong breeze / near gale = reef; gale = stay in; storm, hurricane = alarm
function severityOf (event, level) {
  const e = String(event || '').toLowerCase()
  if (/near gale|strong wind|starkwind/.test(e)) return 'warn'
  if (/gale|storm|hurricane|sturm|orkan/.test(e)) return 'alarm'
  return level >= 3 ? 'alarm' : 'warn'
}

function title (event) {
  const e = String(event || '').trim()
  return e ? e.charAt(0).toUpperCase() + e.slice(1) + ' warning' : 'Wind warning'
}

function pick (p, keys) {
  for (const k of keys) if (p[k] !== undefined && p[k] !== null && String(p[k]).trim() !== '') return p[k]
  return null
}

function parseWfs (json) {
  const features = json.features || []
  const latFirst = looksLatFirst(features)
  const byKey = new Map()
  for (const f of features) {
    const p = f.properties || {}
    const area = pick(p, ['AREADESC', 'areaDesc', 'NAME']) || 'German coast'
    const ident = pick(p, ['IDENTIFIER', 'identifier']) || `${area}-${pick(p, ['ONSET', 'onset'])}`
    const lang = String(pick(p, ['LANGUAGE', 'language']) || '').toLowerCase()
    const key = `${ident}|${area}`
    const prev = byKey.get(key)
    if (prev && !(lang.startsWith('en') && !prev.lang.startsWith('en'))) continue // prefer English
    byKey.set(key, { p, area, ident, lang, geometry: geometryFromGeoJson(f.geometry, { latFirst }) })
  }
  return [...byKey.values()].map(({ p, area, ident, geometry }) => {
    const event = pick(p, ['EVENT', 'event'])
    const text = [pick(p, ['HEADLINE', 'headline']), pick(p, ['DESCRIPTION', 'description']), pick(p, ['INSTRUCTION', 'instruction'])].filter(Boolean).join('\n')
    return {
      id: `dwd-${String(ident).slice(-24)}-${area}`.replace(/[^A-Za-z0-9-]+/g, '_'),
      issuer: 'DWD',
      number: null,
      label: `DWD · ${area}`,
      title: title(event),
      text,
      areas: [String(area).toUpperCase()],
      category: 'weather',
      severity: severityOf(event, Number(pick(p, ['EC_LEVEL', 'level']) || 0)),
      issued: pick(p, ['SENT', 'sent', 'EFFECTIVE']),
      validFrom: pick(p, ['ONSET', 'onset', 'EFFECTIVE']),
      validTo: pick(p, ['EXPIRES', 'expires']),
      cancels: [],
      geometry,
      url: 'https://www.dwd.de/DE/leistungen/seewetterbericht/seewetter.html'
    }
  })
}

// app file: { time, warnings: { "<warncell>": [ { warnId, level, event, headline, description, start?, end? } ] } }
function parseApp (json) {
  const out = []
  for (const [cell, list] of Object.entries(json.warnings || {})) {
    for (const w of list || []) {
      out.push({
        id: `dwd-${cell}-${String(w.warnId || '').slice(-12)}`.replace(/[^A-Za-z0-9-]+/g, '_'),
        issuer: 'DWD',
        number: null,
        label: `DWD · coast area ${cell}`,
        title: title(w.event),
        text: [w.headline, w.descriptionText || w.description].filter(Boolean).join('\n'),
        areas: [],
        category: 'weather',
        severity: severityOf(w.event, Number(w.level || 0)),
        issued: json.time ? new Date(json.time).toISOString() : null,
        validFrom: w.start ? new Date(w.start).toISOString() : null,
        validTo: w.end ? new Date(w.end).toISOString() : null,
        cancels: [],
        geometry: { positions: [] },
        url: 'https://www.dwd.de/DE/leistungen/seewetterbericht/seewetter.html'
      })
    }
  }
  return out
}

module.exports = {
  id: 'dwd',
  name: 'DWD coastal wind warnings (Germany)',
  defaultEnabled: true,
  defaultIntervalMin: 30,
  experimental: true,
  urls: [WFS, APP],
  attribution: 'Deutscher Wetterdienst (DWD)',
  parseWfs,
  parseApp,
  async fetch ({ http }) {
    try {
      const { json, body } = await http.fetchJson(WFS)
      return { warnings: parseWfs(json), raw: [{ url: WFS, body }] }
    } catch (e) {
      // map layer not available: area numbers only, still shown under "All"
      try {
        const { json, body } = await http.fetchJson(APP)
        return { warnings: parseApp(json), raw: [{ url: APP, body }], note: `map layer failed (${e.message}); using area numbers` }
      } catch (e2) {
        throw new Error(`map layer: ${e.message} · app file: ${e2.message}`)
      }
    }
  }
}
