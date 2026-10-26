'use strict'

// Translating warnings into Signal K: notifications, and notes/regions resources
// that chart plotters such as Freeboard-SK draw on the chart.

const crypto = require('crypto')
const { closeRing } = require('./geo')

function key (id) {
  return id.replace(/[^a-zA-Z0-9]+/g, '_')
}

function notificationPath (w) {
  const branch = w.category === 'weather' || w.category === 'waterlevel' ? 'environment' : 'navigation'
  return `notifications.${branch}.warnings.${key(w.id)}`
}

function describeDistance (w) {
  if (w.onboard) return ''
  if (w.areaOnly && w.distanceNm === 0) return ' (your sea area)'
  if (w.relevance === 'route' && w.routeDistanceNm !== null) return ` (${w.routeDistanceNm} nm from route)`
  if (w.distanceNm !== null) return ` (${w.distanceNm} nm)`
  return ''
}

function notificationValue (w) {
  const method = ['visual']
  if (w.severity === 'alarm' || w.severity === 'emergency') method.push('sound')
  return {
    state: w.severity || 'alert',
    method,
    message: `${w.label}: ${w.title}${describeDistance(w)}`,
    id: w.id,
    category: w.category,
    validTo: w.validTo || null
  }
}

function clearValue () {
  return { state: 'normal', method: [], message: '' }
}

// Deterministic UUID (v5-like) so resource ids stay stable across restarts.
function uuidFor (id) {
  const h = crypto.createHash('sha1').update('signalk-baltic-warnings:' + id).digest('hex')
  const v = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function circlePolygon (center, radiusNm, n = 24) {
  const pts = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI
    pts.push({
      latitude: center.latitude + (radiusNm / 60) * Math.cos(a),
      longitude: center.longitude + (radiusNm / 60) * Math.sin(a) / Math.cos(center.latitude * Math.PI / 180)
    })
  }
  return pts
}

function description (w) {
  const lines = [w.label, w.text]
  if (w.validTo) lines.push(`Valid until ${w.validTo}`)
  lines.push(`Source: ${(w.sources || []).join(', ')}`)
  return lines.filter(Boolean).join('\n')
}

// Signal K v2 "regions" for area warnings and circles.
function toRegion (w) {
  let ring = null
  if (w.geometry.polygon && w.geometry.polygon.length >= 3) ring = closeRing(w.geometry.polygon)
  else if (w.geometry.circle) ring = closeRing(circlePolygon(w.geometry.circle.center, w.geometry.circle.radiusNm))
  if (!ring) return null
  return {
    name: `${w.label}`,
    description: description(w),
    feature: {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring.map(p => [p.longitude, p.latitude])] },
      properties: { severity: w.severity, category: w.category, warningId: w.id }
    }
  }
}

// Signal K v2 "notes" for point warnings (one note per warning, first position).
function toNote (w) {
  const pos = (w.geometry.positions || [])[0]
  if (!pos || w.onboard) return null
  return {
    name: `${w.label}`,
    description: description(w),
    position: { latitude: pos.latitude, longitude: pos.longitude },
    group: 'Navigational warnings',
    mimeType: 'text/plain',
    url: w.url || ''
  }
}

module.exports = { notificationPath, notificationValue, clearValue, uuidFor, toRegion, toNote, key }
