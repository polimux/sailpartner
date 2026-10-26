'use strict'

// Finnish local nautical warnings. Digitraffic stopped carrying them in 2026;
// since 13 Jan 2026 Traficom publishes them through its open WFS service
// (Traficom news, 13.1.2026). The layer name is not documented, so it is
// looked up in the service description by name or title.
// Finland's coastal NAVTEX warnings also arrive through BALTICO.

const { wfsFeatureTypes, featuresToWarnings } = require('./discover')

const BASE = 'https://julkinen.traficom.fi/inspirepalvelu/avoin/wfs'
const CAPS = `${BASE}?service=WFS&request=GetCapabilities`
const MATCH = /merivaroit|navigational.?warn|nav_?warn|sjövarn|sjovarn|varoitu/i

let layer = null

function findLayer (xml) {
  const types = wfsFeatureTypes(xml)
  const hit = types.find(t => /merivaroit/i.test(t.name + t.title)) || types.find(t => MATCH.test(`${t.name} ${t.title} ${t.abstract}`))
  return { hit, count: types.length }
}

module.exports = {
  id: 'finland',
  name: 'Traficom (Finland, local warnings)',
  defaultEnabled: true,
  defaultIntervalMin: 30,
  experimental: true,
  coveredBy: 'BALTICO',
  urls: [CAPS],
  attribution: 'Finnish Transport and Communications Agency Traficom, CC BY 4.0',
  findLayer,
  async fetch ({ http, now }) {
    const raw = []
    if (!layer) {
      const xml = await http.fetchText(CAPS)
      raw.push({ url: CAPS, body: xml })
      const { hit, count } = findLayer(xml)
      if (!hit) throw Object.assign(new Error(`Traficom service lists ${count} layers, none of them nautical warnings yet`), { raw })
      layer = hit.name
    }
    const url = `${BASE}?service=WFS&version=1.0.0&request=GetFeature&typeName=${encodeURIComponent(layer)}&outputFormat=application/json&srsName=EPSG:4326`
    const { json, body } = await http.fetchJson(url)
    raw.push({ url, body })
    const warnings = featuresToWarnings(json.features || [], { issuer: 'FINNISH', prefix: 'finnish-local', url: 'https://liikennetilanne.fintraffic.fi/meri/merivaroitukset/', now })
    return { warnings, raw }
  },
  _reset () { layer = null }
}
