'use strict'

// Minimal HTML form reader: enough to fill in and submit a search form the way
// a browser would (used for the ELWIS BfS search).

const { decodeEntities } = require('./html')

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null
}
const strip = s => decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

function parseForms (html, base) {
  const forms = []
  for (const fm of String(html).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const open = fm[1]; const inner = fm[2]
    const fields = []
    for (const m of inner.matchAll(/<input\b[^>]*>/gi)) {
      const name = attr(m[0], 'name'); if (!name) continue
      const type = (attr(m[0], 'type') || 'text').toLowerCase()
      if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(m[0])) { fields.push({ name, type, value: attr(m[0], 'value') ?? 'on', off: true }); continue }
      if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') { fields.push({ name, type, value: attr(m[0], 'value') ?? '', off: true }); continue }
      fields.push({ name, type, value: attr(m[0], 'value') ?? '' })
    }
    for (const m of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = attr(m[1], 'name'); if (!name) continue
      const options = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)(?=<option\b|$)/gi)].map(o => ({
        value: attr(o[1], 'value') ?? strip(o[2]), label: strip(o[2]), selected: /\bselected\b/i.test(o[1])
      }))
      const sel = options.find(o => o.selected) || options[0]
      fields.push({ name, type: 'select', value: sel ? sel.value : '', options })
    }
    const action = attr(open, 'action')
    forms.push({ action: new URL(action || '', base).href, method: (attr(open, 'method') || 'get').toLowerCase(), fields, text: strip(inner).slice(0, 200) })
  }
  return forms
}

// form + { fieldName: value } -> { url, body } (body for POST)
function fill (form, values = {}, submit = null) {
  const params = new URLSearchParams()
  for (const f of form.fields) {
    if (f.off && !(submit && f.name === submit)) continue
    params.append(f.name, f.name in values ? values[f.name] : f.value)
  }
  if (form.method === 'post') return { url: form.action, method: 'POST', body: params.toString() }
  const u = new URL(form.action)
  for (const [k, v] of params) u.searchParams.append(k, v)
  return { url: u.href, method: 'GET', body: null }
}

function describe (forms) {
  return forms.map((f, i) => [`form ${i + 1}: ${f.method.toUpperCase()} ${f.action}`,
    ...f.fields.map(x => `  ${x.name} (${x.type}${x.off ? ', off' : ''}) = ${JSON.stringify(x.value)}${x.options ? ' options: ' + x.options.slice(0, 25).map(o => `${o.value}=${o.label}`).join(' | ') : ''}`)
  ].join('\n')).join('\n')
}

module.exports = { parseForms, fill, describe }
