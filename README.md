# Sailpartner

A morning brief and logbook screen for a Hanse 323, running on a Raspberry Pi with OpenPlotter and Signal K, fed by NMEA 2000.

## Packages

| Package | What it does | Status |
|---|---|---|
| [`signalk-baltic-warnings`](packages/signalk-baltic-warnings) | Signal K plugin: navigational warnings for the Baltic (BALTICO/NAVTEX for all Baltic states, Digitraffic, on-board barometer), filtered by position and route, published as notifications, chart regions/notes and a REST API | v0.1, tests passing, live sources to be confirmed on the Pi |
| `sailpartner` | Signal K plugin + web app: morning brief (verdict, written summary, route weather at 5 kn, live wind, rain, battery, barometer), detail pages for weather, warnings, battery, logbook and chart | planned |

## Stack

- Raspberry Pi 4/5, PiCAN-M HAT (NMEA 2000), BME280 barometer on I2C, 10.1" 1280×800 touch display
- OpenPlotter: CAN Bus, I2C, Signal K, Dashboards (InfluxDB 2)
- Existing Signal K plugins: `signalk-victron-ble` (SmartShunt), `signalk-to-influxdb2`, `signalk-logbook`, `signalk-anchoralarm-plugin`, `signalk-derived-data`, `@signalk/freeboard-sk`

## Development

```bash
cd packages/signalk-baltic-warnings
npm test
```
