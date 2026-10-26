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

const RAW_IN_REPORT = 5000
const { htmlToText } = require('../lib/html')

// The useful part of a response for the report: readable text of web pages,
// addresses found in scripts, the start of everything else.
function excerpt (url, body) {
  if (/\.js(\?|$)/.test(url)) {
    const urls = [...new Set(body.match(/https?:\/\/[^"'\s\\)]+/g) || [])]
    return ['Addresses in this script:', ...urls.slice(0, 80).map(u => '  ' + u)]
  }
  if (/^\s*(<!doctype|<html)/i.test(body)) {
    // skip menus: start at the main content when the page marks it
    const at = ['<main', 'id="content"', 'id="main"'].map(m => body.indexOf(m)).filter(i => i > 0).sort((a, b) => a - b)[0] || 0
    const text = htmlToText(body.slice(at)).replace(/\n{3,}/g, '\n\n').trim()
    return ['Page text:', text.slice(0, RAW_IN_REPORT)]
  }
  return ['Start:', body.slice(0, RAW_IN_REPORT)]
}

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
    let raw = null
    try {
      const result = await src.fetch({ http, now: new Date(), options: { language: 'en' } })
      const warnings = result.warnings
      raw = result.raw
      const line = src.probeOnly ? `OK (probe only: ${src.note})${result.note ? ' — ' + result.note : ''}` : `OK: ${warnings.length} warnings read${result.note ? ' — ' + result.note : ''}`
      process.stdout.write(line + '\n')
      report.push(line)
      all.push(...warnings.map(w => ({ ...w, sources: [src.id] })))
      for (const w of warnings.slice(0, 5)) report.push(`  e.g. ${w.label}: ${w.title}${w.validTo ? ' (until ' + w.validTo + ')' : ''}`)
    } catch (e) {
      process.stdout.write(`FAILED: ${e.message}\n`)
      report.push(`FAILED: ${e.message}`)
      raw = e.raw || null
    }
    // what the servers sent — fetched again if the source did not hand it back
    if (!raw || !raw.length) {
      raw = []
      for (const url of src.urls || []) {
        try { raw.push({ url, body: await http.fetchText(url) }) } catch (e) {
          report.push('', `--- ${url}`, `could not load: ${e.message}`)
          if (e.body) report.push('server answered:', e.body)
        }
      }
    }
    for (const [i, { url, body }] of raw.entries()) {
      fs.writeFileSync(path.join(outDir, `${src.id}-${i}.txt`), `${url}\n\n${body}`)
      report.push('', `--- ${url}`, `${body.length} characters, saved as ${src.id}-${i}.txt`)
      report.push(...excerpt(url, body))
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
