'use strict'

// A server that sends its certificate without the intermediate (like navtex.lv):
// plain fetch fails, the repair downloads the intermediate named in the
// certificate and the full chain is verified against the (test) root.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const { fetchTextWithAia, _cache } = require('../lib/aia')

const dir = path.join(__dirname, 'fixtures', 'aia')
const read = f => fs.readFileSync(path.join(dir, f))

test('missing intermediate certificate is fetched and verified', async (t) => {
  const issuer = http.createServer((req, res) => { res.end(read('int.der')) }).listen(47811)
  const site = https.createServer({ key: read('leaf.key'), cert: read('leaf.pem') }, (req, res) => res.end('ZCZC NAVTEX OK')).listen(0)
  t.after(() => { issuer.close(); site.close() })
  await new Promise(r => site.on('listening', r))
  const url = `https://localhost:${site.address().port}/`
  const root = read('root.pem').toString()

  // without the repair, even a trusted root does not help: the chain is incomplete
  await assert.rejects(new Promise((resolve, reject) => https.get(url, { ca: [root] }, resolve).on('error', reject)), /UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to verify/i)

  _cache.clear()
  assert.equal(await fetchTextWithAia(url, { roots: [root] }), 'ZCZC NAVTEX OK')

  // the chain is still checked: with Node's real roots the test root is unknown
  _cache.clear()
  await assert.rejects(fetchTextWithAia(url), /self.signed|unable to get|issuer/i)
})
