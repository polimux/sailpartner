'use strict'

// Some servers (navtex.lv for one) send their certificate without the
// intermediate certificate. Browsers quietly download the missing piece from
// the address written in the certificate ("CA Issuers", AIA); Node doesn't and
// fails with "unable to verify the first certificate".
//
// This does what the browser does: read the server certificate, download the
// intermediate it names, and retry with it. The chain is still fully checked
// against Node's trusted root certificates — nothing is switched off.

const tls = require('tls')
const https = require('https')
const http = require('http')
const { X509Certificate } = require('crypto')

const cache = new Map() // host -> PEM of the intermediate

function peerIssuerUrl (host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = sock.getPeerCertificate(false)
      sock.end()
      const ia = cert && cert.infoAccess && cert.infoAccess['CA Issuers - URI']
      ia && ia[0] ? resolve(ia[0]) : reject(new Error('certificate names no issuer to download'))
    })
    sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout reading certificate')) })
    sock.on('error', reject)
  })
}

function getRaw (url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http
    const req = mod.get(url, { timeout: timeoutMs }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(getRaw(new URL(res.headers.location, url).href, timeoutMs))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for issuer certificate`)) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('timeout', () => req.destroy(new Error('timeout downloading issuer certificate')))
    req.on('error', reject)
  })
}

function toPem (buf) {
  const s = buf.toString('latin1')
  if (s.includes('-----BEGIN CERTIFICATE-----')) return s
  return new X509Certificate(buf).toString()
}

async function intermediateFor (host, port, timeoutMs) {
  if (cache.has(host)) return cache.get(host)
  const issuerUrl = await peerIssuerUrl(host, port, timeoutMs)
  const pem = toPem(await getRaw(issuerUrl, timeoutMs))
  cache.set(host, pem)
  return pem
}

// GET a page over https, adding the server's missing intermediate certificate.
async function fetchTextWithAia (url, { timeoutMs = 20000, headers = {}, roots = tls.rootCertificates } = {}, redirects = 3) {
  const u = new URL(url)
  const port = Number(u.port || 443)
  const pem = await intermediateFor(u.hostname, port, timeoutMs)
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca: [...roots, pem], headers, timeout: timeoutMs }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume()
        const next = new URL(res.headers.location, url).href
        return resolve(next.startsWith('https:') ? fetchTextWithAia(next, { timeoutMs, headers, roots }, redirects - 1) : Promise.reject(new Error(`redirected to ${next}`)))
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode >= 400) {
          const err = new Error(`HTTP ${res.statusCode} from ${u.host}${u.pathname}`)
          err.status = res.statusCode; err.body = body.slice(0, 500)
          return reject(err)
        }
        resolve(body)
      })
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s (${u.host})`), { name: 'TimeoutError' })))
    req.on('error', reject)
  })
}

module.exports = { fetchTextWithAia, _cache: cache }
