'use strict'

// ELWIS "Bekanntmachungen für Seefahrer" (BfS). The page is a search form;
// results only appear after submitting it. We fill it in like a browser:
// publisher "WSA Ostsee" (formerly WSA Lübeck — it issues the firing times
// for Todendorf/Putlos), everything else as the form suggests.
// Probe only for now: the result page is saved so the parser can be written
// against the real layout.

const { parseForms, fill, describe } = require('../forms')

const PAGE = 'https://www.elwis.de/DE/dynamisch/Bfs/bfsSeeregion:alle'
const PUBLISHER = /WSA Ostsee/i

function searchRequest (html) {
  const forms = parseForms(html, PAGE)
  const form = forms.find(f => f.fields.some(x => x.options && x.options.some(o => PUBLISHER.test(o.label)) && /herausgeber|amt|issuer|dienst/i.test(x.name + f.text)) && f.fields.length > 3) ||
    forms.find(f => f.fields.some(x => x.options && x.options.some(o => PUBLISHER.test(o.label))))
  if (!form) return { forms, req: null }
  // the publisher select of the search form (not the "BfS-Nr." lookup above it)
  const pubs = form.fields.filter(x => x.options && x.options.some(o => PUBLISHER.test(o.label)))
  const pub = pubs.find(x => x.options.some(o => /alle/i.test(o.label))) || pubs[pubs.length - 1]
  const values = { [pub.name]: pub.options.find(o => PUBLISHER.test(o.label)).value }
  const submit = form.fields.find(x => x.type === 'submit' && /suche/i.test(x.value))
  return { forms, form, req: fill(form, values, submit && submit.name) }
}

module.exports = {
  id: 'elwis',
  name: 'ELWIS BfS and firing ranges (probe)',
  defaultEnabled: false,
  defaultIntervalMin: 180,
  probeOnly: true,
  note: 'Saves the WSA Ostsee search result; parser follows.',
  urls: [PAGE],
  attribution: 'Wasserstraßen- und Schifffahrtsverwaltung des Bundes (ELWIS)',
  searchRequest,
  async fetch ({ http }) {
    const html = await http.fetchText(PAGE)
    const raw = [{ url: PAGE, body: html }]
    const { forms, req } = searchRequest(html)
    if (!req) throw Object.assign(new Error(`search form not found\n${describe(forms)}`), { raw })
    const result = await http.fetchText(req.url, { method: req.method, body: req.body })
    raw.push({ url: `${req.method} ${req.url}${req.body ? '  body: ' + req.body : ''}`, body: result })
    return { warnings: [], raw, note: `form: ${describe([forms.find(f => f.action === req.url.split('?')[0]) || forms[0]]).split('\n')[0]}` }
  }
}
