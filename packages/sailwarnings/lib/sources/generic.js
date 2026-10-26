'use strict'

// Sources that are fetched and parsed with the generic NAVTEX block parser, plus
// probe-only sources whose formats still need to be confirmed on a live run.
// Most of their coastal warnings already arrive through BALTICO; these add
// national local warnings once verified.

const { htmlToText } = require('../html')
const { parseWarningBlocks } = require('../blocks')

function textSource ({ id, name, urls, attribution }) {
  return {
    id,
    name,
    urls,
    attribution,
    defaultEnabled: false,
    defaultIntervalMin: 60,
    experimental: true,
    async fetch ({ http, now }) {
      // try each address in turn (e.g. https first, then http)
      let body = null; let url = null; let lastErr = null
      for (const u of urls) {
        try { body = await http.fetchText(u); url = u; break } catch (e) { lastErr = e }
      }
      if (body === null) throw lastErr
      const text = /<html|<body|<div/i.test(body) ? htmlToText(body) : body
      const warnings = parseWarningBlocks(text, { now }).map(w => ({ ...w, url }))
      if (!warnings.length && !/NAV\s*WARN/i.test(text)) {
        const err = new Error('page loaded, but no warnings could be read from it (format not supported yet — run the probe and send the report)')
        err.raw = [{ url, body }]
        throw err
      }
      return { warnings, raw: [{ url, body }] }
    }
  }
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
      const raw = []
      for (const url of urls) raw.push({ url, body: await http.fetchText(url) })
      return { warnings: [], raw }
    }
  }
}

module.exports = {
  navtexlv: textSource({
    id: 'navtexlv',
    name: 'navtex.lv (Latvia)',
    urls: ['https://www.navtex.lv/', 'http://www.navtex.lv/'],
    attribution: 'Latvian Hydrographic Service'
  }),
  // Official portal named in Lithuania's 2024 national report to the IHO (BSHC29).
  ltsa: textSource({
    id: 'ltsa',
    name: 'LTSA (Lithuania)',
    urls: ['https://hydro.eltsa.lt/nw/en.html'],
    attribution: 'Lithuanian Transport Safety Administration'
  }),
  dwd: probeSource({
    id: 'dwd',
    name: 'DWD sea and coast warnings (probe)',
    urls: [
      'https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16/warnings_coast_en.json',
      'https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16/sea_warning_text.json'
    ],
    attribution: 'Deutscher Wetterdienst',
    note: 'Saves raw responses only; parser follows once the live format is confirmed.'
  }),
  elwis: probeSource({
    id: 'elwis',
    name: 'ELWIS BfS and firing ranges (probe)',
    urls: ['https://www.elwis.de/DE/dynamisch/BfS/'],
    attribution: 'Wasserstraßen- und Schifffahrtsverwaltung des Bundes (ELWIS)',
    note: 'Saves raw responses only; parser follows once the live format is confirmed.'
  })
}
