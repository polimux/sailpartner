#!/usr/bin/env node
'use strict'

// Checks every warning source once and writes one report you can send in:
//
//   node packages/sailwarnings/bin/probe.js [lat lon]
//   e.g. node packages/sailwarnings/bin/probe.js 54.373 11.004   (Heiligenhafen)
//
// Output (in the current folder):
//   probe-output/probe-report.txt   status of every source + the start of every page
//   probe-output/<source>-<n>.txt   the full raw pages
//   probe-output/parsed.json        all warnings that could be read, sorted for the position

const fs = require('fs')
const path = require('path')
const http = require('../lib/http')
const SOURCES = require('../lib/sources')
const { assess, sortWarnings } = require('../lib/relevance')
const pkg = require('../package.json')

const RAW_IN_REPORT = 3000

async function main () {
  const [lat, lon] = process.argv.slice(2).map(Number)
  const position = isFinite(lat) && isFinite(lon) ? { latitude: lat, longitude: lon } : null
  const outDir = path.join(process.cwd(), 'probe-output')
  fs.mkdirSync(outDir, { recursive: true })
  const report = [
    `sailwarnings ${pkg.version} probe — ${new Date().toISOString()}`,
    `node ${process.version} on ${process.platform}${position ? ` · position ${lat}, ${lon}` : ''}`,
    ''
  ]
  const all = []

  for (const src of SOURCES) {
    process.stdout.write(`\n== ${src.name} ==\n`)
    report.push('='.repeat(78), src.name, '='.repeat(78))
    try {
      const { warnings } = await src.fetch({ http, now: new Date(), options: { language: 'en' } })
      const line = src.probeOnly ? `OK (probe only: ${src.note})` : `OK: ${warnings.length} warnings read`
      process.stdout.write(line + '\n')
      report.push(line)
      all.push(...warnings.map(w => ({ ...w, sources: [src.id] })))
      for (const w of warnings.slice(0, 3)) report.push(`  e.g. ${w.label}: ${w.title}`)
    } catch (e) {
      process.stdout.write(`FAILED: ${e.message}\n`)
      report.push(`FAILED: ${e.message}`)
    }
    // the raw pages, fetched again so the report has them even when parsing failed
    for (const [i, url] of (src.urls || []).entries()) {
      report.push('', `--- ${url}`)
      try {
        const body = await http.fetchText(url)
        fs.writeFileSync(path.join(outDir, `${src.id}-${i}.txt`), `${url}\n\n${body}`)
        report.push(`${body.length} characters, saved as ${src.id}-${i}.txt. Start:`, body.slice(0, RAW_IN_REPORT))
      } catch (e) {
        report.push(`could not load: ${e.message}`)
        if (e.body) report.push('server answered:', e.body)
      }
    }
    report.push('')
  }

  const assessed = sortWarnings(all.map(w => assess(w, { position, radiusNm: 30 })))
  process.stdout.write(`\n== ${assessed.length} warnings${position ? ' sorted for ' + lat + ', ' + lon : ''} ==\n`)
  for (const w of assessed.slice(0, 30)) {
    const d = w.distanceNm !== null ? `${w.distanceNm} nm` : 'no position'
    process.stdout.write(`[${w.severity.padEnd(5)}] ${w.relevance.padEnd(7)} ${d.padEnd(12)} ${w.label} · ${w.title}\n`)
  }
  fs.writeFileSync(path.join(outDir, 'parsed.json'), JSON.stringify(assessed, null, 2))
  fs.writeFileSync(path.join(outDir, 'probe-report.txt'), report.join('\n'))
  process.stdout.write(`\nReport: ${path.join(outDir, 'probe-report.txt')}\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
