'use strict'

// Sources that are fetched and parsed with the generic NAVTEX block parser, plus
// probe-only sources whose formats still need to be confirmed on a live run.
// Most of their coastal warnings already arrive through BALTICO; these add
// national local warnings once verified.

const { htmlToText } = require('../html')
const { parseWarningBlocks } = require('../blocks')

function textSource ({ id, name, urls, attribution, coveredBy = null, timeoutMs = 10000, note = null, filter = null }) {
  return {
    id,
    name,
    urls,
    attribution,
    coveredBy,
    note,
    defaultEnabled: false,
    defaultIntervalMin: 60,
    experimental: true,
    async fetch ({ http, now }) {
      // try each address in turn (e.g. https first, then http)
      let body = null; let url = null; const errors = []
      for (const u of urls) {
        try { body = await http.fetchText(u, { timeoutMs }); url = u; break } catch (e) { errors.push(e) }
      }
      if (body === null) {
        // same reason for every address (e.g. https and http both time out): say it once
        const msgs = [...new Set(errors.map(e => e.message.replace(/\(https?:\/\//, '(')))]
        throw new Error(msgs.join(' · '))
      }
      const text = /<html|<body|<div/i.test(body) ? htmlToText(body) : body
      let warnings = parseWarningBlocks(text, { now }).map(w => ({ ...w, url }))
      let extra = null
      if (filter) ({ warnings, note: extra } = filter(warnings))
      if (!warnings.length && !/NAV\s*WARN/i.test(text)) {
        const err = new Error('page loaded, but no warnings could be read from it (format not supported yet — run the probe and send the report)')
        err.raw = [{ url, body }]
        throw err
      }
      return { warnings, raw: [{ url, body }], note: extra }
    }
  }
}

// navtex.lv shows what its receiver picks up on 518 kHz: every station in
// range, including French AVURNAVs, with radio reception errors ("_" and
// stray characters). Keep only warnings of Baltic issuers that came through
// cleanly; the clean text of the same warnings also arrives via BALTICO.
const BALTIC_ISSUERS = /^(GERMAN|DANISH|SWEDISH|FINNISH|ESTONIAN|LATVIAN|LITHUANIAN|POLISH|KALININGRAD|KALINGRAD|RUSSIAN|PETERSBURG|BALTIC SEA)$/
function garbled (s) {
  const t = String(s || '')
  const junk = (t.match(/[_$*!=+]|[^\x20-\x7E\n\u00C0-\u017F]/g) || []).length
  return junk > Math.max(2, t.length * 0.02)
}
function cleanRadio (warnings) {
  let skipped = 0
  const kept = []
  for (const w of warnings) {
    if (!BALTIC_ISSUERS.test(w.issuer) || /^CANCEL/.test(w.issuer)) continue
    if (garbled(w.title) || garbled(w.text)) { skipped++; continue }
    kept.push({ ...w, areas: [] }) // the page's "AREA: A" lines are NAVTEX station areas, not sea areas
  }
  return { warnings: kept, note: skipped ? `${skipped} warnings with reception errors skipped` : null }
}

function probeSource ({ id, name, urls, attribution, note }) {
  return {
    id,
    name,
    attribution,
    note,
    defaultEnabled: false,
    defaultIntervalMin: 60,
    probeOnly: true,
    urls,
    async fetch ({ http }) {
      const raw = []; const errors = []
      for (const url of urls) {
        try { raw.push({ url, body: await http.fetchText(url) }) } catch (e) { errors.push(e.message) }
      }
      if (!raw.length) throw new Error(errors.join(' · '))
      return { warnings: [], raw, note: errors.length ? errors.join(' · ') : null }
    }
  }
}

module.exports = {
  cleanRadio,
  navtexlv: textSource({
    id: 'navtexlv',
    name: 'navtex.lv (Latvia)',
    urls: ['https://navtex.lv/', 'https://www.navtex.lv/', 'http://navtex.lv/'],
    attribution: 'Latvian Hydrographic Service',
    coveredBy: 'BALTICO',
    note: 'raw radio reception; only clean Baltic warnings are used',
    filter: cleanRadio
  }),
  elwis: probeSource({
    id: 'elwis',
    name: 'ELWIS BfS and firing ranges (probe)',
    // BfS list (all sea regions); firing times for Todendorf/Putlos are issued by WSA Lübeck
    urls: ['https://www.elwis.de/DE/dynamisch/Bfs/bfsSeeregion:alle', 'https://www.elwis.de/DE/dynamisch/BfS/index.php'],
    attribution: 'Wasserstraßen- und Schifffahrtsverwaltung des Bundes (ELWIS)',
    note: 'Saves raw responses only; parser follows once the live format is confirmed.'
  })
}
