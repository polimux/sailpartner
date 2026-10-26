#!/usr/bin/env node
'use strict'

// Fetches every source once, prints what was parsed and saves raw responses to
// ./probe-output. Run on the Pi (or any machine with internet):
//   node bin/probe.js [lat lon]
// e.g. node bin/probe.js 54.373 11.004   (Heiligenhafen)

const fs = require('fs')
const path = require('path')
const http = require('../lib/http')
const SOURCES = require('../lib/sources')
const { assess, sortWarnings } = require('../lib/relevance')

async function main () {
  const [lat, lon] = process.argv.slice(2).map(Number)
  const position = isFinite(lat) && isFinite(lon) ? { latitude: lat, longitude: lon } : null
  const outDir = path.join(process.cwd(), 'probe-output')
  fs.mkdirSync(outDir, { recursive: true })
  const all = []
  for (const src of SOURCES) {
    process.stdout.write(`\n== ${src.name} ==\n`)
    try {
      const { warnings, raw } = await src.fetch({ http, now: new Date(), options: { language: 'en' } })
      raw.forEach((r, i) => fs.writeFileSync(path.join(outDir, `${src.id}-${i}.txt`), `${r.url}\n\n${r.body}`))
      process.stdout.write(`OK: ${warnings.length} warnings, ${raw.length} raw responses saved\n`)
      if (src.probeOnly) process.stdout.write(`(probe only: ${src.note})\n`)
      all.push(...warnings.map(w => ({ ...w, sources: [src.id] })))
    } catch (e) {
      process.stdout.write(`FAILED: ${e.message}\n`)
    }
  }
  const assessed = sortWarnings(all.map(w => assess(w, { position, radiusNm: 30 })))
  process.stdout.write(`\n== ${assessed.length} warnings${position ? ' sorted for ' + lat + ', ' + lon : ''} ==\n`)
  for (const w of assessed.slice(0, 40)) {
    const d = w.distanceNm !== null ? `${w.distanceNm} nm` : 'no position'
    process.stdout.write(`[${w.severity.padEnd(5)}] ${w.relevance.padEnd(7)} ${d.padEnd(12)} ${w.label} · ${w.title}\n`)
  }
  fs.writeFileSync(path.join(outDir, 'parsed.json'), JSON.stringify(assessed, null, 2))
  process.stdout.write(`\nParsed result written to ${path.join(outDir, 'parsed.json')}\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
