'use strict'

// Geometry helpers. All positions are { latitude, longitude } in decimal degrees,
// all distances in nautical miles.

const EARTH_NM = 3440.065

function toRad (d) { return d * Math.PI / 180 }

function distanceNm (a, b) {
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}

// Local flat projection around a reference point (good enough for < 100 nm).
function project (p, ref) {
  return {
    x: (p.longitude - ref.longitude) * 60 * Math.cos(toRad(ref.latitude)),
    y: (p.latitude - ref.latitude) * 60
  }
}

function distanceToSegmentNm (p, a, b) {
  const pa = project(a, p)
  const pb = project(b, p)
  const dx = pb.x - pa.x
  const dy = pb.y - pa.y
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : -(pa.x * dx + pa.y * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = pa.x + t * dx
  const cy = pa.y + t * dy
  return Math.sqrt(cx * cx + cy * cy)
}

function distanceToPolylineNm (p, line) {
  if (!line || line.length === 0) return Infinity
  if (line.length === 1) return distanceNm(p, line[0])
  let min = Infinity
  for (let i = 0; i < line.length - 1; i++) {
    min = Math.min(min, distanceToSegmentNm(p, line[i], line[i + 1]))
  }
  return min
}

function pointInPolygon (p, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].longitude; const yi = poly[i].latitude
    const xj = poly[j].longitude; const yj = poly[j].latitude
    const hit = ((yi > p.latitude) !== (yj > p.latitude)) &&
      (p.longitude < (xj - xi) * (p.latitude - yi) / (yj - yi) + xi)
    if (hit) inside = !inside
  }
  return inside
}

function closeRing (poly) {
  if (poly.length < 3) return poly
  const a = poly[0]; const b = poly[poly.length - 1]
  return (a.latitude === b.latitude && a.longitude === b.longitude) ? poly : poly.concat([a])
}

// Distance from point p to a warning's geometry. 0 when inside a polygon or circle.
function distanceToGeometryNm (p, geom) {
  if (!p || !geom) return Infinity
  let d = Infinity
  if (geom.polygon && geom.polygon.length >= 3) {
    if (pointInPolygon(p, geom.polygon)) return 0
    d = Math.min(d, distanceToPolylineNm(p, closeRing(geom.polygon)))
  }
  if (geom.circle) {
    d = Math.min(d, Math.max(0, distanceNm(p, geom.circle.center) - geom.circle.radiusNm))
  }
  for (const pos of geom.positions || []) d = Math.min(d, distanceNm(p, pos))
  return d
}

// Minimum distance between a route (polyline) and a geometry.
function routeDistanceNm (route, geom) {
  if (!route || route.length === 0 || !geom) return Infinity
  let d = Infinity
  const pts = []
  if (geom.polygon) pts.push(...geom.polygon)
  if (geom.positions) pts.push(...geom.positions)
  if (geom.circle) pts.push(geom.circle.center)
  for (const pt of pts) {
    let dd = distanceToPolylineNm(pt, route)
    if (geom.circle && pt === geom.circle.center) dd = Math.max(0, dd - geom.circle.radiusNm)
    d = Math.min(d, dd)
  }
  // Route waypoints inside the polygon
  if (geom.polygon && geom.polygon.length >= 3) {
    for (const wp of route) if (pointInPolygon(wp, geom.polygon)) return 0
  }
  return d
}

// --- Parsing coordinates out of free text -------------------------------
// Handles the formats seen in Baltic NAVTEX / national warnings:
//   58-41.9N 010-51.0E      54-31,5N 011-18,5E      54-28N 012-30E
//   55-13.214N; 018-48.92E  59°28.02′N, 028°02.36′E  PSN:59-48.68N 027-24.73E
//   55-3,19N 17-18,05E      54 12.3N 011 31.0E
const COORD_RE = /(\d{1,2})\s*[-°º\s]\s*(\d{1,2}(?:[.,]\d+)?)\s*['′’]?\s*([NS])[\s,;]*?(\d{1,3})\s*[-°º\s]\s*(\d{1,2}(?:[.,]\d+)?)\s*['′’]?\s*([EW])\b/g

function parsePositions (text) {
  const out = []
  if (!text) return out
  COORD_RE.lastIndex = 0
  let m
  while ((m = COORD_RE.exec(text)) !== null) {
    const latDeg = Number(m[1]); const latMin = Number(m[2].replace(',', '.'))
    const lonDeg = Number(m[4]); const lonMin = Number(m[5].replace(',', '.'))
    if (latDeg > 90 || lonDeg > 180 || latMin >= 60 || lonMin >= 60) continue
    let lat = latDeg + latMin / 60
    let lon = lonDeg + lonMin / 60
    if (m[3] === 'S') lat = -lat
    if (m[6] === 'W') lon = -lon
    out.push({ latitude: round(lat), longitude: round(lon) })
  }
  return out
}

function round (v) { return Math.round(v * 1e5) / 1e5 }

// Build a geometry from a warning text: area polygon, circle or single points.
function geometryFromText (text) {
  const positions = parsePositions(text)
  const geom = { positions: [] }
  if (positions.length === 0) return geom
  const upper = (text || '').toUpperCase()
  const radius = upper.match(/(\d+(?:[.,]\d+)?)\s*(NM|N\.?M\.?|NAUTICAL MILES?|MILES?|CABLES?|KM|METERS|METRES|M)\b\s*(?:RADIUS|FROM|AROUND|CENTRED|CENTERED)?/)
  const mentionsRadius = /RADIUS|CENTRED|CENTERED|CIRCLE/.test(upper)
  if (mentionsRadius && radius) {
    let r = Number(radius[1].replace(',', '.'))
    const unit = radius[2]
    if (/CABLE/.test(unit)) r = r / 10
    else if (unit === 'KM') r = r / 1.852
    else if (/^M$|METER|METRE/.test(unit)) r = r / 1852
    geom.circle = { center: positions[0], radiusNm: r }
    geom.positions = positions.slice(1)
    return geom
  }
  const looksLikeArea = /AREA|ZONE|BOUNDED|JOINING|BETWEEN|POLYGON/.test(upper)
  if (looksLikeArea && positions.length >= 3) {
    geom.polygon = positions
    return geom
  }
  geom.positions = positions
  return geom
}

module.exports = {
  distanceNm,
  distanceToPolylineNm,
  distanceToGeometryNm,
  routeDistanceNm,
  pointInPolygon,
  parsePositions,
  geometryFromText,
  closeRing
}
