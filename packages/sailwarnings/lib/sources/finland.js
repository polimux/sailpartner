'use strict'

// Finnish local nautical warnings. Digitraffic stopped carrying them in 2026;
// since 13 Jan 2026 Traficom publishes them in its open WFS service
// (S-124 data model) as layers avoin:navigational_warnings_a (areas) and
// siblings for points/lines. The layers are looked up in the service
// description, so new or renamed ones are picked up automatically.
// Finland's coastal NAVTEX warnings also arrive through BALTICO.

const { wfsFeatureTypes, featureToWarning } = require('./discover')
const { classify, SEVERITY } = require('../navtext')
const { geometryFromGeoJson, looksLatFirst } = require('../geojson')

const BASE = 'https://julkinen.traficom.fi/inspirepalvelu/avoin/wfs'
const CAPS = `${BASE}?service=WFS&request=GetCapabilities`
const PAGE = 'https://liikennetilanne.fintraffic.fi/meri/merivaroitukset/'

let layers = null

function findLayers (xml) {
  const types = wfsFeatureTypes(xml)
  let hits = types.filter(t => /navigational_warning|merivaroit/i.test(`${t.name} ${t.title}`))
  if (!hits.length) hits = types.filter(t => /nav.?warn|varoitu|sjövarn/i.test(`${t.name} ${t.title} ${t.abstract}`))
  return { names: hits.map(t => t.name), count: types.length }
}

const lang = (p, base, l = 'EN') => p[`${base}_${l}`] || p[`${base}_EN`] || p[`${base}_SV`] || p[`${base}_FI`] || null
const clean = s => String(s || '').trim()
const titleCase = s => clean(s).toLowerCase().replace(/(^|[\s,(/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())

// One Traficom feature (S-124 field names) -> warning
function toWarning (f, { latFirst, now }) {
  const p = f.properties || {}
  if (!('WARNINGINFORMATION_EN' in p) && !('WARNINGINFORMATION_FI' in p)) {
    return featureToWarning(f, { issuer: 'FINNISH', prefix: 'finnish-local', url: PAGE, latFirst, now })
  }
  const number = p.MESSAGESERIESIDENTIFIERWARNINGNUMBER
  const yy = String(p.MESSAGESERIESIDENTIFIERYEAR || '').slice(-2)
  const ident = clean(p.MESSAGESERIESIDENTIFIERINTEROPERABILITYIDENTIFIER) || `fi-${p.ID}`
  const series = clean(lang(p, 'MESSAGESERIESIDENTIFIERNAMEOFSERIES'))
  const locality = titleCase(lang(p, 'LOCALITYLOCATIONNAME'))
  const area = clean(lang(p, 'GENERALAREALOCATIONNAME'))
  const kind = clean(lang(p, 'NAVWARNTYPEGENERAL'))
  const detail = clean(lang(p, 'WARNINGINFORMATIONNAVWARNTYPEDETAILS'))
  const text = clean(lang(p, 'WARNINGINFORMATION'))
  const category = classify(`${kind} ${detail} ${text}`)
  return {
    id: `finnish-local-${ident.split(':').slice(-3).join('-')}`.toLowerCase(),
    issuer: 'FINNISH',
    number: number !== undefined ? `${number}/${yy}` : null,
    label: `FINNISH LOCAL WARNING ${number}/${yy}`,
    title: [locality, kind].filter(Boolean).join(' · ') || area,
    text: [area && locality ? `${area}. ${locality}.` : area || locality, text].filter(Boolean).join('\n'),
    areas: area ? [area.toUpperCase()] : [],
    category,
    severity: SEVERITY[category] || 'alert',
    series: series || null,
    issued: p.PUBLICATIONTIME || null,
    validFrom: p.FIXEDDATERANGEDATESTART || p.VALIDFROM || null,
    validTo: p.FIXEDDATERANGEDATEEND || p.VALIDTO || null,
    cancels: [],
    geometry: geometryFromGeoJson(f.geometry, { latFirst }),
    url: PAGE,
    _ident: ident
  }
}

// Features of all layers -> warnings; a warning drawn as several shapes is merged.
function parse (features, { now = new Date() } = {}) {
  const latFirst = looksLatFirst(features)
  const byId = new Map()
  for (const f of features) {
    const w = toWarning(f, { latFirst, now })
    const prev = byId.get(w.id)
    if (!prev) { byId.set(w.id, w); continue }
    prev.geometry.positions.push(...w.geometry.positions)
    if (!prev.geometry.polygon && w.geometry.polygon) prev.geometry.polygon = w.geometry.polygon
  }
  return [...byId.values()].map(({ _ident, ...w }) => w)
}

module.exports = {
  id: 'finland',
  name: 'Traficom (Finland, local warnings)',
  defaultEnabled: true,
  defaultIntervalMin: 30,
  coveredBy: 'BALTICO',
  urls: [CAPS],
  attribution: 'Finnish Transport and Communications Agency Traficom, CC BY 4.0',
  findLayers,
  parse,
  async fetch ({ http, now }) {
    const raw = []
    if (!layers) {
      const xml = await http.fetchText(CAPS)
      raw.push({ url: CAPS, body: xml })
      const { names, count } = findLayers(xml)
      if (!names.length) throw Object.assign(new Error(`Traficom service lists ${count} layers, none of them nautical warnings`), { raw })
      layers = names
    }
    const features = []
    for (const name of layers) {
      const url = `${BASE}?service=WFS&version=1.0.0&request=GetFeature&typeName=${encodeURIComponent(name)}&outputFormat=application/json&srsName=EPSG:4326`
      const { json, body } = await http.fetchJson(url)
      raw.push({ url, body })
      features.push(...(json.features || []))
    }
    return { warnings: parse(features, { now }), raw, note: `layers: ${layers.join(', ')}` }
  },
  _reset () { layers = null }
}
