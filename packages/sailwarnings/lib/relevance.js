'use strict'

const { distanceToGeometryNm, routeDistanceNm, distanceToPolylineNm } = require('./geo')
const { areaBox, boxContains, boxPolygon } = require('./navtext')

const SEVERITY_RANK = { emergency: 5, alarm: 4, warn: 3, alert: 2, normal: 1 }

function hasGeometry (g) {
  return !!g && ((g.positions && g.positions.length) || (g.polygon && g.polygon.length >= 3) || g.circle)
}

function areaDistance (p, areas) {
  let d = Infinity
  for (const a of areas || []) {
    const box = areaBox(a)
    if (!box) continue
    if (boxContains(box, p)) return 0
    const poly = boxPolygon(box)
    d = Math.min(d, distanceToPolylineNm(p, poly.concat([poly[0]])))
  }
  return d
}

function routeAreaDistance (route, areas) {
  let d = Infinity
  for (const wp of route) d = Math.min(d, areaDistance(wp, areas))
  return d
}

function isActive (w, now = Date.now()) {
  if (w.validTo && Date.parse(w.validTo) < now) return false
  return true
}

// Adds { distanceNm, routeDistanceNm, areaOnly, relevance } to a warning.
//   relevance: 'here' (< 1 nm or in your sea area), 'nearby' (within radius),
//              'route' (within corridor of planned route), 'far', 'unknown'
function assess (w, { position, route, radiusNm = 30, corridorNm = 5 } = {}) {
  const geomKnown = hasGeometry(w.geometry)
  const areaOnly = !geomKnown && (w.areas || []).some(a => areaBox(a))
  let dist = null
  let rdist = null
  if (position) {
    if (geomKnown) dist = distanceToGeometryNm(position, w.geometry)
    else if (areaOnly) dist = areaDistance(position, w.areas)
  }
  if (route && route.length) {
    if (geomKnown) rdist = routeDistanceNm(route, w.geometry)
    else if (areaOnly) rdist = routeAreaDistance(route, w.areas)
  }
  if (w.onboard) dist = 0

  let relevance = 'unknown'
  if (dist !== null && isFinite(dist)) {
    if (dist <= 1) relevance = 'here'
    else if (dist <= radiusNm) relevance = 'nearby'
    else relevance = 'far'
  }
  if (relevance !== 'here' && rdist !== null && isFinite(rdist) && rdist <= corridorNm) relevance = 'route'

  const round = v => (v === null || !isFinite(v)) ? null : Math.round(v * 10) / 10
  return { ...w, distanceNm: round(dist), routeDistanceNm: round(rdist), areaOnly, relevance, active: isActive(w) }
}

function sortWarnings (list) {
  const relRank = { here: 4, route: 3, nearby: 2, far: 1, unknown: 0 }
  return list.slice().sort((a, b) =>
    (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) ||
    (relRank[b.relevance] || 0) - (relRank[a.relevance] || 0) ||
    (a.distanceNm ?? 1e9) - (b.distanceNm ?? 1e9)
  )
}

function inScope (w, scope) {
  if (!w.active) return false
  switch (scope) {
    case 'all': return true
    case 'route': return w.relevance === 'route' || w.relevance === 'here'
    case 'nearby': return w.relevance === 'here' || w.relevance === 'nearby'
    case 'relevant':
    default: return ['here', 'nearby', 'route'].includes(w.relevance)
  }
}

module.exports = { assess, sortWarnings, inScope, isActive, SEVERITY_RANK }
