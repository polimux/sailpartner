# signalk-baltic-warnings

A Signal K server plugin that collects navigational warnings for the Baltic, filters them by your own position and planned route, and publishes them where every Signal K app can see them:

- **Signal K notifications** — KIP, Freeboard-SK, phone apps and the logbook pick them up
- **Chart resources** — point warnings as *notes*, areas and danger circles as *regions*, drawn by Freeboard-SK
- **REST API** — used by the Sailpartner morning brief

## Sources

| Source | Covers | Status |
|---|---|---|
| **BALTICO / Sjöfartsverket** (NAVTEX + VHF pages) | Coastal warnings of all Baltic states: German, Danish, Polish, Lithuanian, Latvian, Estonian, Finnish, Swedish, Russian, plus BALTIC SEA NAV WARNs | ✅ enabled, parser tested against the live format |
| **Digitraffic** (Fintraffic) | Finnish local nautical warnings, GeoJSON | ✅ enabled, field names read defensively — confirm with the probe |
| **On-board barometer** | Your own pressure sensor, 3-hour tendency | ✅ enabled |
| navtex.lv | Latvian NAVTEX messages | 🧪 experimental, off by default |
| LTSA | Lithuanian national warnings | 🧪 experimental, off by default |
| DWD | Gale and storm warnings for coast and sea areas | 🔎 probe only — saves raw data, parser follows |
| ELWIS | BfS and firing ranges (Todendorf/Putlos) | 🔎 probe only — URL and format to be confirmed |

German coastal NAV WARNs (e.g. the Fehmarn prohibited-area buoys) already arrive through BALTICO.

> Warnings from the internet do not replace the reception of navigational warnings via approved broadcast systems (NAVTEX, VHF). Use this as an additional aid.

## How relevance works

Every warning gets a distance to your boat (`navigation.position`) and to your planned route:

| relevance | meaning |
|---|---|
| `here` | within 1 nm, inside the area, or an area-wide warning for your sea area |
| `nearby` | within the radius (default 30 nm) |
| `route` | within the corridor (default 5 nm each side) of the planned route |
| `far` | none of the above |

Coordinates are read from the text in all formats used in the Baltic (`54-31,5N 011-18,5E`, `59°28.02′N, 028°02.36′E`, `55-13.214N; 018-48.92E` …). Four or more positions with "AREA" become a polygon; "4 MILE RADIUS FROM …" becomes a circle. Warnings without coordinates use the sea area they're listed under.

Cancellations are honoured ("CANCEL NAV WARN 516/26"), withdrawn warnings move to a 30-day history.

### On-board barometer

| Change in 3 h | Label | Severity |
|---|---|---|
| < 1.0 hPa | steady | — |
| 1.0–1.5 | falling/rising slowly | — |
| 1.6–3.0 | falling | alert |
| 3.1–6.0 | falling fast | warn (rising fast: alert) |
| > 6.0 | falling very fast | alarm |

It needs 2.5 hours of history before it reports. Default path `environment.outside.pressure` (Pa) — set in the plugin config if your BME280 publishes elsewhere.

## REST API

Base: `http://<pi>:3000/plugins/signalk-baltic-warnings`

| Method | Path | |
|---|---|---|
| GET | `/warnings?scope=relevant\|nearby\|route\|all` | sorted by severity, then relevance, then distance |
| GET | `/status` | per-source last success / last error, barometer tendency |
| GET | `/history` | withdrawn and cancelled warnings, last 30 days |
| PUT | `/route` | `{ "name": "Kühlungsborn", "points": [{ "latitude": 54.373, "longitude": 11.004 }, …] }` |
| DELETE | `/route` | clear the planned route |
| POST | `/refresh` | fetch all enabled sources now |

## Notifications

`notifications.navigation.warnings.<id>` (navigation) and `notifications.environment.warnings.<id>` (weather, water level, barometer), e.g.

```json
{ "state": "warn", "method": ["visual"],
  "message": "GERMAN NAV WARN 580/26: WESTERN BALTIC.FEHMARN. PROHIBITED AREA. (14 nm)" }
```

When a warning stops being relevant or is withdrawn, its notification goes back to `normal`.

## Install on the Pi (OpenPlotter)

Until it's published to npm:

```bash
cd ~/.signalk
npm install /path/to/signalk-baltic-warnings-0.1.0.tgz
sudo systemctl restart signalk
```

Then enable it under **Server → Plugin Config → Baltic Warnings**. No native dependencies, Node 18 or newer.

### First run: check the live sources

```bash
cd ~/.signalk/node_modules/signalk-baltic-warnings
node bin/probe.js 54.373 11.004
```

This fetches every source once, prints the parsed warnings sorted for your position and saves raw responses to `./probe-output/`. Those raw files are what's needed to finish the DWD and ELWIS parsers and to confirm the Digitraffic field names.

## Development

```bash
npm test
```

Tests cover coordinate parsing, date/validity parsing, the BALTICO page parser (fixture built from the live page format), relevance, the store's merge/cancel logic, Signal K conversions, and an end-to-end run against a mock Signal K server.
