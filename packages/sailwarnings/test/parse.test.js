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
  assert.match(ws[0].text, /^Official GALE WARNING/)
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


test('LTSA: ArcGIS service addresses are found in the app script', () => {
  const ltsa = require('../lib/sources/ltsa')
  const js = 'var a={url:"https://gis.eltsa.lt/arcgis/rest/services/NW/NavWarnings/FeatureServer/0",b:"https://js.arcgis.com/4.18/"};x("https://gis.eltsa.lt/arcgis/rest/services/NW/Base/MapServer")'
  assert.deepEqual(ltsa.serviceUrls(js), ['https://gis.eltsa.lt/arcgis/rest/services/NW/NavWarnings/FeatureServer'])
  // as found in the live script (26 Oct 2026): sample and chart services are skipped
  const live = '"https://hydro.eltsa.lt/arcgis/rest/services/SampleWorldCities/MapServer/exts/MaritimeChartService/MapServer","https://hydro.eltsa.lt/arcgis/rest/services/Hosted/MaritimeWarnings_LT/FeatureServer/","https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer"'
  assert.deepEqual(ltsa.serviceUrls(live), ['https://hydro.eltsa.lt/arcgis/rest/services/Hosted/MaritimeWarnings_LT/FeatureServer'])
})

test('LTSA: basemaps are not mistaken for the warnings service', () => {
  const ltsa = require('../lib/sources/ltsa')
  assert.deepEqual(ltsa.serviceUrls('a="https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer"'), [])
  assert.deepEqual(ltsa.configUrls('load("config/app.json");x="nls/strings.json"', 'https://hydro.eltsa.lt/nw/app.min.js'), ['https://hydro.eltsa.lt/nw/config/app.json'])
})

test('Traficom S-124 features (live sample, 26 Oct 2026)', () => {
  const fin = require('../lib/sources/finland')
  const f = {
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: [[[[27.844333, 61.556548], [27.843937, 61.553065], [27.852878, 61.552722], [27.854184, 61.55645], [27.844333, 61.556548]]]] },
    properties: { ID: 550, WARNINGINFORMATION_FI: 'RUOPPAUSTYÖT KUPARONVIRRAN LOSSIN RANNOILLA.', WARNINGINFORMATION_EN: 'DREDGING WORK AT THE KUPARONVIRTA FERRY SITE. BOATERS ARE ADVISED TO EXERCISE CAUTION.', MESSAGESERIESIDENTIFIERINTEROPERABILITYIDENTIFIER: 'urn:mrn:fin:navwarn:FI05:VV:2026:139', MESSAGESERIESIDENTIFIERNAMEOFSERIES_EN: 'Warnings for Yachtmen', MESSAGESERIESIDENTIFIERWARNINGNUMBER: 139, MESSAGESERIESIDENTIFIERYEAR: 2026, NAVWARNTYPEGENERAL_EN: 'Special operations', PUBLICATIONTIME: '2026-10-15T13:30:46Z', GENERALAREALOCATIONNAME_EN: 'Vuoksi watercourse', LOCALITYLOCATIONNAME_EN: 'KUPARONVIRTA FERRY' }
  }
  const [w] = fin.parse([f, { ...f, geometry: { type: 'Point', coordinates: [27.85, 61.555] } }])
  assert.equal(w.label, 'FINNISH LOCAL WARNING 139/26')
  assert.equal(w.title, 'Kuparonvirta Ferry · Special operations')
  assert.equal(w.category, 'works')
  assert.equal(w.issued, '2026-10-15T13:30:46Z')
  assert.equal(w.geometry.polygon[0].latitude, 61.556548)
  assert.equal(w.geometry.positions.length, 1, 'shapes of the same warning are merged')
  const caps = '<FeatureType><Name>avoin:Ahti_Limit_L</Name></FeatureType><FeatureType><Name>avoin:navigational_warnings_a</Name></FeatureType><FeatureType><Name>avoin:navigational_warnings_p</Name></FeatureType>'
  assert.deepEqual(fin.findLayers(caps).names, ['avoin:navigational_warnings_a', 'avoin:navigational_warnings_p'])
})

test('navtex.lv radio text: foreign and garbled messages are dropped', () => {
  const { cleanRadio } = require('../lib/sources/generic')
  const w = (issuer, title, text) => ({ issuer, title, text, areas: ['2026-10-26 22:00:57(LV) AREA: A'] })
  const r = cleanRadio([
    w('DANISH', 'DENMARK. LIIM F_OZWLM__D_LZYZPM__S_STARBOARD HAND LIGHT BUOY', 'x'),
    w('KALININGRAD', 'SOUTHEASTERN BALTIC', 'SHIPS EXERCISES 312100 UTC OCT THRU 302100 UTC NOV'),
    w('CANCEL LITHUANIAN', '.', '.'),
    w('AVURNAV BREST', 'IROISE', 'TARGET LAUNCHING')
  ])
  assert.deepEqual(r.warnings.map(x => x.issuer), ['KALININGRAD'])
  assert.deepEqual(r.warnings[0].areas, [])
  assert.equal(r.note, '1 warnings with reception errors skipped')
})

test('DWD live sample (26 Oct 2026): German text gets an English title and translation', () => {
  const dwd = require('../lib/sources/dwd')
  const [w] = dwd.parseWfs({ features: [{ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[[[10.0, 54.4], [11.3, 54.4], [11.3, 54.9], [10.0, 54.9], [10.0, 54.4]]]] }, properties: { AREADESC: 'Flensburg bis Fehmarn', IDENTIFIER: '2.49.0.0.276.0.DWD.PVW.1', LANGUAGE: 'de-DE', EVENT: 'BÖEN', SEVERITY: 'Minor', SENT: '2026-10-26T14:33:00Z', ONSET: '2026-10-26T14:33:00Z', EXPIRES: null, HEADLINE: 'Amtliche Warnung des Seewetterdienstes Hamburg vor BÖEN', DESCRIPTION: 'Südwest 6, dabei Böen von 8 Beaufort, süddrehend.' } }] })
  assert.equal(w.title, 'Gust warning')
  assert.equal(w.severity, 'warn')
  assert.equal(w.text.split('\n')[0], 'SW 6, gusts Bft 8, turning S.')
  assert.equal(w.validTo, null)
})

test('LTSA: warning texts from the table are joined with their shapes', () => {
  const ltsa = require('../lib/sources/ltsa')
  const rows = [{ objectid: 7, globalid: '{959D9F94-183B-4132-AA4F-281705C014BA}', number: '45/26', text_en: 'KLAIPEDA PORT. DREDGING WORKS IN AREA. KEEP CLEAR.', valid_to: 1793500000000 }]
  const shapes = [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[21.07, 55.72], [21.09, 55.72], [21.09, 55.73], [21.07, 55.72]]] }, properties: { globalid: '{A}', warn_globalid: '{959D9F94-183B-4132-AA4F-281705C014BA}' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [21.1, 55.71] }, properties: { globalid: '{B}', warn_globalid: '{959D9F94-183B-4132-AA4F-281705C014BA}' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [20.3, 56.0] }, properties: { globalid: '{C}', warn_globalid: '{OTHER}' } }
  ]
  const [w] = ltsa.join(rows, shapes)
  assert.equal(w.label, 'LITHUANIAN WARNING 45/26')
  assert.equal(w.geometry.polygon[0].longitude, 21.07)
  assert.deepEqual(w.geometry.positions, [{ latitude: 55.71, longitude: 21.1 }])
  assert.equal(w.validTo, new Date(1793500000000).toISOString())
})

test('ELWIS: the BfS search is filled in for WSA Ostsee', () => {
  const elwis = require('../lib/sources/elwis')
  const html = `<form action="/DE/dynamisch/Bfs/bfsNr" method="get"><input name="nr"><select name="amtNr"><option value="1">WSA Ostsee</option></select><input type="submit" value="aufrufen"></form>
  <form action="/DE/dynamisch/Bfs/bfsSuche" method="post"><input type="hidden" name="token" value="abc">
  <select name="seeregion"><option value="alle" selected>Alle Seeregionen</option></select>
  <select name="herausgeber"><option value="">-- Alle Ämter --</option><option value="17">WSA Elbe-Nordsee</option><option value="21">WSA Ostsee</option></select>
  <input type="submit" name="suchen" value="Suche starten..."><input type="submit" name="reset" value="Suche zurücksetzen"></form>`
  const { req } = elwis.searchRequest(html)
  assert.equal(req.method, 'POST')
  assert.equal(req.url, 'https://www.elwis.de/DE/dynamisch/Bfs/bfsSuche')
  assert.equal(req.body, 'token=abc&suchen=Suche+starten...&seeregion=alle&herausgeber=21')
})
