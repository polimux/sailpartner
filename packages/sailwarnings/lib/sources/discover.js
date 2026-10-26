'use strict'

// Helpers for sources whose exact data layout is not documented: find the
// warnings layer in a WFS or ArcGIS service, and turn features with unknown
// property names into warnings.

const { parseValidity, classify, SEVERITY } = require('../navtext')
const { geometryFromText } = require('../geo')
const { geometryFromGeoJson, looksLatFirst } = require('../geojson')

// "<FeatureType><Name>ns:x</Name><Title>..</Title>" from WFS GetCapabilities
function wfsFeatureTypes (xml) {
  const out = []
  const re = /<(?:\w+:)?FeatureType\b[^>]*>([\s\S]*?)<\/(?:\w+:)?FeatureType>/g
  let m
  while ((m = re.exec(xml))) {
    const get = tag => { const r = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(m[1]); return r ? r[1].trim() : '' }
    out.push({ name: get('Name'), title: get('Title'), abstract: get('Abstract') })
  }
  return out
}

// first non-empty property whose key matches one of the patterns (in order)
function byKey (p, patterns) {
  const keys = Object.keys(p)
  for (const re of patterns) {
    for (const k of keys) {
      const v = p[k]
      if (re.test(k) && v !== null && v !== undefined && String(v).trim() !== '') return v
    }
  }
  return null
}

function toIso (v) {
  if (v === null || v === undefined || v === '') return null
  const t = typeof v === 'number' ? v : Date.parse(v)
  return isFinite(t) ? new Date(t).toISOString() : null
}

// Feature with unknown property names -> warning. English text preferred.
function featureToWarning (f, { issuer, prefix, url, latFirst = false, now = new Date() }) {
  const p = f.properties || f.attributes || {}
  const text = String(byKey(p, [/(content|text|teksti|sisalto|description).*(en|eng)$/i, /^(contents?|text|teksti|sisalto|description)$/i, /(content|text|teksti|sisalto|description)/i]) || '')
  const place = String(byKey(p, [/(location|sijainti|place).*(en|eng)$/i, /(location|sijainti|place|title|otsikko|name|nimi)/i, /(area|alue).*(en|eng)$/i, /(area|alue)/i]) || '')
  const kind = String(byKey(p, [/(type|tyyppi|category).*(en|eng)$/i, /(type|tyyppi|category)/i]) || '')
  const number = byKey(p, [/^(number|numero|nro|no)$/i, /(number|numero|nro)/i, /^(id|objectid|fid)$/i])
  const body = [place, text].filter(Boolean).join('\n') ||
    Object.values(p).filter(v => typeof v === 'string' && v.length > 20).join('\n')
  let geometry = geometryFromGeoJson(f.geometry && f.geometry.type ? f.geometry : null, { latFirst })
  if (!geometry.polygon && !geometry.positions.length) geometry = geometryFromText(body)
  const validity = parseValidity(body, now)
  const category = classify(`${kind} ${body}`)
  return {
    id: `${prefix}-${number ?? Math.abs(hash(body))}`,
    issuer,
    number: number !== null ? String(number) : null,
    label: `${issuer} WARNING${number !== null ? ' ' + number : ''}`,
    title: (place || kind || body.split('\n')[0] || '').slice(0, 120),
    text: body,
    areas: [],
    category,
    severity: SEVERITY[category] || 'alert',
    issued: toIso(byKey(p, [/(publish|creat|issued|julkaisu|sent)/i])),
    validFrom: toIso(byKey(p, [/(valid.*(start|from)|start|alku|voimassa.*alk)/i])) || validity.validFrom,
    validTo: toIso(byKey(p, [/(valid.*(end|to)|end|loppu|paattyy)/i])) || validity.validTo,
    cancels: [],
    geometry,
    url
  }
}

function hash (s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return h }

function featuresToWarnings (features, opts) {
  const latFirst = looksLatFirst(features)
  return features.map(f => featureToWarning(f, { ...opts, latFirst })).filter(w => w.text)
}

module.exports = { wfsFeatureTypes, featureToWarning, featuresToWarnings, byKey }
