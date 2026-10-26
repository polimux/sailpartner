'use strict'

const pkg = require('../package.json')
const USER_AGENT = `sailwarnings/${pkg.version} (Signal K plugin; +https://github.com/polimux/sailpartner)`

// Node's fetch reports network problems only as "fetch failed"; the real reason
// (DNS, refused, timeout, certificate) is in err.cause. Turn it into a useful message.
function describeError (e, url) {
  const host = (() => { try { return new URL(url).host } catch (x) { return url } })()
  if (e && e.name === 'TimeoutError') return `timeout after 20 s (${host})`
  const c = e && e.cause
  const code = c && (c.code || (c.errors && c.errors[0] && c.errors[0].code))
  const known = {
    ENOTFOUND: 'host not found (DNS) — no internet, or the address is wrong',
    EAI_AGAIN: 'DNS lookup failed — no internet?',
    ECONNREFUSED: 'connection refused',
    ECONNRESET: 'connection reset by the server',
    ETIMEDOUT: 'connection timed out',
    UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
    CERT_HAS_EXPIRED: 'the site\'s certificate has expired',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate could not be verified',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
    ERR_TLS_CERT_ALTNAME_INVALID: 'certificate does not match the host name'
  }
  if (code) return `${known[code] || code} (${host})`
  if (c && c.message) return `${c.message} (${host})`
  return `${(e && e.message) || String(e)} (${host})`
}

async function fetchText (url, { timeoutMs = 20000, headers = {} } = {}) {
  let res
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en,de;q=0.8', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow'
    })
  } catch (e) {
    const err = new Error(describeError(e, url))
    err.cause = e
    throw err
  }
  const body = await res.text()
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''} from ${new URL(res.url || url).host}${new URL(res.url || url).pathname}`)
    err.status = res.status
    err.body = body.slice(0, 500)
    throw err
  }
  return body
}

async function fetchJson (url, opts = {}) {
  const body = await fetchText(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } })
  try {
    return { json: JSON.parse(body), body }
  } catch (e) {
    const err = new Error(`not JSON (starts with: ${body.slice(0, 60).replace(/\s+/g, ' ')}…)`)
    err.body = body.slice(0, 500)
    throw err
  }
}

module.exports = { fetchText, fetchJson, describeError, USER_AGENT }
