'use strict'

// Minimal, dependency-free HTML to text conversion that keeps line structure.
// Headings h1–h6 are marked with "§H§" so parsers can track sections.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', prime: '′', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bdquo: '„', deg: '°', aring: 'å', Aring: 'Å', auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', szlig: 'ß' }

function decodeEntities (s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n] !== undefined ? NAMED[n] : m)
}

function htmlToText (html) {
  let s = String(html || '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, inner) => '\n§H§' + inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() + '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/?(p|div|li|ul|ol|tr|table|section|article|pre|dd|dt|dl|header|footer|nav)[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  return s.split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).filter(l => l.length > 0).join('\n')
}

module.exports = { htmlToText, decodeEntities }
