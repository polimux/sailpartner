'use strict'

const sjofartsverket = require('./sjofartsverket')
const finland = require('./finland')
const dwd = require('./dwd')
const ltsa = require('./ltsa')
const generic = require('./generic')

// Order matters for merging: earlier sources win when the same warning appears twice.
module.exports = [
  sjofartsverket,
  dwd,
  finland,
  generic.navtexlv,
  ltsa,
  generic.elwis
]
