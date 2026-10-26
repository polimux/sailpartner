'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { parsePositions, geometryFromText, distanceNm } = require('../lib/geo')
const { parseDtg, parseValidity, classify } = require('../lib/navtext')
const sjo = require('../lib/sources/sjofartsverket')
const { featuresToWarnings } = require('../lib/sources/discover')

const NOW = new Date('2026-10-26T08:00:00Z')
const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'sjofartsverket-navtex.html'), 'utf8')

test('coordinate formats seen in Baltic warnings', () => {
  const cases = [
    ['PSN 58-41.9N 010-51.0E.', 58.69833, 10.85],
    ['LIGHTBUOY 54-31,5N 011-18,5E TEMPORARILY', 54.525, 11.30833],
    ['LIGHTHOUSE 54-28N 012-30E UNLIT', 54.46667, 12.5],
    ['POSITION IS: 55-13.214N; 018-48.92E.', 55.22023, 18.81533],
    ['IN POSITION 59°28.02′N, 028°02.36′E', 59.467, 28.03933],
    ['FROM POSITION 55-3,19N 17-18,05E.', 55.05317, 17.30083],
    ['PSN:59-48.68N 027-24.73E', 59.81133, 27.41217]
  ]
  for (const [text, lat, lon] of cases) {
    const [p] = parsePositions(text)
    assert.ok(p, `no position in "${text}"`)
    assert.ok(Math.abs(p.latitude - lat) < 1e-4, `${text}: lat ${p.latitude}`)
    assert.ok(Math.abs(p.longitude - lon) < 1e-4, `${text}: lon ${p.longitude}`)
  }
})

test('date-time groups and validity', () => {
  assert.equal(parseDtg('202201 UTC OCT', NOW).toISOString(), '2026-10-20T22:01:00.000Z')
  // a December DTG seen in January belongs to last year
  assert.equal(parseDtg('301200 UTC DEC', new Date('2027-01-02T00:00:00Z')).getUTCFullYear(), 2026)
  const v = parseValidity('FROM 2026-10-26 05:00 TO 2026-10-27 00:59\nON 2026-10-31 FROM 07:00 TO 18:00\nCANCEL THIS MSG 311800 UTC OCT', NOW)
  assert.equal(v.validFrom, '2026-10-26T05:00:00.000Z')
  assert.equal(v.validTo, '2026-10-31T18:00:00.000Z')
  const v2 = parseValidity('302100 UTC SEP THRU 312100 UTC OCT', NOW)
  assert.equal(v2.validFrom, '2026-09-30T21:00:00.000Z')
  assert.equal(v2.validTo, '2026-10-31T21:00:00.000Z')
})

test('classification', () => {
  assert.equal(classify('LOW SEA LEVEL WESTERN BALTIC'), 'waterlevel')
  assert.equal(classify('DUE TO MILITARY EXERCISES ZONE IS CLOSED'), 'exercise')
  assert.equal(classify('GNSS, AIS, RADAR AND DGPS INTERFERENCE'), 'gnss')
  assert.equal(classify("'DARSSER ORT' LIGHTHOUSE UNLIT"), 'aton')
  assert.equal(classify('TIMBER ADRIFT IN NORRSUNDET'), 'hazard')
})

test('BALTICO NAVTEX page parses into deduplicated warnings', () => {
  const ws = sjo.parsePage(html, { url: 'x', channel: 'NAVTEX' }, NOW)
  const ids = ws.map(w => w.id).sort()
  assert.deepEqual(ids, [
    'baltic-sea-30-26', 'baltic-sea-32-26', 'danish-417-26', 'estonian-173-26',
    'german-580-26', 'german-592-26', 'kaliningrad-224-26', 'lithuanian-68-26',
    'petersburg-121-26', 'polish-276-26'
  ])
  const byId = Object.fromEntries(ws.map(w => [w.id, w]))

  // the GNSS warning appears under two areas but is one warning
  assert.deepEqual(byId['baltic-sea-30-26'].areas, ['WESTERN BALTIC', 'SOUTHERN BALTIC'])
  assert.equal(byId['baltic-sea-30-26'].category, 'gnss')

  const fehmarn = byId['german-580-26']
  assert.equal(fehmarn.issued, '2026-10-14T10:14:00.000Z')
  assert.deepEqual(fehmarn.cancels, ['516/26'])
  assert.equal(fehmarn.geometry.positions.length, 1)
  assert.match(fehmarn.title, /FEHMARN/)

  const kal = byId['kaliningrad-224-26']
  assert.equal(kal.category, 'exercise')
  assert.equal(kal.geometry.polygon.length, 4)
  assert.equal(kal.validTo, '2026-10-31T22:00:00.000Z')

  const pet = byId['petersburg-121-26']
  assert.ok(pet.geometry.circle)
  assert.equal(pet.geometry.circle.radiusNm, 4)
  assert.equal(pet.category, 'hazard')

  assert.equal(byId['baltic-sea-32-26'].category, 'waterlevel')
  assert.equal(byId['estonian-173-26'].geometry.positions.length, 1)
  assert.deepEqual(byId['lithuanian-68-26'].cancels, ['61/26'])
})

test('plain NAVTEX text and one-line headers', () => {
  const { parseWarningBlocks } = require('../lib/blocks')
  const text = [
    'ZCZC SA12',
    '202201 UTC OCT SWEDISH NAV WARN 177/26 SKAGERRAK. KOSTER.',
    "SOUTH CARDINAL MARK 'PERSGRUNDEN' IS MISSING. PSN 58-41.9N 010-51.0E.",
    'NNNN',
    'GERMAN NAV WARN 580/26 WESTERN BALTIC.FEHMARN.',
    "'SPERR-G.1' LIGHTBUOY 54-31,5N 011-18,5E TEMPORARILY WITHDRAWN."
  ].join('\n')
  const ws = parseWarningBlocks(text, { now: NOW })
  assert.deepEqual(ws.map(w => w.id), ['swedish-177-26', 'german-580-26'])
  assert.equal(ws[0].issued, '2026-10-20T22:01:00.000Z')
  assert.equal(ws[0].geometry.positions.length, 1)
  assert.equal(ws[1].geometry.positions[0].latitude, 54.525)
})

test('circle geometry from radius text', () => {
  const g = geometryFromText('MINE-LIKE OBJECT 4 MILE RADIUS FROM PSN:59-48.68N 027-24.73E')
  assert.equal(g.circle.radiusNm, 4)
  assert.ok(distanceNm(g.circle.center, { latitude: 59.81133, longitude: 27.41217 }) < 0.01)
})

test('Finnish GeoJSON with unknown field names is mapped defensively', () => {
  const json = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [21.4127, 61.5808] },
      properties: {
        id: 12345,
        number: 572,
        areasEn: 'SEA OF BOTHNIA',
        locationEn: 'MÄNTYLUOTO SOUTHERN FAIRWAY',
        contentsEn: 'EDGE MARK MORRIS NO 24416 RACON OUT OF ORDER',
        typeEn: 'COASTAL WARNING',
        publishingTime: '2026-10-22T16:24:00Z',
        validityStartTime: '2026-10-22T16:24:00Z',
        validityEndTime: null
      }
    }]
  }
  const [w] = featuresToWarnings(json.features, { issuer: 'FINNISH', prefix: 'finnish-local', now: NOW })
  assert.equal(w.id, 'finnish-local-572')
  assert.equal(w.title, 'MÄNTYLUOTO SOUTHERN FAIRWAY')
  assert.equal(w.category, 'aton')
  assert.deepEqual(w.geometry.positions, [{ latitude: 61.5808, longitude: 21.4127 }])
  assert.equal(w.issued, '2026-10-22T16:24:00.000Z')
})

test('DWD coastal warnings: polygons, names, English preferred, lat/lon order detected', () => {
  const dwd = require('../lib/sources/dwd')
  const ring = [[54.2, 10.8], [54.2, 11.4], [54.6, 11.4], [54.6, 10.8], [54.2, 10.8]] // lat,lon as GeoServer WFS 2.0 sends it
  const f = (lang, event, headline) => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { AREADESC: 'Fehmarnbelt', IDENTIFIER: 'abc.123', LANGUAGE: lang, EVENT: event, HEADLINE: headline, ONSET: '2026-10-26T12:00:00Z', EXPIRES: '2026-10-27T06:00:00Z', SENT: '2026-10-26T11:03:00Z' }
  })
  const ws = dwd.parseWfs({ features: [f('de-DE', 'STURMBÖEN', 'Amtliche WARNUNG vor STURM'), f('en-GB', 'gale', 'Official GALE WARNING')] })
  assert.equal(ws.length, 1)
  assert.equal(ws[0].label, 'DWD · Fehmarnbelt')
  assert.equal(ws[0].title, 'Gale warning')
  assert.equal(ws[0].severity, 'alarm')
  assert.equal(ws[0].validTo, '2026-10-27T06:00:00Z')
  assert.equal(ws[0].geometry.polygon[0].latitude, 54.2)
  const { assess } = require('../lib/relevance')
  assert.equal(assess(ws[0], { position: { latitude: 54.373, longitude: 11.004 } }).relevance, 'here')
  // the app file the probe saw: near gale is a reef warning, not an alarm
  const app = dwd.parseApp({ time: 1793044271698, warnings: { 501000008: [{ warnId: 'x.MUL', level: 2, event: 'near gale', headline: 'Official NEAR GALE WARNING', description: 'There is a risk of near gale.' }] } })
  assert.equal(app[0].severity, 'warn')
  assert.equal(app[0].title, 'Near gale warning')
})

test('Traficom: the warnings layer is found in the WFS capabilities', () => {
  const fin = require('../lib/sources/finland')
  const xml = `<wfs:WFS_Capabilities><FeatureTypeList>
    <FeatureType><Name>avoin:Ahti_Limit_L</Name><Title>Ahti_Limit_L</Title></FeatureType>
    <FeatureType><Name>avoin:merivaroitukset_voimassa</Name><Title>Merivaroitukset</Title></FeatureType>
  </FeatureTypeList></wfs:WFS_Capabilities>`
  assert.equal(fin.findLayer(xml).hit.name, 'avoin:merivaroitukset_voimassa')
  assert.equal(fin.findLayer('<x><FeatureType><Name>a:b</Name></FeatureType></x>').hit, undefined)
})

test('LTSA: ArcGIS service addresses are found in the app script', () => {
  const ltsa = require('../lib/sources/ltsa')
  const js = 'var a={url:"https://gis.eltsa.lt/arcgis/rest/services/NW/NavWarnings/FeatureServer/0",b:"https://js.arcgis.com/4.18/"};x("https://gis.eltsa.lt/arcgis/rest/services/NW/Base/MapServer")'
  assert.deepEqual(ltsa.serviceUrls(js), ['https://gis.eltsa.lt/arcgis/rest/services/NW/NavWarnings/FeatureServer/0', 'https://gis.eltsa.lt/arcgis/rest/services/NW/Base/MapServer'])
})
