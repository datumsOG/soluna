// Observer "ground zero" pin. A faint MapLibre halo ring on the ground, plus a
// glowing GL dot (via arc-gl) so the marker matches the arc/caster/shadow markers
// — additive bloom + perspective scaling + x-ray through buildings — instead of a
// flat composited circle.

import { setObserverMarker } from './arc-gl.js';

const SRC = 'observer-src';
const RING = 'observer-ring';

const C_WHITE = [1, 1, 1];
let _lastLngLat = null;   // remembered so setObserverVisible(true) can re-show it

export function addObserverLayer(map, lat, lon) {
  _lastLngLat = { lon, lat };
  if (!map.getSource(SRC)) {
    map.addSource(SRC, { type: 'geojson', data: pointFC(lon, lat) });
    map.addLayer({
      id: RING,
      type: 'circle',
      source: SRC,
      paint: {
        'circle-radius': 18,
        'circle-color': '#ffffff',
        'circle-opacity': 0.08,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.2,
        'circle-stroke-opacity': 0.35,
      },
    });
  }
  setObserverMarker({ lon, lat, sizePx: 17, color: C_WHITE });
}

export function setObserver(map, lat, lon) {
  _lastLngLat = { lon, lat };
  const src = map.getSource(SRC);
  if (src) src.setData(pointFC(lon, lat));
  setObserverMarker({ lon, lat, sizePx: 17, color: C_WHITE });
}

// Show/hide the ground-zero pin (used by aim mode, which declutters the scene).
export function setObserverVisible(map, vis) {
  if (map.getLayer(RING)) {
    try { map.setLayoutProperty(RING, 'visibility', vis ? 'visible' : 'none'); } catch {}
  }
  if (!vis) {
    setObserverMarker(null);
  } else if (_lastLngLat) {
    setObserverMarker({ ..._lastLngLat, sizePx: 17, color: C_WHITE });
  }
}

function pointFC(lon, lat) {
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} }],
  };
}
