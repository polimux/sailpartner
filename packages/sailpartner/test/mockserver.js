'use strict'

// A minimal stand-in for the Signal K server, with a moored boat in Heiligenhafen
// on the morning of the scenario. Used by the tests and by bin/demo.js.

const fs = require('fs')
const os = require('os')
const path = require('path')

const KN = 1 / 1.943844
const DEG = Math.PI / 180

function selfData () {
  return {
    'navigation.position': { value: { latitude: 54.3733, longitude: 11.0052 } },
    'navigation.speedOverGround': { value: 0 },
    'navigation.headingTrue': { value: 270 * DEG },
    'environment.wind.speedApparent': { value: 14.1 * KN },
    'environment.wind.angleApparent': { value: -40 * DEG },
    'environment.outside.pressure': { value: 100880 },
    'environment.inside.temperature': { value: 273.15 + 14.2 },
    'environment.inside.relativeHumidity': { value: 0.78 },
    'electrical.batteries': { house: {} },
    'electrical.batteries.house.capacity.stateOfCharge': { value: 0.78 },
    'electrical.batteries.house.voltage': { value: 12.64 },
    'electrical.batteries.house.current': { value: -3.2 },
    'electrical.batteries.house.power': { value: -40.4 },
    'electrical.batteries.house.capacity.consumedCharge': { value: 44 * 3600 },
    'electrical.batteries.house.capacity.timeRemaining': { value: 151200 },
    'notifications.navigation.warnings': {
      german_580_26: { value: { state: 'warn', message: 'GERMAN NAV WARN 580/26: WESTERN BALTIC.FEHMARN. PROHIBITED AREA. (14 nm)', category: 'exercise' } },
      baltic_sea_30_26: { value: { state: 'alert', message: 'BALTIC SEA NAV WARN 030/26: GNSS, AIS, RADAR AND DGPS INTERFERENCE (your sea area)', category: 'gnss' } },
      old_one: { value: { state: 'normal', message: '' } }
    },
    'notifications.environment.warnings': {
      onboard_pressure: { value: { state: 'warn', message: 'On board barometer: Pressure falling fast', category: 'weather' } }
    }
  }
}

function mockApp () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'))
  const self = selfData()
  return {
    dir,
    self,
    getDataDirPath: () => dir,
    getSelfPath: p => self[p],
    handleMessage: () => {},
    setPluginStatus: () => {},
    debug: () => {}
  }
}

function mockRouter () {
  const routes = {}
  const r = {}
  for (const m of ['get', 'put', 'post', 'delete']) r[m] = (p, h) => { routes[`${m} ${p}`] = h }
  r.call = (m, p, { query = {}, body } = {}) => new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status (c) { this.statusCode = c; return this },
      json (d) { resolve({ status: this.statusCode, body: d }) }
    }
    Promise.resolve(routes[`${m} ${p}`]({ query, body }, res)).catch(reject)
  })
  r.routes = routes
  return r
}

module.exports = { mockApp, mockRouter, selfData }
