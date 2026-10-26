'use strict'

// Reads the live boat picture from the Signal K data model.
// Signal K units: m/s, radians, Kelvin, Pascal, ratio 0..1, seconds, Coulomb.

const { msToKn, radToDeg, norm360 } = require('./units')

function make (app) {
  return function get (p) {
    const v = app.getSelfPath ? app.getSelfPath(p) : undefined
    if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) return v.value
    return v
  }
}

const round = (v, n = 1) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : null)

function findBattery (get, app, preferredId) {
  const base = 'electrical.batteries'
  let ids = []
  if (preferredId) ids = [preferredId]
  else {
    const all = app.getSelfPath ? app.getSelfPath(base) : null
    if (all && typeof all === 'object') ids = Object.keys(all)
  }
  for (const id of ids) {
    const soc = get(`${base}.${id}.capacity.stateOfCharge`) ?? get(`${base}.${id}.stateOfCharge`)
    const voltage = get(`${base}.${id}.voltage`)
    if (soc === undefined && voltage === undefined) continue
    const consumedC = get(`${base}.${id}.capacity.consumedCharge`) ?? get(`${base}.${id}.capacity.dischargeSinceFull`)
    return {
      id,
      soc: typeof soc === 'number' ? Math.round(soc * 100) : null,
      voltage: round(voltage, 2),
      current: round(get(`${base}.${id}.current`), 1),
      power: round(get(`${base}.${id}.power`), 0),
      consumedAh: typeof consumedC === 'number' ? -Math.abs(Math.round(consumedC / 3600)) : null,
      timeRemainingS: typeof get(`${base}.${id}.capacity.timeRemaining`) === 'number' ? get(`${base}.${id}.capacity.timeRemaining`) : null
    }
  }
  return null
}

function snapshot (app, opts = {}) {
  const get = make(app)
  const pos = get('navigation.position')
  const position = pos && typeof pos.latitude === 'number' ? { latitude: pos.latitude, longitude: pos.longitude } : null
  const sog = msToKn(get('navigation.speedOverGround'))

  let heading = radToDeg(get('navigation.headingTrue'))
  if (heading === null) {
    const mag = radToDeg(get('navigation.headingMagnetic'))
    const varn = radToDeg(get('navigation.magneticVariation'))
    if (mag !== null) heading = norm360(mag + (varn || 0))
  }

  const aws = msToKn(get('environment.wind.speedApparent'))
  const awa = radToDeg(get('environment.wind.angleApparent'))
  const stationary = sog === null || sog < 0.5
  let tws = msToKn(get('environment.wind.speedTrue'))
  if (tws === null && stationary) tws = aws
  let twa = radToDeg(get('environment.wind.angleTrueWater'))
  if (twa === null) twa = radToDeg(get('environment.wind.angleTrueGround'))
  if (twa === null && stationary) twa = awa
  let twd = radToDeg(get('environment.wind.directionTrue'))
  if (twd === null && heading !== null && twa !== null) twd = norm360(heading + twa)

  const pressurePa = get(opts.pressurePath || 'environment.outside.pressure')
  const tempK = get(opts.cabinTemperaturePath || 'environment.inside.temperature')
  const hum = get(opts.cabinHumidityPath || 'environment.inside.relativeHumidity')

  const anchorPos = get('navigation.anchor.position')
  const anchor = anchorPos && typeof anchorPos.latitude === 'number'
    ? { position: anchorPos, currentRadius: round(get('navigation.anchor.currentRadius'), 0), maxRadius: round(get('navigation.anchor.maxRadius'), 0) }
    : null

  return {
    position,
    sog: round(sog),
    cog: round(radToDeg(get('navigation.courseOverGroundTrue')), 0),
    heading: round(heading, 0),
    aws: round(aws),
    awa: round(awa, 0),
    tws: round(tws),
    twa: round(twa, 0),
    twd: twd === null ? null : Math.round(norm360(twd)),
    pressureHPa: typeof pressurePa === 'number' ? round(pressurePa > 2000 ? pressurePa / 100 : pressurePa, 1) : null,
    cabinTemp: typeof tempK === 'number' ? round(tempK - 273.15, 1) : null,
    cabinHumidity: typeof hum === 'number' ? Math.round(hum <= 1 ? hum * 100 : hum) : null,
    battery: findBattery(get, app, opts.batteryId),
    anchor,
    navState: get('navigation.state') || null
  }
}

// moored / anchored / underway
function boatState (s) {
  if (s.anchor) return 'anchored'
  if (s.navState === 'sailing' || s.navState === 'motoring') return 'underway'
  if (typeof s.sog === 'number' && s.sog >= 1) return 'underway'
  return 'moored'
}

// Signal K notifications raised by signalk-baltic-warnings (or anyone else) under
// notifications.navigation.warnings.* and notifications.environment.warnings.*
function warnings (app) {
  const out = []
  for (const branch of ['navigation', 'environment']) {
    const node = app.getSelfPath ? app.getSelfPath(`notifications.${branch}.warnings`) : null
    if (!node || typeof node !== 'object') continue
    for (const [key, v] of Object.entries(node)) {
      const val = v && v.value ? v.value : v
      if (!val || !val.state || val.state === 'normal') continue
      out.push({ path: `notifications.${branch}.warnings.${key}`, state: val.state, message: val.message, category: val.category || null, validTo: val.validTo || null })
    }
  }
  const rank = { emergency: 5, alarm: 4, warn: 3, alert: 2 }
  return out.sort((a, b) => (rank[b.state] || 0) - (rank[a.state] || 0))
}

module.exports = { snapshot, boatState, warnings }
