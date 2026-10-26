'use strict'

const pkg = require('../package.json')
const USER_AGENT = `sailpartner/${pkg.version}`

async function fetchJson (url, { timeoutMs = 20000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs)
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('?')[0]}`)
  return JSON.parse(body)
}

module.exports = { fetchJson }
