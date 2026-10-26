'use strict'

// BALTICO — Baltic Sea sub-area coordinator at the Swedish Maritime Administration.
// The NAVTEX page carries the coastal warnings of all Baltic states (German, Danish,
// Polish, Lithuanian, Latvian, Estonian, Finnish, Russian, Swedish) plus
// BALTIC SEA NAV WARNs. The VHF page adds Swedish local warnings.

const { htmlToText } = require('../html')
const { parseWarningBlocks } = require('../blocks')

const PAGES = [
  { url: 'https://navvarn.sjofartsverket.se/en/Navigationsvarningar/Navtex', channel: 'NAVTEX' },
  { url: 'https://navvarn.sjofartsverket.se/en/Navigationsvarningar/VHF', channel: 'VHF' }
]

function parsePage (html, page, now) {
  return parseWarningBlocks(htmlToText(html), { now }).map(w => ({ ...w, channels: [page.channel], url: page.url }))
}

module.exports = {
  id: 'sjofartsverket',
  name: 'BALTICO / Sjöfartsverket (all Baltic states)',
  defaultEnabled: true,
  defaultIntervalMin: 30,
  attribution: 'Swedish Maritime Administration (Sjöfartsverket), BALTICO',
  parsePage,
  async fetch ({ http, now }) {
    const raw = []
    const byId = new Map()
    for (const page of PAGES) {
      const html = await http.fetchText(page.url)
      raw.push({ url: page.url, body: html })
      for (const w of parsePage(html, page, now)) {
        const ex = byId.get(w.id)
        if (!ex) { byId.set(w.id, w); continue }
        for (const a of w.areas) if (!ex.areas.includes(a)) ex.areas.push(a)
        for (const c of w.channels) if (!ex.channels.includes(c)) ex.channels.push(c)
      }
    }
    return { warnings: [...byId.values()], raw }
  }
}
