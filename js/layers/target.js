// Alignment target: a pin and a faint dashed line back to observer.

const PIN_SRC = 'target-pin-src';
const PIN = 'target-pin';
const LINE_SRC = 'target-line-src';
const LINE = 'target-line';

export function addTargetLayer(map) {
  if (map.getSource(PIN_SRC)) return;
  const empty = { type: 'FeatureCollection', features: [] };
  map.addSource(PIN_SRC, { type: 'geojson', data: empty });
  map.addSource(LINE_SRC, { type: 'geojson', data: empty });

  map.addLayer({
    id: LINE,
    type: 'line',
    source: LINE_SRC,
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': '#ffb845',
      'line-width': 1.5,
      'line-opacity': 0.6,
      'line-dasharray': [3, 3],
    },
  });
  map.addLayer({
    id: PIN,
    type: 'circle',
    source: PIN_SRC,
    paint: {
      'circle-radius': 7,
      'circle-color': '#ffb845',
      'circle-stroke-color': '#0b0e14',
      'circle-stroke-width': 2,
    },
  });
}

export function setTarget(map, observer, target) {
  const pinSrc = map.getSource(PIN_SRC);
  const lineSrc = map.getSource(LINE_SRC);
  if (!pinSrc || !lineSrc) return;
  if (!target) {
    pinSrc.setData({ type: 'FeatureCollection', features: [] });
    lineSrc.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  pinSrc.setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [target.lon, target.lat] }, properties: {} }],
  });
  lineSrc.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[observer.lon, observer.lat], [target.lon, target.lat]] },
      properties: {},
    }],
  });
}
