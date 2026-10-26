'use strict'

const MS_TO_KN = 1.943844
const RAD = 180 / Math.PI

function msToKn (v) { return typeof v === 'number' ? v * MS_TO_KN : null }
function radToDeg (v) { return typeof v === 'number' ? v * RAD : null }
function norm360 (d) { return ((d % 360) + 360) % 360 }
function norm180 (d) { const x = norm360(d); return x > 180 ? x - 360 : x }

// Beaufort from knots (upper bounds of each force)
const BFT = [1, 3, 6, 10, 16, 21, 27, 33, 40, 47, 55, 63]
function beaufort (kn) {
  if (typeof kn !== 'number') return null
  for (let i = 0; i < BFT.length; i++) if (kn <= BFT[i]) return i
  return 12
}

const POINTS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
const POINTS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
function compass16 (deg) { return typeof deg === 'number' ? POINTS16[Math.round(norm360(deg) / 22.5) % 16] : '' }
function compass8 (deg) { return typeof deg === 'number' ? POINTS8[Math.round(norm360(deg) / 45) % 8] : '' }

// Circular mean of directions in degrees
function meanDirection (degs) {
  let x = 0; let y = 0
  for (const d of degs) { x += Math.cos(d / RAD); y += Math.sin(d / RAD) }
  if (x === 0 && y === 0) return null
  return norm360(Math.atan2(y, x) * RAD)
}

module.exports = { MS_TO_KN, msToKn, radToDeg, norm360, norm180, beaufort, compass16, compass8, meanDirection }
