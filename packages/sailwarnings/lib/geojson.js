'use strict'

// GeoJSON geometry -> { positions, polygon } as used by relevance.js.
// `latFirst` handles WFS servers that return EPSG:4326 coordinates as lat,lon.

function geometryFromGeoJson (g, { latFirst = false } = {}) {
  const toPos = c => latFirst ? { latitude: c[0], longitude: c[1] } : { latitude: c[1], longitude: c[0] }
  const out = { positions: [] }
  if (!g) return out
  switch (g.type) {
    case 'Point': out.positions.push(toPos(g.coordinates)); break
    case 'MultiPoint': out.positions.push(...g.coordinates.map(toPos)); break
    case 'LineString': out.positions.push(...g.coordinates.map(toPos)); break
    case 'MultiLineString': g.coordinates.forEach(l => out.positions.push(...l.map(toPos))); break
    case 'Polygon': out.polygon = g.coordinates[0].map(toPos); break
    case 'MultiPolygon': {
      // keep the largest ring (coastal areas often come with small islands first)
      const rings = g.coordinates.map(p => p[0])
      rings.sort((a, b) => b.length - a.length)
      out.polygon = rings[0].map(toPos)
      break
    }
    case 'GeometryCollection': {
      for (const sub of g.geometries || []) {
        const s = geometryFromGeoJson(sub, { latFirst })
        out.positions.push(...s.positions)
        if (s.polygon && !out.polygon) out.polygon = s.polygon
      }
      break
    }
  }
  return out
}

function firstCoordinate (g) {
  if (!g) return null
  let c = g.coordinates || (g.geometries && g.geometries[0] && g.geometries[0].coordinates)
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0]
  return Array.isArray(c) ? c : null
}

// Decide the axis order from the data: in our waters latitude (53..70) is
// always larger than longitude (5..32).
function looksLatFirst (features) {
  for (const f of features || []) {
    const c = firstCoordinate(f.geometry)
    if (c) return c[0] > c[1]
  }
  return false
}

module.exports = { geometryFromGeoJson, looksLatFirst }
