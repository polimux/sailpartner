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
      german_580_26: { value: { state: 'warn', message: 'GERMAN NAV WARN 580/26: WESTERN BALTIC.FEHMARN. PROHIBITED AREA. (14 nm)', category: 'exercise', label: 'GERMAN NAV WARN 580/26', title: 'WESTERN BALTIC.FEHMARN. PROHIBITED AREA.', relevance: 'nearby', distanceNm: 14.1, areaOnly: false } },
      baltic_sea_30_26: { value: { state: 'alert', message: 'BALTIC SEA NAV WARN 030/26: GNSS, AIS, RADAR AND DGPS INTERFERENCE (your sea area)', category: 'gnss', label: 'BALTIC SEA NAV WARN 030/26', title: 'SOUTHERN, SOUTHEASTERN, CENTRAL AND NORTHERN BALTIC, GULF OF FINLAND, GULF OF RIGA AND SEA OF AALAND.', relevance: 'here', distanceNm: 0, areaOnly: true } },
      polish_276_26: { value: { state: 'warn', message: 'POLISH NAV WARN 276/26: SOUTHERN BALTIC. POLISH COAST (120 nm)', category: 'exercise', label: 'POLISH NAV WARN 276/26', title: 'SOUTHERN BALTIC. POLISH COAST', relevance: 'route', distanceNm: 120, routeDistanceNm: 3 } },
      old_one: { value: { state: 'normal', message: '' } }
    },
    'notifications.environment.warnings': {
      onboard_pressure: { value: { state: 'warn', message: 'On board barometer: Pressure falling fast', category: 'weather', label: 'On board barometer', title: 'Pressure falling fast', relevance: 'here', distanceNm: 0 } }
    }
  }
}

function mockApp () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'))
  const self = selfData()
  const subscribers = []
  const publish = d => subscribers.forEach(cb => cb(d))
  return {
    dir,
    self,
    getDataDirPath: () => dir,
    getSelfPath: p => self[p],
    // Stores deltas like the server does, so notifications from another plugin
    // (signalk-baltic-warnings in the demo) appear under the self data.
    handleMessage: (id, msg) => {
      for (const u of msg.updates || []) {
        for (const v of u.values || []) {
          publish({ path: v.path, value: v.value, context: 'vessels.self', source: { label: id, type: 'plugin' }, $source: id, timestamp: new Date().toISOString() })
          const m = /^(notifications\.[a-z]+\.warnings)\.(.+)$/.exec(v.path)
          if (m) {
            const node = self[m[1]] || (self[m[1]] = {})
            node[m[2]] = { value: v.value }
          } else {
            self[v.path] = { value: v.value }
          }
        }
      }
    },
    registerResourceProvider: () => {},
    // Signal K's stream of all updates for our own vessel, and a helper that
    // feeds it like an NMEA connection would (sets the value and publishes it).
    streambundle: {
      getSelfBus: () => ({
        onValue: cb => { subscribers.push(cb); return () => subscribers.splice(subscribers.indexOf(cb), 1) }
      })
    },
    emit (path, value, source, $source) {
      self[path] = { value }
      publish({ path, value, context: 'vessels.self', source, $source, timestamp: new Date().toISOString() })
    },
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
      headers: {},
      setHeader (k, v) { this.headers[k] = v },
      send (d) { resolve({ status: this.statusCode, body: d, headers: this.headers }) },
      json (d) { resolve({ status: this.statusCode, body: d }) }
    }
    Promise.resolve(routes[`${m} ${p}`]({ query, body }, res)).catch(reject)
  })
  r.routes = routes
  return r
}

module.exports = { mockApp, mockRouter, selfData }
