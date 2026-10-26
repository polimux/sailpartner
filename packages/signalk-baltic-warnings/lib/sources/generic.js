'use strict'

// Sources that are fetched and parsed with the generic NAVTEX block parser, plus
// probe-only sources whose formats still need to be confirmed on a live run.
// Most of their coastal warnings already arrive through BALTICO; these add
// national local warnings once verified.

const { htmlToText } = require('../html')
const { parseWarningBlocks } = require('../blocks')

function textSource ({ id, name, url, attribution }) {
  return {
    id,
    name,
    url,
    attribution,
    defaultEnabled: false,
    defaultIntervalMin: 60,
    experimental: true,
    async fetch ({ http, now }) {
      const body = await http.fetchText(url)
      const text = /<html|<body|<div/i.test(body) ? htmlToText(body) : body
      const warnings = parseWarningBlocks(text, { now }).map(w => ({ ...w, url }))
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
    url: 'http://www.navtex.lv/',
    attribution: 'Latvian Hydrographic Service'
  }),
  ltsa: textSource({
    id: 'ltsa',
    name: 'LTSA (Lithuania)',
    url: 'https://ltsa.lrv.lt/lt/veiklos-sritys/hidrografine-veikla/navigational-warnings',
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
