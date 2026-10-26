'use strict'

const { norm360 } = require('./units')

const EARTH_NM = 3440.065
const rad = d => d * Math.PI / 180
const deg = r => r * 180 / Math.PI

function distanceNm (a, b) {
  const dLat = rad(b.latitude - a.latitude)
  const dLon = rad(b.longitude - a.longitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}

function bearing (a, b) {
  const y = Math.sin(rad(b.longitude - a.longitude)) * Math.cos(rad(b.latitude))
  const x = Math.cos(rad(a.latitude)) * Math.sin(rad(b.latitude)) -
    Math.sin(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.cos(rad(b.longitude - a.longitude))
  return norm360(deg(Math.atan2(y, x)))
}

function interpolate (a, b, f) {
  return { latitude: a.latitude + (b.latitude - a.latitude) * f, longitude: a.longitude + (b.longitude - a.longitude) * f }
}

function routeLength (points) {
  let d = 0
  for (let i = 1; i < points.length; i++) d += distanceNm(points[i - 1], points[i])
  return d
}

// Position and course after `nm` along the route.
function along (points, nm) {
  let rest = nm
  for (let i = 1; i < points.length; i++) {
    const leg = distanceNm(points[i - 1], points[i])
    if (rest <= leg || i === points.length - 1) {
      const f = leg === 0 ? 0 : Math.min(1, rest / leg)
      return { position: interpolate(points[i - 1], points[i], f), course: bearing(points[i - 1], points[i]) }
    }
    rest -= leg
  }
  return { position: points[0], course: 0 }
}

// Hourly positions from departure at constant speed, plus the arrival.
// Returns [{ time, distanceNm, position, course, arrival }]
function timeline (points, departure, speedKn) {
  const total = routeLength(points)
  const start = new Date(departure).getTime()
  const out = []
  for (let h = 0; ; h++) {
    const dist = h * speedKn
    if (dist >= total) break
    const a = along(points, dist)
    out.push({ time: new Date(start + h * 3600e3).toISOString(), distanceNm: Math.round(dist * 10) / 10, position: a.position, course: Math.round(a.course), arrival: false })
  }
  const last = points[points.length - 1]
  const lastCourse = points.length > 1 ? bearing(points[points.length - 2], last) : 0
  out.push({ time: new Date(start + (total / speedKn) * 3600e3).toISOString(), distanceNm: Math.round(total * 10) / 10, position: last, course: Math.round(lastCourse), arrival: true })
  return { totalNm: total, hours: out }
}

module.exports = { distanceNm, bearing, routeLength, along, timeline }
