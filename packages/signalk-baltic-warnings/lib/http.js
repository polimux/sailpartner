'use strict'

const pkg = require('../package.json')
const USER_AGENT = `signalk-baltic-warnings/${pkg.version} (+https://github.com/signalk)`

async function fetchText (url, { timeoutMs = 20000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en,de;q=0.8', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow'
  })
  const body = await res.text()
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`)
    err.status = res.status
    throw err
  }
  return body
}

async function fetchJson (url, opts = {}) {
  const body = await fetchText(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } })
  return { json: JSON.parse(body), body }
}

module.exports = { fetchText, fetchJson, USER_AGENT }
