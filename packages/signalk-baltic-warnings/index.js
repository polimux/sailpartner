'use strict'

const path = require('path')
const fs = require('fs')
const http = require('./lib/http')
const SOURCES = require('./lib/sources')
const { Store } = require('./lib/store')
const { Barometer } = require('./lib/barometer')
const { assess, sortWarnings, inScope, SEVERITY_RANK } = require('./lib/relevance')
const sk = require('./lib/signalk')

const PLUGIN_ID = 'signalk-baltic-warnings'

module.exports = function (app, deps = {}) {
  const httpClient = deps.http || http
  const plugin = {
    id: PLUGIN_ID,
    name: 'Baltic Warnings',
    description: 'Navigational warnings for the Baltic (BALTICO/NAVTEX for all Baltic states, Digitraffic, on-board barometer) filtered by position and route'
  }

  let options = null
  let store = null
  let baro = null
  let timers = []
  let published = new Map() // notification path -> state
  let lastAssessed = []
  const running = new Set()

  plugin.schema = () => ({
    type: 'object',
    properties: {
      radiusNm: { type: 'number', title: 'Nearby radius (nm)', default: 30 },
      corridorNm: { type: 'number', title: 'Route corridor, each side (nm)', default: 5 },
      language: { type: 'string', title: 'Preferred language for multilingual sources', enum: ['en', 'sv', 'fi'], default: 'en' },
      notifyScope: {
        type: 'string',
        title: 'Raise Signal K notifications for',
        enum: ['relevant', 'nearby', 'route', 'none'],
        enumNames: ['Near me or on my route', 'Near me only', 'On my route only', 'Nothing'],
        default: 'relevant'
      },
      notifyMinSeverity: { type: 'string', title: 'Minimum severity for notifications', enum: ['alert', 'warn', 'alarm'], default: 'alert' },
      chartResources: { type: 'boolean', title: 'Show relevant warnings on the chart (notes and regions)', default: true },
      pressurePath: { type: 'string', title: 'Barometer path (Pa)', default: 'environment.outside.pressure' },
      pressureWarnings: { type: 'boolean', title: 'Warn on fast pressure changes from the on-board barometer', default: true },
      saveRawResponses: { type: 'boolean', title: 'Save raw source responses for debugging', default: false },
      sources: {
        type: 'object',
        title: 'Sources',
        properties: Object.fromEntries(SOURCES.map(s => [s.id, {
          type: 'object',
          title: s.name + (s.experimental ? ' (experimental)' : '') + (s.probeOnly ? ' (probe only)' : ''),
          properties: {
            enabled: { type: 'boolean', title: 'Enabled', default: s.defaultEnabled },
            intervalMin: { type: 'number', title: 'Fetch interval (minutes)', default: s.defaultIntervalMin }
          }
        }]))
      }
    }
  })

  function withDefaults (o = {}) {
    const srcOpts = {}
    for (const s of SOURCES) {
      const so = (o.sources && o.sources[s.id]) || {}
      srcOpts[s.id] = {
        enabled: so.enabled !== undefined ? so.enabled : s.defaultEnabled,
        intervalMin: Math.max(5, so.intervalMin || s.defaultIntervalMin)
      }
    }
    return {
      radiusNm: 30,
      corridorNm: 5,
      language: 'en',
      notifyScope: 'relevant',
      notifyMinSeverity: 'alert',
      chartResources: true,
      pressurePath: 'environment.outside.pressure',
      pressureWarnings: true,
      saveRawResponses: false,
      ...o,
      sources: srcOpts
    }
  }

  function selfValue (p) {
    const v = app.getSelfPath ? app.getSelfPath(p) : undefined
    if (v && typeof v === 'object' && 'value' in v) return v.value
    return v
  }

  function ownPosition () {
    const p = selfValue('navigation.position')
    if (p && typeof p.latitude === 'number' && typeof p.longitude === 'number') return { latitude: p.latitude, longitude: p.longitude }
    return null
  }

  function route () {
    return store && store.state.route ? store.state.route.points : null
  }

  function saveRaw (sourceId, raw) {
    if (!options.saveRawResponses || !raw) return
    try {
      const dir = path.join(app.getDataDirPath(), 'raw')
      fs.mkdirSync(dir, { recursive: true })
      raw.forEach((r, i) => fs.writeFileSync(path.join(dir, `${sourceId}-${i}.txt`), `${r.url}\n\n${r.body}`))
    } catch (e) { app.debug(`raw save failed: ${e.message}`) }
  }

  async function runSource (src) {
    if (running.has(src.id)) return
    running.add(src.id)
    store.markAttempt(src.id)
    try {
      const result = await src.fetch({ http: httpClient, now: new Date(), options })
      saveRaw(src.id, result.raw)
      if (!src.probeOnly) {
        const tagged = result.warnings.map(w => ({ ...w, attribution: src.attribution }))
        store.update(src.id, tagged)
      } else {
        store.update(src.id, [])
      }
      app.debug(`${src.id}: ${result.warnings.length} warnings`)
    } catch (e) {
      store.markError(src.id, e)
      app.debug(`${src.id} failed: ${e.message}`)
    } finally {
      running.delete(src.id)
      evaluate()
    }
  }

  function sampleBarometer () {
    const v = selfValue(options.pressurePath)
    if (typeof v === 'number') {
      baro.add(v)
      store.state.pressure = baro.samples
      store.save()
    }
  }

  function currentWarnings () {
    const list = store.list()
    if (options.pressureWarnings) {
      const bw = baro.toWarning(ownPosition())
      if (bw) list.push({ ...bw, sources: ['onboard'] })
    }
    const ctx = { position: ownPosition(), route: route(), radiusNm: options.radiusNm, corridorNm: options.corridorNm }
    return sortWarnings(list.map(w => assess(w, ctx)))
  }

  function evaluate () {
    if (!store) return
    lastAssessed = currentWarnings()
    const minRank = SEVERITY_RANK[options.notifyMinSeverity] || 2
    const want = new Map()
    if (options.notifyScope !== 'none') {
      for (const w of lastAssessed) {
        if (!inScope(w, options.notifyScope)) continue
        if ((SEVERITY_RANK[w.severity] || 0) < minRank) continue
        want.set(sk.notificationPath(w), sk.notificationValue(w))
      }
    }
    const values = []
    for (const [p, v] of want) {
      const prev = published.get(p)
      if (!prev || prev.state !== v.state || prev.message !== v.message) values.push({ path: p, value: v })
    }
    for (const p of published.keys()) if (!want.has(p)) values.push({ path: p, value: sk.clearValue() })
    published = want
    if (values.length && app.handleMessage) {
      app.handleMessage(PLUGIN_ID, { updates: [{ values }] })
    }
  }

  function chartList () {
    if (!options || !options.chartResources) return []
    return lastAssessed.filter(w => inScope(w, 'relevant') && !w.onboard)
  }

  function registerResources () {
    if (typeof app.registerResourceProvider !== 'function') return
    const make = (type, convert) => ({
      type,
      methods: {
        listResources: async () => {
          const out = {}
          for (const w of chartList()) {
            const r = convert(w)
            if (r) out[sk.uuidFor(w.id)] = r
          }
          return out
        },
        getResource: async (id) => {
          const w = chartList().find(x => sk.uuidFor(x.id) === id)
          const r = w && convert(w)
          if (!r) throw new Error('Not found')
          return r
        },
        setResource: async () => { throw new Error('Read only: warnings come from official sources') },
        deleteResource: async () => { throw new Error('Read only: warnings come from official sources') }
      }
    })
    try {
      app.registerResourceProvider(make('notes', sk.toNote))
      app.registerResourceProvider(make('regions', sk.toRegion))
    } catch (e) {
      app.debug(`resource provider registration failed: ${e.message}`)
    }
  }

  plugin.start = function (opts) {
    options = withDefaults(opts)
    const dataDir = app.getDataDirPath()
    store = new Store(path.join(dataDir, 'warnings.json'))
    baro = new Barometer(store.state.pressure || [])
    published = new Map()
    registerResources()

    let delay = 2000
    for (const src of SOURCES) {
      if (!options.sources[src.id].enabled) continue
      const interval = options.sources[src.id].intervalMin * 60e3
      timers.push(setTimeout(() => runSource(src), delay))
      timers.push(setInterval(() => runSource(src), interval))
      delay += 3000
    }
    sampleBarometer()
    timers.push(setInterval(sampleBarometer, 5 * 60e3))
    timers.push(setInterval(evaluate, 60e3))
    evaluate()
    if (app.setPluginStatus) app.setPluginStatus('Started')
  }

  plugin.stop = function () {
    timers.forEach(t => { clearTimeout(t); clearInterval(t) })
    timers = []
    if (store) {
      // clear our notifications
      const values = [...published.keys()].map(p => ({ path: p, value: sk.clearValue() }))
      if (values.length && app.handleMessage) app.handleMessage(PLUGIN_ID, { updates: [{ values }] })
      store.saveNow()
    }
    published = new Map()
  }

  function readBody (req) {
    if (req.body && typeof req.body === 'object') return Promise.resolve(req.body)
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', c => { data += c })
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
      req.on('error', reject)
    })
  }

  plugin.registerWithRouter = function (router) {
    // GET /plugins/signalk-baltic-warnings/warnings?scope=relevant|nearby|route|all
    router.get('/warnings', (req, res) => {
      if (!store) return res.status(503).json({ error: 'not started' })
      const scope = req.query.scope || 'relevant'
      const list = lastAssessed.filter(w => inScope(w, scope))
      res.json({
        updated: new Date().toISOString(),
        position: ownPosition(),
        route: store.state.route,
        scope,
        count: list.length,
        warnings: list
      })
    })

    router.get('/status', (req, res) => {
      if (!store) return res.status(503).json({ error: 'not started' })
      const sources = SOURCES.map(s => ({
        id: s.id,
        name: s.name,
        enabled: options.sources[s.id].enabled,
        experimental: !!s.experimental,
        probeOnly: !!s.probeOnly,
        attribution: s.attribution,
        ...store.sourceStatus(s.id)
      }))
      res.json({ sources, barometer: baro.classify() })
    })

    router.get('/history', (req, res) => {
      if (!store) return res.status(503).json({ error: 'not started' })
      res.json(Object.values(store.state.history).sort((a, b) => b.removedAt.localeCompare(a.removedAt)))
    })

    // PUT /route { name, points: [{ latitude, longitude }, ...] } — planned route, e.g. from Sailpartner
    router.put('/route', async (req, res) => {
      try {
        const body = await readBody(req)
        const points = (body.points || []).filter(p => typeof p.latitude === 'number' && typeof p.longitude === 'number')
        if (points.length < 2) return res.status(400).json({ error: 'route needs at least 2 points with latitude and longitude' })
        store.state.route = { name: body.name || 'Planned route', points, setAt: new Date().toISOString() }
        store.save()
        evaluate()
        res.json({ ok: true, route: store.state.route })
      } catch (e) {
        res.status(400).json({ error: e.message })
      }
    })

    router.delete('/route', (req, res) => {
      if (!store) return res.status(503).json({ error: 'not started' })
      store.state.route = null
      store.save()
      evaluate()
      res.json({ ok: true })
    })

    router.post('/refresh', (req, res) => {
      if (!store) return res.status(503).json({ error: 'not started' })
      const active = SOURCES.filter(s => options.sources[s.id].enabled)
      Promise.all(active.map(runSource)).then(() => res.json({ ok: true, sources: active.map(s => s.id) }))
    })
  }

  // exposed for tests
  plugin._internals = { runSource, evaluate, get store () { return store }, get assessed () { return lastAssessed }, get published () { return published } }

  return plugin
}
