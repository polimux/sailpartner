'use strict'

// Starter list of harbours around the western Baltic, home port Heiligenhafen.
// Positions and "via" points are APPROXIMATE and only used to sample the weather
// along the way (a mile off does not matter for that). They are not for navigation.
// Edit them in the plugin config, or send a route drawn in Freeboard-SK instead.

const FEHMARNSUND = { latitude: 54.395, longitude: 11.12 }

module.exports = {
  home: { name: 'Heiligenhafen', latitude: 54.3735, longitude: 11.005 },
  list: [
    { name: 'Heiligenhafen', latitude: 54.3735, longitude: 11.005, via: [] },
    { name: 'Großenbrode', latitude: 54.368, longitude: 11.085, via: [] },
    { name: 'Burgstaaken (Fehmarn)', latitude: 54.414, longitude: 11.197, via: [FEHMARNSUND] },
    { name: 'Grömitz', latitude: 54.143, longitude: 10.958, via: [FEHMARNSUND, { latitude: 54.33, longitude: 11.2 }, { latitude: 54.18, longitude: 11.0 }] },
    { name: 'Neustadt in Holstein', latitude: 54.104, longitude: 10.816, via: [FEHMARNSUND, { latitude: 54.33, longitude: 11.2 }, { latitude: 54.12, longitude: 10.9 }] },
    { name: 'Kühlungsborn', latitude: 54.153, longitude: 11.756, via: [FEHMARNSUND, { latitude: 54.39, longitude: 11.45 }] },
    { name: 'Wismar', latitude: 53.900, longitude: 11.458, via: [FEHMARNSUND, { latitude: 54.3, longitude: 11.3 }, { latitude: 54.02, longitude: 11.42 }] },
    { name: 'Bagenkop (Langeland)', latitude: 54.753, longitude: 10.676, via: [{ latitude: 54.42, longitude: 10.95 }] }
  ]
}
