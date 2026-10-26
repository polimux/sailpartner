'use strict'

// Generic parser for pages that list NAVTEX-style coastal warnings, e.g.
//
//   §H§Western Baltic
//   141014 UTC OCT
//   GERMAN NAV WARN
//   580/26 WESTERN BALTIC.FEHMARN. PROHIBITED AREA.
//   'SPERR-G.1' LIGHTBUOY 54-31,5N 011-18,5E TEMPORARILY WITHDRAWN.
//
// Works on the text produced by html.htmlToText (or plain NAVTEX text).

const { parseDtg, parseValidity, parseCancels, classify, SEVERITY, normalizeAreaName, warningId } = require('./navtext')
const { geometryFromText } = require('./geo')

// The issue time stands alone on its line ("202201 UTC OCT"); validity lines such as
// "302100 UTC SEP THRU 312100 UTC OCT" carry more text and stay inside the warning.
const DTG_LINE = /^(\d{6})\s*UTC\s*([A-Z]{3})(?:\s*(\d{2,4}))?\.?$/
const HEADER = /([A-Z][A-Z .-]*?NAV\s*WARN(?:ING)?)\s*(?:NO\.?\s*)?(\d{1,4}(?:\(T\))?\/\d{2})/
// A header at the start of a line (optionally after the issue time). Mentions inside
// the text, like "CANCEL NAV WARN 516/26", do not start a new warning.
const HEADER_START = /^(?:\d{6}\s*UTC\s*[A-Z]{3}\s+)?([A-Z][A-Z .-]*?NAV\s*WARN(?:ING)?)\s*(?:NO\.?\s*)?(\d{1,4}(?:\(T\))?\/\d{2})/

function parseWarningBlocks (text, opts = {}) {
  const now = opts.now || new Date()
  const lines = String(text || '').split('\n')
  const blocks = []
  let area = null
  let cur = null
  const finish = () => { if (cur && cur.lines.length) blocks.push(cur); cur = null }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('§H§')) {
      finish()
      area = line.slice(3).trim()
      continue
    }
    if (/^NO CURRENT WARNINGS/i.test(line)) continue
    if (/^(ZCZC|NNNN)\b/.test(line)) continue // NAVTEX start/end markers
    const dtg = DTG_LINE.exec(line.toUpperCase())
    // a bare DTG inside a warning body (before its header was seen) does not split it
    if (dtg && (!cur || HEADER.test(cur.lines.join('\n').toUpperCase()))) {
      finish()
      cur = { dtg: line, area, lines: [] }
      continue
    }
    // A header line starts a new warning when the current one already has its header
    // (layouts that put "DTG + NAV WARN nnn/yy" on one line, or plain NAVTEX text).
    const upperLine = line.toUpperCase()
    const hs = HEADER_START.exec(upperLine)
    if (hs && !/CANCEL/.test(hs[1]) && (!cur || HEADER.test(cur.lines.join('\n').toUpperCase()))) {
      finish()
      const inline = /^(\d{6}\s*UTC\s*[A-Z]{3})\b/.exec(upperLine)
      cur = { dtg: inline ? inline[1] : null, area, lines: [] }
      if (inline) { cur.lines.push(line.slice(inline[0].length).trim()); continue }
    }
    if (cur) cur.lines.push(line)
  }
  finish()

  const byId = new Map()
  for (const b of blocks) {
    const joined = b.lines.join('\n')
    const m = HEADER.exec(joined.toUpperCase())
    if (!m) continue
    const ident = warningId(m[1], m[2])
    const body = joined.slice(m.index + m[0].length).trim()
    const firstLine = body.split('\n')[0] || ''
    const title = firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine
    const issued = b.dtg ? parseDtg(b.dtg.toUpperCase(), now) : null
    const validity = parseValidity(body, now)
    const category = classify(body)
    const areaName = b.area && !/^(AREA|MENU|DOCUMENTS|RELATED LINKS)$/i.test(b.area) ? normalizeAreaName(b.area) : null

    const existing = byId.get(ident.id)
    if (existing) {
      if (areaName && !existing.areas.includes(areaName)) existing.areas.push(areaName)
      continue
    }
    byId.set(ident.id, {
      id: ident.id,
      issuer: ident.issuer,
      number: ident.number,
      label: `${ident.issuer} NAV WARN ${ident.number}`,
      title,
      text: body,
      areas: areaName ? [areaName] : [],
      category,
      severity: SEVERITY[category] || 'alert',
      issued: issued ? issued.toISOString() : null,
      validFrom: validity.validFrom,
      validTo: validity.validTo,
      cancels: parseCancels(body),
      geometry: geometryFromText(body)
    })
  }
  return [...byId.values()]
}

module.exports = { parseWarningBlocks }
