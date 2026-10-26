'use strict'

const sjofartsverket = require('./sjofartsverket')
const digitraffic = require('./digitraffic')
const generic = require('./generic')

// Order matters for merging: earlier sources win when the same warning appears twice.
module.exports = [
  sjofartsverket,
  digitraffic,
  generic.navtexlv,
  generic.ltsa,
  generic.dwd,
  generic.elwis
]
