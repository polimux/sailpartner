'use strict'

// Helpers for NAVTEX-style warning texts (BALTICO, Pinneberg, national coastal warnings).

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 }

// "202201 UTC OCT" -> Date. The year is not in the text, so it is inferred:
// issue times lie in the past (allow 3 days of clock skew), validity times may lie
// up to ~10 months ahead.
function parseDtg (s, now = new Date(), { maxFutureDays = 3 } = {}) {
  const m = /(\d{2})(\d{2})(\d{2})\s*UTC\s*([A-Z]{3})(?:\s*(\d{4}|\d{2}\b))?/.exec(s || '')
  if (!m || MONTHS[m[4]] === undefined) return null
  const day = Number(m[1]); const hh = Number(m[2]); const mm = Number(m[3])
  const explicit = m[5] ? Number(m[5].length === 2 ? '20' + m[5] : m[5]) : null
  let year = explicit || now.getUTCFullYear()
  let d = new Date(Date.UTC(year, MONTHS[m[4]], day, hh, mm))
  if (!explicit) {
    const ahead = (d.getTime() - now.getTime()) / 86400e3
    if (ahead > maxFutureDays) { year -= 1 } else if (ahead < maxFutureDays - 365) { year += 1 }
    d = new Date(Date.UTC(year, MONTHS[m[4]], day, hh, mm))
  }
  return isNaN(d) ? null : d
}

const VALIDITY_DTG = { maxFutureDays: 300 }

// Validity from text. Returns { validFrom, validTo } as ISO strings or null.
function parseValidity (text, now = new Date()) {
  const upper = (text || '').toUpperCase()
  let from = null; let to = null
  const take = (a, b) => {
    if (a && (!from || a < from)) from = a
    if (b && (!to || b > to)) to = b
  }
  // FROM 2026-10-26 05:00 TO 2026-10-27 00:59
  for (const m of upper.matchAll(/FROM\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+TO\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/g)) {
    take(new Date(`${m[1]}T${m[2]}:00Z`), new Date(`${m[3]}T${m[4]}:00Z`))
  }
  // ON 2026-10-31 FROM 07:00 TO 18:00
  for (const m of upper.matchAll(/ON\s+(\d{4}-\d{2}-\d{2})\s+FROM\s+(\d{2}:\d{2})\s+TO\s+(\d{2}:\d{2})/g)) {
    take(new Date(`${m[1]}T${m[2]}:00Z`), new Date(`${m[1]}T${m[3]}:00Z`))
  }
  // 302100 UTC SEP THRU 312100 UTC OCT
  for (const m of upper.matchAll(/(\d{6}\s*UTC\s*[A-Z]{3})\s*(?:THRU|TO|UNTIL)\s*(\d{6}\s*UTC\s*[A-Z]{3})/g)) {
    take(parseDtg(m[1], now, VALIDITY_DTG), parseDtg(m[2], now, VALIDITY_DTG))
  }
  // CANCEL THIS MSG 311800 UTC OCT
  const c = /CANCEL\s+THIS\s+(?:MSG|MESSAGE)\s+(\d{6}\s*UTC\s*[A-Z]{3})/.exec(upper)
  if (c) take(null, parseDtg(c[1], now, VALIDITY_DTG))
  return {
    validFrom: from ? from.toISOString() : null,
    validTo: to ? to.toISOString() : null
  }
}

// References to warnings this one cancels, e.g. "CANCEL NAV WARN 516/26".
function parseCancels (text) {
  const out = []
  for (const m of (text || '').toUpperCase().matchAll(/CANCEL\s+(?:[A-Z]+\s+)?NAV\s*WARN(?:ING)?\s+(?:NO\.?\s*)?(\d{1,4})(?:\(T\))?\/(\d{2})/g)) {
    out.push(`${Number(m[1])}/${m[2]}`)
  }
  return out
}

function classify (text) {
  const u = (text || '').toUpperCase()
  if (/LOW SEA LEVEL|HIGH SEA LEVEL|SEA LEVEL|WATER LEVEL|STORM SURGE|HIGH WATER|LOW WATER/.test(u)) return 'waterlevel'
  if (/GALE|STORM WARNING|STARKWIND|STURM/.test(u)) return 'weather'
  // "EXERCISE CAUTION" is advice, not a military exercise
  if (/FIRING|GUNNERY|MISSILE|MILITARY|NAVAL|SUBMARINE|EXERCISES\b|EXERCISE (?!CAUTION)|DANGEROUS TO SHIPPING|CLOSED FOR SHIPPING|PROHIBITED/.test(u)) return 'exercise'
  if (/GNSS|GPS|DGPS|DGNSS|AIS\b|RADAR INTERFERENCE|JAMMING|LORAN/.test(u)) return 'gnss'
  if (/WRECK|ADRIFT|DRIFTING|OBSTRUCTION|MINE|UNEXPLODED|CONTAINER|DEBRIS|SUBMERGED/.test(u)) return 'hazard'
  if (/UNLIT|EXTINGUISHED|LIGHT|BUOY|MARK|BEACON|RACON|MISSING|OFF STATION|DAMAGED/.test(u)) return 'aton'
  if (/DREDGING|CABLE|PIPELINE|SURVEY|WORK|OPERATIONS|TOW/.test(u)) return 'works'
  return 'navigation'
}

// Default severity per category (Signal K notification states).
const SEVERITY = {
  weather: 'warn',
  exercise: 'warn',
  hazard: 'warn',
  waterlevel: 'warn',
  gnss: 'alert',
  aton: 'alert',
  works: 'alert',
  navigation: 'alert'
}

// Approximate bounding boxes of the Baltic sea areas used by BALTICO/Sjöfartsverket.
// [minLat, minLon, maxLat, maxLon] — rough, used only for warnings without coordinates.
const SEA_AREAS = {
  SKAGERRAK: [57.0, 7.0, 59.5, 11.5],
  KATTEGAT: [55.9, 10.5, 57.8, 12.9],
  'THE SOUND': [55.3, 12.4, 56.2, 13.0],
  'THE BELTS': [54.6, 9.5, 56.0, 11.5],
  'WESTERN BALTIC': [53.8, 10.0, 55.0, 13.5],
  'SOUTHERN BALTIC': [54.0, 13.5, 55.8, 16.5],
  'SOUTH-EASTERN BALTIC': [54.3, 16.5, 56.5, 21.5],
  'CENTRAL BALTIC': [55.8, 16.0, 58.5, 21.5],
  'NORTHERN BALTIC': [58.5, 17.5, 60.0, 23.0],
  'GULF OF RIGA': [56.9, 21.5, 58.7, 24.6],
  'GULF OF FINLAND': [59.2, 22.5, 60.8, 30.5],
  'SEA OF ÅLAND AND ARCHIPELAGO SEA': [59.6, 18.5, 60.8, 22.5],
  'SEA OF BOTHNIA': [60.5, 17.0, 63.5, 22.0],
  'THE QUARK': [63.3, 19.5, 64.2, 22.0],
  'BAY OF BOTHNIA': [64.0, 20.5, 66.0, 26.0]
}

function normalizeAreaName (s) {
  return (s || '').toUpperCase().replace(/\(\d+\)/, '').replace(/\s+/g, ' ').trim()
}

function areaBox (name) {
  return SEA_AREAS[normalizeAreaName(name)] || null
}

function boxContains (box, p) {
  return p.latitude >= box[0] && p.latitude <= box[2] && p.longitude >= box[1] && p.longitude <= box[3]
}

function boxPolygon (box) {
  return [
    { latitude: box[0], longitude: box[1] },
    { latitude: box[0], longitude: box[3] },
    { latitude: box[2], longitude: box[3] },
    { latitude: box[2], longitude: box[1] }
  ]
}

// "SWEDISH NAV WARN" + "177/26" -> { issuer: 'SWEDISH', number: '177/26', id: 'swedish-177-26' }
function warningId (header, number) {
  const issuer = (header || '').toUpperCase().replace(/NAV\s*WARN(ING)?/, '').replace(/[^A-Z ]/g, '').trim() || 'UNKNOWN'
  const n = (number || '').toUpperCase().replace(/\(T\)/, '').trim()
  const [num, yy] = n.split('/')
  const clean = `${Number(num)}/${yy}`
  return {
    issuer,
    number: clean,
    id: `${issuer.toLowerCase().replace(/\s+/g, '-')}-${Number(num)}-${yy}`
  }
}

module.exports = {
  parseDtg,
  parseValidity,
  parseCancels,
  classify,
  SEVERITY,
  SEA_AREAS,
  areaBox,
  boxContains,
  boxPolygon,
  normalizeAreaName,
  warningId
}
