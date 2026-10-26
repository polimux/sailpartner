'use strict'

// Local time helpers for a fixed IANA time zone (the boat's), independent of the
// Pi's own system time zone.

function parts (d, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  const o = {}
  for (const p of f.formatToParts(new Date(d))) o[p.type] = p.value
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute }
}

function dayKey (d, tz) {
  const p = parts(d, tz)
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

function addDays (key, n) {
  const d = new Date(key + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Local wall-clock time on a given day -> Date
function localToDate (key, hh, mm, tz) {
  const [y, m, d] = key.split('-').map(Number)
  let guess = Date.UTC(y, m - 1, d, hh, mm)
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, tz)
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min)
    guess += Date.UTC(y, m - 1, d, hh, mm) - asUtc
  }
  return new Date(guess)
}

// "13h"; with bare=true just "13"
function hourLabel (iso, tz, bare = false) {
  const p = parts(iso, tz)
  return bare ? String(p.h) : `${p.h}h`
}

function clock (iso, tz) {
  const p = parts(iso, tz)
  return `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`
}

module.exports = { parts, dayKey, addDays, localToDate, hourLabel, clock }
