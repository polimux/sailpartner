'use strict'

// Runs the plugin against a mock Signal K server and mocked HTTP.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const createPlugin = require('..')

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'sjofartsverket-navtex.html'), 'utf8')

function mockApp () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-'))
  const messages = []
  const providers = {}
  const self = {
    'navigation.position': { value: { latitude: 54.373, longitude: 11.004 } },
    'environment.outside.pressure': { value: 100880 }
  }
  return {
    dir,
    messages,
    providers,
    self,
    getDataDirPath: () => dir,
    getSelfPath: p => self[p],
    handleMessage: (id, msg) => messages.push(msg),
    registerResourceProvider: p => { providers[p.type] = p },
    setPluginStatus: () => {},
    debug: () => {}
  }
}

const mockHttp = {
  fetchText: async (url) => {
    if (url.includes('sjofartsverket')) return html
    throw new Error('offline')
  },
  fetchJson: async () => { throw new Error('HTTP 503') }
}

function mockRouter () {
  const routes = {}
  const r = {}
  for (const m of ['get', 'put', 'post', 'delete']) r[m] = (p, h) => { routes[`${m} ${p}`] = h }
  r.call = (m, p, { query = {}, body } = {}) => new Promise(resolve => {
    const res = {
      statusCode: 200,
      status (c) { this.statusCode = c; return this },
      json (d) { resolve({ status: this.statusCode, body: d }) }
    }
    routes[`${m} ${p}`]({ query, body }, res)
  })
  return r
}

test('plugin end to end with mock server', async (t) => {
  const app = mockApp()
  const plugin = createPlugin(app, { http: mockHttp })
  t.after(() => plugin.stop())
  assert.ok(plugin.schema().properties.sources.properties.sjofartsverket)
  const router = mockRouter()
  plugin.registerWithRouter(router)

  plugin.start({ sources: { dwd: { enabled: true } } })
  const sjo = require('../lib/sources').find(s => s.id === 'sjofartsverket')
  const dt = require('../lib/sources').find(s => s.id === 'dwd')
  await plugin._internals.runSource(sjo)
  await plugin._internals.runSource(dt)

  // notifications: GNSS (sea area) is relevant without a route; Fehmarn is 12 nm -> nearby
  const all = app.messages.flatMap(m => m.updates[0].values)
  const paths = all.map(v => v.path)
  assert.ok(paths.includes('notifications.navigation.warnings.baltic_sea_30_26'))
  assert.ok(paths.includes('notifications.navigation.warnings.german_580_26'))
  assert.ok(!paths.includes('notifications.navigation.warnings.kaliningrad_224_26'))

  // REST: relevant list, status with the failed source
  let r = await router.call('get', '/warnings')
  assert.equal(r.status, 200)
  assert.ok(r.body.warnings.some(w => w.id === 'german-580-26' && w.relevance === 'nearby'))
  r = await router.call('get', '/status')
  const dts = r.body.sources.find(s => s.id === 'dwd')
  assert.match(dts.lastError.message, /503/)
  assert.ok(r.body.sources.find(s => s.id === 'sjofartsverket').lastSuccess)

  // a route far away east: Fehmarn stays nearby, GNSS stays here
  r = await router.call('put', '/route', { body: { name: 'Test', points: [{ latitude: 54.373, longitude: 11.004 }, { latitude: 54.4, longitude: 11.13 }] } })
  assert.equal(r.status, 200)
  r = await router.call('put', '/route', { body: { points: [{ latitude: 1 }] } })
  assert.equal(r.status, 400)

  // chart resources for relevant warnings
  const notes = await app.providers.notes.methods.listResources({})
  assert.ok(Object.values(notes).some(n => /580\/26/.test(n.name)))

  // all scope includes far warnings
  r = await router.call('get', '/warnings', { query: { scope: 'all' } })
  assert.equal(r.body.count, 10)

  // when the boat moves to the Gulf of Finland, Fehmarn notification is cleared
  app.self['navigation.position'] = { value: { latitude: 59.8, longitude: 27.0 } }
  await router.call('delete', '/route')
  const last = app.messages[app.messages.length - 1].updates[0].values
  const cleared = last.find(v => v.path === 'notifications.navigation.warnings.german_580_26')
  assert.equal(cleared.value.state, 'normal')
  assert.ok(last.some(v => v.path === 'notifications.environment.warnings.petersburg_121_26' || v.path === 'notifications.navigation.warnings.petersburg_121_26'))

  plugin.stop()
  assert.ok(fs.existsSync(path.join(app.dir, 'warnings.json')))
})

test('unreachable source: one clear message, backs off after 3 failures', async (t) => {
  const app = mockApp()
  let calls = 0
  const timeout = () => { calls++; const e = new Error('no answer within 10 s (www.navtex.lv) — site down, or not reachable from your network'); throw e }
  const plugin = createPlugin(app, { http: { fetchText: async () => timeout(), fetchJson: async () => timeout() } })
  t.after(() => plugin.stop())
  plugin.start({ sources: { sjofartsverket: { enabled: false }, dwd: { enabled: false }, finland: { enabled: false } } })
  const lv = require('../lib/sources').find(s => s.id === 'navtexlv')
  assert.equal(lv.coveredBy, 'BALTICO')
  await plugin._internals.runSource(lv)
  const st = plugin._internals.store.sourceStatus('navtexlv')
  assert.equal(st.lastError.message, 'no answer within 10 s (www.navtex.lv) — site down, or not reachable from your network', 'https and http fail the same way: said once')
  assert.equal(calls, 3)
  await plugin._internals.runSource(lv)
  await plugin._internals.runSource(lv)
  assert.equal(st.failures, 3)
  await plugin._internals.runSource(lv)
  assert.equal(calls, 9, 'fourth run skipped: waits 6 h')
  await plugin._internals.runSource(lv, { force: true })
  assert.equal(calls, 12, 'Refresh button still tries')
})
