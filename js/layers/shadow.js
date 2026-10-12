// Shadow visualisation — now drawn inside the GL scene (via arc-gl) so the 3D
// buildings occlude it, instead of DOM markers + a full-screen SVG overlay that
// always floated on top.
//
//   • White dot at observer ground (base of the pole).
//   • Light-blue caster sphere at OBJECT_H_M above the observer + blue pole.
//   • Body-coloured shadow endpoint dot, elevated to FLOOR_H_M at the shadow
//     landing position; green ground dot + green line below it when floor > 0.
//   • Body-coloured sky line: body → caster → shadow endpoint.
//   • Red occlusion dot + dimmed "blocked" extension when a building intercepts
//     the shadow ray.
//
// Geometry (flat-earth + iterative terrain correction) is unchanged; only the
// OUTPUT moved from DOM/SVG to GL world-space markers/segments. Because those
// reproject in-shader, there is no longer any per-frame render listener here —
// we rebuild the GL buffers only when the geometry changes.
//
// The shadow-position day arc (the ground sweep) stays a normal GL line layer.

import { getPosition, getMoonPos } from '../solar.js';
import { PERF, perfMark, idleMs } from '../perf.js';
import { destination } from '../util.js';
import { getLiveBodyAnchor, setAnchorLiftMetres, getArcSamples } from './sun-path.js';
import { setMarkers, setGroundMarkers, setSegments } from './arc-gl.js';
import { getElevationSync, prefetchElevation, setElevationCallback } from '../elevation.js';

let OBJECT_H_M = 0;   // caster height above ground
let FLOOR_H_M = 0;    // floor surface elevation above ground (shadow lands here)
const MAX_SHADOW_KM = 4.0;

// Marker / line colours (0..1 RGB).
const C_WHITE = [1, 1, 1];
const C_BLUE  = [0.30, 0.82, 1.0];   // #4dd2ff caster/pole
const C_GREEN = [0.30, 1.0, 0.60];   // #4dff9a floor
const GOLD = [1.0, 0.722, 0.27];
const MOON = [0.816, 0.847, 0.91];

let mapRef = null;
let mode = 'sun';
let observerCache = null;
let datetimeCache = null;
let visible = false;

let _endLngLat = null;     // [lon, lat] of the shadow endpoint, or null
let _floorLngLat = null;   // [lon, lat] of the green floor dot, or null
let _occlusionHit = null;  // { lon, lat, rayH, bldH, t, edge } | false
let _reflector = null;     // { lon, lat, h, edge:[p1,p2] } | null — tapped wall point;
                           // its sun reflection redraws against the live sun each frame
let _setupMode = false;       // shot wizard: draw only the caster sphere + pole

// Shadow-position arc (day sweep) — a flat MapLibre ground line, same treatment as
// the sunrise/sunset/ray spokes: a bright solid copy beneath the buildings (so a
// building in front hides it) + a dim, heavily-blurred ghost on top (seen through
// the buildings as a soft diffuse glow). Restored from a GL line so it can blur.
const ARC_SRC = 'shadow-arc-src';
const ARC_MEGA = 'shadow-arc-mega';          // huge soft halo (most bloom)
const ARC_GLOW = 'shadow-arc-glow';
const ARC_CORE = 'shadow-arc-core';
const ARC_PULSE = 'shadow-arc-pulse';        // animated travelling band (motion = presence)
const ARC_GHOST = 'shadow-arc-core-ghost';   // dim + blurred x-ray copy, restacked on top
// Ghost look matches the spokes (sun-path.js GHOST_*): dim + heavily blurred.
const ARC_GHOST_W = 13, ARC_GHOST_BLUR = 16, ARC_GHOST_PEAK = 0.24;

// The shadow arc gets its OWN hue, distinct from the warm sun spokes (gold rise/ray,
// red set) and the blue caster / green floor — so it never reads as "another sun
// ray". Electric violet in sun mode, ice blue-violet in moon mode.
const ARC_SUN_RGB  = [255, 222, 64];   // #ffde40 vivid yellow (colours TBD)
const ARC_MOON_RGB = [150, 180, 255];  // #96b4ff ice blue-violet

let arcLayersAdded = false;
let arcLayersAddedOnce = false;   // one-time setup guard

function _arcGradient(r, g, b, peak) {
  return ['interpolate', ['linear'], ['line-progress'],
    0,    `rgba(${r},${g},${b},0)`,
    0.14, `rgba(${r},${g},${b},${peak})`,
    0.86, `rgba(${r},${g},${b},${peak})`,
    1,    `rgba(${r},${g},${b},0)`];
}

// A narrow bright window centred at `pos` (0..1 along the arc) that travels the
// length of the shadow arc each cycle — a comet of light running along it.
function _pulseGradient(pos, [r, g, b]) {
  const w = 0.09;
  const lo = Math.max(0.0001, pos - w);
  const hi = Math.min(0.9999, pos + w);
  const stops = ['interpolate', ['linear'], ['line-progress'], 0, `rgba(${r},${g},${b},0)`];
  if (lo > 0.0001) stops.push(lo, `rgba(${r},${g},${b},0)`);
  stops.push(pos, `rgba(255,255,255,0.9)`);
  if (hi < 0.9999) stops.push(hi, `rgba(${r},${g},${b},0)`);
  stops.push(1, `rgba(${r},${g},${b},0)`);
  return stops;
}
const _PULSE_OFF = ['interpolate', ['linear'], ['line-progress'], 0, 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,0)'];

// rAF-driven travelling pulse. Runs only while the shadow arc is visible + drawn.
let _pulsePos = 0, _pulseRAF = 0, _pulseLast = 0, _pulsePaint = 0;
function _startPulse() {
  if (_pulseRAF) return;
  if (!PERF.pulse) { _stopPulse(); return; }
  const tick = (t) => {
    _pulseRAF = 0;
    if (!visible || !mapRef || !mapRef.getLayer(ARC_PULSE)) return;
    // Idle stop. setPaintProperty on a line-gradient marks the whole map dirty,
    // so this loop alone holds MapLibre at 60fps forever on a completely still
    // scene — every building, every custom layer, the full-screen glass pass,
    // all re-rendered for a comet. It is a lovely arrival animation and it does
    // not need to run for ten minutes. Any touch restarts it.
    if (idleMs() > PERF.pulseIdleMs) { _stopPulse(); return; }
    const dt = _pulseLast ? Math.min(50, t - _pulseLast) : 16; _pulseLast = t;
    _pulsePos += dt / 2200;                 // ~2.2 s to traverse the arc
    if (_pulsePos >= 1) _pulsePos -= 1;
    // Throttle the PAINT, not the clock: position still advances smoothly, we
    // just stop asking the map to redraw 60 times a second for it.
    if (t - _pulsePaint >= 1000 / PERF.pulseFps) {
      _pulsePaint = t;
      const rgb = mode === 'moon' ? ARC_MOON_RGB : ARC_SUN_RGB;
      const done = perfMark('arcPulse');
      try { mapRef.setPaintProperty(ARC_PULSE, 'line-gradient', _pulseGradient(_pulsePos, rgb)); } catch {}
      done();
    }
    _pulseRAF = requestAnimationFrame(tick);
  };
  _pulseRAF = requestAnimationFrame(tick);
}
function _stopPulse() {
  if (_pulseRAF) { cancelAnimationFrame(_pulseRAF); _pulseRAF = 0; }
  _pulseLast = 0;
  if (mapRef && mapRef.getLayer(ARC_PULSE)) {
    try { mapRef.setPaintProperty(ARC_PULSE, 'line-gradient', _PULSE_OFF); } catch {}
  }
}

export function setShadowHeight(h) {
  const n = Number(h);
  OBJECT_H_M = Number.isFinite(n) && n >= 0 ? n : 0;
  if (visible) {
    setAnchorLiftMetres(OBJECT_H_M);  // lift the arc so body→caster→shadow stays collinear
    update();
    if (observerCache && mapRef) updateShadowArcDay(mapRef, observerCache, datetimeCache, mode === 'moon');
  }
}
export function getShadowHeight() { return OBJECT_H_M; }
export function getShadowEndLngLat() { return _endLngLat ? { lat: _endLngLat[1], lon: _endLngLat[0] } : null; }
export function getFloorDotLngLat() { return _floorLngLat ? { lat: _floorLngLat[1], lon: _floorLngLat[0] } : null; }

export function setFloorHeight(h) {
  const n = Number(h);
  FLOOR_H_M = Number.isFinite(n) && n >= 0 ? n : 0;
  if (visible) { setAnchorLiftMetres(OBJECT_H_M); update(); }
}
export function getFloorHeight() { return FLOOR_H_M; }

export function addShadowLayer(map) {
  mapRef = map;
  // First call only: register the elevation callback (re-run on new DEM data).
  if (!arcLayersAddedOnce) {
    setElevationCallback(() => { if (visible) update(); });
    arcLayersAddedOnce = true;
  }
  // GL source + layers: guard on source so this re-runs after a style reload.
  if (map.getSource(ARC_SRC)) { arcLayersAdded = true; return; }
  const [r, g, b] = ARC_SUN_RGB;
  map.addSource(ARC_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, lineMetrics: true });
  // Mega halo: huge + soft, the bulk of the bloom that gives the arc its mass.
  map.addLayer({ id: ARC_MEGA, type: 'line', source: ARC_SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-width': 46, 'line-blur': 22, 'line-gradient': _arcGradient(r, g, b, 0.16) } });
  map.addLayer({ id: ARC_GLOW, type: 'line', source: ARC_SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-width': 30, 'line-blur': 13, 'line-gradient': _arcGradient(r, g, b, 0.40) } });
  map.addLayer({ id: ARC_CORE, type: 'line', source: ARC_SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-width': 8, 'line-gradient': _arcGradient(r, g, b, 1.0) } });
  // Travelling pulse: a bright comet running along the arc (starts dark).
  map.addLayer({ id: ARC_PULSE, type: 'line', source: ARC_SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-width': 9, 'line-blur': 2, 'line-gradient': _PULSE_OFF } });
  map.addLayer({ id: ARC_GHOST, type: 'line', source: ARC_SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-width': ARC_GHOST_W, 'line-blur': ARC_GHOST_BLUR, 'line-gradient': _arcGradient(r, g, b, ARC_GHOST_PEAK) } });
  arcLayersAdded = true;
}

// Recompute the shadow-position arc: a clean line on the ground tracing where the
// caster's shadow tip lands across the day. Drawn hard-occluded (arc-gl, no ghost
// pass) so buildings correctly hide the parts behind them — real depth, no spikes.
// (The per-sample "climb up buildings" was dropped: a shadow tip genuinely jumps
// when it clears a roof edge, so 60 discrete samples produced a sawtooth. The live
// shadow DOT still rides up buildings continuously as you scrub.)
export function updateShadowArcDay(map, observer, datetime, moonMode = false) {
  if (!arcLayersAdded || !map.getSource(ARC_SRC)) return;
  mode = moonMode ? 'moon' : 'sun';
  const src = map.getSource(ARC_SRC);
  const coords = _shadowArcCoords(observer);
  if (!visible || coords.length < 2) {
    src.setData({ type: 'FeatureCollection', features: [] });
    _stopPulse();
    return;
  }
  src.setData({ type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] });
  const [r, g, b] = moonMode ? ARC_MOON_RGB : ARC_SUN_RGB;
  try { map.setPaintProperty(ARC_MEGA, 'line-gradient', _arcGradient(r, g, b, 0.16)); } catch {}
  try { map.setPaintProperty(ARC_GLOW, 'line-gradient', _arcGradient(r, g, b, 0.40)); } catch {}
  try { map.setPaintProperty(ARC_CORE, 'line-gradient', _arcGradient(r, g, b, 1.0)); } catch {}
  try { map.setPaintProperty(ARC_GHOST, 'line-gradient', _arcGradient(r, g, b, ARC_GHOST_PEAK)); } catch {}
  _startPulse();
}

function _shadowArcCoords(observer) {
  if (!observer || OBJECT_H_M <= 0.01) return [];
  const samples = getArcSamples();
  const out = [];
  for (const s of samples) {
    if (s.altDeg <= 0.5) continue;
    const flatKm = OBJECT_H_M / Math.tan(s.altDeg * Math.PI / 180) / 1000;
    if (flatKm <= 0 || flatKm >= MAX_SHADOW_KM) continue;
    const shadowAz = (s.azDeg + 180) % 360;
    out.push(destination(observer.lat, observer.lon, shadowAz, flatKm));
  }
  return out;
}

function clearShadowArc() {
  _stopPulse();
  if (!mapRef || !mapRef.getSource || !mapRef.getSource(ARC_SRC)) return;
  try { mapRef.getSource(ARC_SRC).setData({ type: 'FeatureCollection', features: [] }); } catch {}
}

function clearGL() { setMarkers([]); setGroundMarkers([]); setSegments([]); }

export function setShadowVisible(map, vis) {
  visible = !!vis;
  setAnchorLiftMetres(vis ? OBJECT_H_M : 0);
  if (!vis) {
    clearGL(); clearShadowArc();
    _occlusionHit = null; _endLngLat = null; _floorLngLat = null;
  } else {
    update();
    if (observerCache && mapRef) updateShadowArcDay(mapRef, observerCache, datetimeCache, mode === 'moon');
  }
}

export function updateShadow(map, observer, datetime, moonMode = false) {
  observerCache = observer;
  datetimeCache = datetime;
  mode = moonMode ? 'moon' : 'sun';
  if (!visible) return;
  update();
}

// Compute the shadow geometry and rebuild the GL markers + segments.
function update() {
  if (!observerCache || !mapRef) return;
  if (!Number.isFinite(observerCache.lat) || !Number.isFinite(observerCache.lon)) return;

  const observer = observerCache;
  const datetime = datetimeCache;
  const moonMode = mode === 'moon';
  const p = moonMode
    ? getMoonPos(datetime, observer.lat, observer.lon)
    : getPosition(datetime, observer.lat, observer.lon);
  const { lat, lon } = observer;

  _endLngLat = null;
  _floorLngLat = null;
  const shadowH = OBJECT_H_M - FLOOR_H_M;

  if (shadowH > 0.01 && p.altitudeDeg > 0.5) {
    // Normal shadow: caster above the floor.
    const tanEl = Math.tan(p.altitudeDeg * Math.PI / 180);
    const shadowAz = (p.azimuthDeg + 180) % 360;
    const obsElev = getElevationSync(lon, lat);
    let flatKm = shadowH / tanEl / 1000;
    for (let iter = 0; iter < 4; iter++) {
      const cand = destination(lat, lon, shadowAz, flatKm);
      const endElev = getElevationSync(cand[0], cand[1]);
      const effH = (obsElev + OBJECT_H_M) - (endElev + FLOOR_H_M);
      if (effH < 0.01) { flatKm = 0; break; }
      const next = effH / tanEl / 1000;
      if (Math.abs(next - flatKm) < 0.001) { flatKm = next; break; }
      flatKm = next;
    }
    prefetchElevation(lon, lat);
    if (flatKm > 0) { const e = destination(lat, lon, shadowAz, flatKm); prefetchElevation(e[0], e[1]); }
    if (flatKm > 0 && flatKm < MAX_SHADOW_KM) {
      _endLngLat = destination(lat, lon, shadowAz, flatKm);
      if (FLOOR_H_M > 0.01) _floorLngLat = _endLngLat;
    }
  } else if (FLOOR_H_M > OBJECT_H_M + 0.01 && p.altitudeDeg > 0.5) {
    // Parallel-rays mode: floor above caster — intersection on the sun side.
    const tanEl2 = Math.tan(p.altitudeDeg * Math.PI / 180);
    const obsElev2 = getElevationSync(lon, lat);
    let flatKm2 = (FLOOR_H_M - OBJECT_H_M) / tanEl2 / 1000;
    for (let iter = 0; iter < 4; iter++) {
      const cand = destination(lat, lon, p.azimuthDeg, flatKm2);
      const intElev = getElevationSync(cand[0], cand[1]);
      const heightToReach = (intElev + FLOOR_H_M) - (obsElev2 + OBJECT_H_M);
      if (heightToReach < 0.01) { flatKm2 = 0; break; }
      const next = heightToReach / tanEl2 / 1000;
      if (Math.abs(next - flatKm2) < 0.001) { flatKm2 = next; break; }
      flatKm2 = next;
    }
    prefetchElevation(lon, lat);
    if (flatKm2 > 0) { const e = destination(lat, lon, p.azimuthDeg, flatKm2); prefetchElevation(e[0], e[1]); }
    if (flatKm2 > 0 && flatKm2 < MAX_SHADOW_KM) {
      _endLngLat = destination(lat, lon, p.azimuthDeg, flatKm2);
      _floorLngLat = _endLngLat;   // floor above caster → green floor dot present
    }
  }

  const parallelMode = FLOOR_H_M > OBJECT_H_M + 0.01;
  _occlusionHit = (_endLngLat && !parallelMode) ? _computeOcclusion() : false;

  _rebuildGL(moonMode ? MOON : GOLD, parallelMode, p);
}

function _rebuildGL(bodyColor, parallelMode, p) {
  if (!visible) { clearGL(); return; }
  const { lat, lon } = observerCache;
  const ground = { lon, lat, altM: 0 };
  const casterTop = { lon, lat, altM: OBJECT_H_M };
  const hasCaster = OBJECT_H_M > 0.01;

  // Shot-wizard setup view: only the caster sphere + the ground→caster pole, so the
  // user can place ground zero and the caster cleanly with nothing else on screen.
  if (_setupMode) {
    const occ = [], seg = [];
    if (hasCaster) {
      occ.push({ ...casterTop, color: C_BLUE, sizePx: 19 });
      seg.push({ a: ground, b: casterTop, color: C_BLUE });
    }
    setMarkers(occ); setGroundMarkers([]); setSegments(seg);
    return;
  }
  const body = getLiveBodyAnchor();   // { lon, lat, altM } | null

  // Is the caster in shade? — a building standing between it and the sun. When so, the
  // incoming beam dies on that wall and the caster casts no shadow, so the shadow-tip
  // graphics below are suppressed (otherwise the shot reads as lit when it isn't).
  const sunHit = (hasCaster && body) ? _computeSunOcclusion(body) : false;

  const occluded = [];   // elevated markers — true depth occlusion
  const groundM = [];    // ground-plane markers — x-ray two-pass
  const segments = [];   // 3D connecting lines — true depth occlusion

  // Caster sphere + blue pole. (The observer's white dot IS the observer pin.)
  if (hasCaster) {
    occluded.push({ ...casterTop, color: C_BLUE, sizePx: 19 });
    segments.push({ a: ground, b: casterTop, color: C_BLUE });
  }

  // Where the shadow tip actually lands:
  //   • occluded by a building → a single body-coloured dot ON the building face
  //     (at the ray's height where it meets the wall); no ground dot beyond it.
  //   • floor > 0 → body dot elevated at floor height + green floor dot/line.
  //   • otherwise → body dot on the ground.
  const occludedHit = (_occlusionHit && !parallelMode)
    ? { lon: _occlusionHit.lon, lat: _occlusionHit.lat, altM: Math.max(0, _occlusionHit.rayH) }
    : null;

  // When the caster is in shade (sunHit), it casts no shadow — skip every shadow-tip
  // marker/line; the sky-line block then draws the beam stopping at the blocking wall.
  let endElevated = null;   // the tip the sky line should reach when not occluded
  if (!sunHit) {
    if (occludedHit) {
      occluded.push({ ...occludedHit, color: bodyColor, sizePx: 16 });   // lands on the building → occlude
    } else if (_endLngLat) {
      const endGround = { lon: _endLngLat[0], lat: _endLngLat[1], altM: 0 };
      endElevated = { lon: _endLngLat[0], lat: _endLngLat[1], altM: FLOOR_H_M };
      if (FLOOR_H_M > 0.01) {
        occluded.push({ ...endElevated, color: bodyColor, sizePx: 16 });  // elevated → occlude
        groundM.push({ ...endGround, color: C_GREEN, sizePx: 14 });       // on the ground → x-ray
        segments.push({ a: endGround, b: endElevated, color: C_GREEN });
      } else {
        groundM.push({ ...endGround, color: bodyColor, sizePx: 16 });     // shadow lands on the ground → x-ray
      }
    }
  }

  // Sky line: body → caster → tip (the building hit when occluded, else the end). When
  // the SUN is blocked before the caster, the beam dies on that wall instead — same dot
  // treatment the shadow side uses when ITS ray is blocked.
  // At caster height 0 the caster sits on the ground (casterTop == ground), so this still
  // draws the incoming sun ray down to the spot — the beam must NOT vanish just because
  // there's no pole to climb.
  if (body) {
    // fa/fb tag the beam with a 0→1 flow coordinate (sky → ground) for the comet.
    if (sunHit) {
      const sunHitPt = { lon: sunHit.lon, lat: sunHit.lat, altM: Math.max(0, sunHit.rayH) };
      segments.push({ a: body, b: sunHitPt, color: bodyColor, fa: 0.0, fb: 1.0 });
      occluded.push({ ...sunHitPt, color: bodyColor, sizePx: 16 });   // light dies on the wall → occlude
    } else if (occludedHit) {
      segments.push({ a: body, b: casterTop, color: bodyColor, fa: 0.0, fb: 0.5 });
      segments.push({ a: casterTop, b: occludedHit, color: bodyColor, fa: 0.5, fb: 1.0 });
    } else if (endElevated) {
      if (parallelMode) {
        segments.push({ a: body, b: endElevated, color: bodyColor, fa: 0.0, fb: 1.0 });
        segments.push({ a: endElevated, b: casterTop, color: bodyColor });
      } else {
        segments.push({ a: body, b: casterTop, color: bodyColor, fa: 0.0, fb: 0.5 });
        segments.push({ a: casterTop, b: endElevated, color: bodyColor, fa: 0.5, fb: 1.0 });
      }
    } else {
      // No usable shadow end (below horizon / too long) — just body → caster.
      segments.push({ a: body, b: casterTop, color: bodyColor, fa: 0.0, fb: 1.0 });
    }
  }

  // ---- Reflection off a tapped building wall (the sun ray used as a mirror) ----
  // The user taps a point on a wall (see pickWallPoint); we reflect the live sun off
  // that face and draw the beam to the ground. The pinned wall dot is drawn ALWAYS —
  // even when the face is in shade — as the "you picked here" / "face in shade" cue;
  // the beam + ground glint appear only while the face is lit (_pushReflection no-ops
  // the beam when the reflected ray doesn't descend).
  const D = (p && p.altitudeDeg > 0.5) ? _sunDir(p) : null;
  if (_reflector && _reflector.edge) {
    const W = { lon: _reflector.lon, lat: _reflector.lat, h: _reflector.h };
    occluded.push({ lon: W.lon, lat: W.lat, altM: W.h, color: bodyColor, sizePx: 13 });
    if (D) {
      const n = _edgeNormalFacingSun(_reflector.edge[0], _reflector.edge[1], _reflector.lat, D);
      _pushReflection(W, n, D, bodyColor, getLiveBodyAnchor(), false, occluded, groundM, segments);
    }
  }

  setMarkers(occluded);
  setGroundMarkers(groundM);
  setSegments(segments);
}

// 2D line-segment intersection in lng/lat space. Returns t ∈ (0.03, 1] or null.
function _segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const s1x = bx - ax, s1y = by - ay;
  const s2x = dx - cx, s2y = dy - cy;
  const denom = -s2x * s1y + s1x * s2y;
  if (Math.abs(denom) < 1e-14) return null;
  const qx = ax - cx, qy = ay - cy;
  const s = (-s1y * qx + s1x * qy) / denom;
  const t = ( s2x * qy - s2y * qx) / denom;
  return (s >= 0 && s <= 1 && t > 0.03 && t <= 1) ? t : null;
}

// Standard ray-casting point-in-polygon (lng/lat). True if (x,y) is inside the ring.
function _ringContainsPoint(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-20) + xi)) inside = !inside;
  }
  return inside;
}

// Which building (if any) blocks the shadow ray. Queries the tile buildings.
// Returns { lon, lat, rayH, bldH, t } for the first hit, or false.
function _computeOcclusion() {
  if (!mapRef || !_endLngLat || !observerCache) return false;
  const oLon = observerCache.lon, oLat = observerCache.lat;
  const eLon = _endLngLat[0], eLat = _endLngLat[1];

  const pa = mapRef.project([oLon, oLat]);
  const pb = mapRef.project([eLon, eLat]);
  const M = 20;
  const layers = ['building-3d'].filter((id) => mapRef.getLayer(id));
  if (!layers.length) return false;
  let features;
  try {
    features = mapRef.queryRenderedFeatures(
      [[Math.min(pa.x, pb.x) - M, Math.min(pa.y, pb.y) - M],
       [Math.max(pa.x, pb.x) + M, Math.max(pa.y, pb.y) + M]],
      { layers },
    );
  } catch { return false; }
  if (!features || !features.length) return false;

  let bestT = Infinity, bestHit = null;
  for (const feat of features) {
    const bldH = (feat.properties?.render_height ?? feat.properties?.height) || 0;
    if (bldH < 1) continue;
    const polys = feat.geometry.type === 'Polygon'
      ? [feat.geometry.coordinates]
      : feat.geometry.type === 'MultiPolygon' ? feat.geometry.coordinates : [];
    for (const poly of polys) {
      const ring = poly[0];
      // Don't let the caster's OWN building occlude its ray. With the observer at
      // (e.g.) the CN Tower and the caster up at the skypod, the ray's first 2-D edge
      // crossing is the tower's own wall metres away — a spurious self-occlusion. Skip
      // any ring that contains the observer point.
      if (_ringContainsPoint(ring, oLon, oLat)) continue;
      for (let i = 0; i < ring.length - 1; i++) {
        const t = _segIntersect(oLon, oLat, eLon, eLat,
          ring[i][0], ring[i][1], ring[i+1][0], ring[i+1][1]);
        if (t === null || t >= bestT) continue;
        const rayH = OBJECT_H_M * (1 - t) + FLOOR_H_M * t;
        if (bldH > rayH) {
          bestT = t;
          bestHit = { lon: oLon + t*(eLon-oLon), lat: oLat + t*(eLat-oLat), rayH, bldH, t,
            edge: [ring[i], ring[i + 1]] };
        }
      }
    }
  }
  return bestHit || false;
}

// Which building (if any) blocks the SUN from reaching the caster — i.e. is the caster
// in shade. Mirror of _computeOcclusion, but the ray runs caster→sun (observer→body
// ground) and the beam height interpolates from the caster top (t=0) up to the sun
// anchor's altitude (t=1). A building taller than the beam where it crosses means no
// direct sun reaches the caster. Returns the hit nearest the SUN — the first wall the
// incoming light meets, where the beam should die — as { lon, lat, rayH, bldH, t }, or
// false. Same self-building skip as _computeOcclusion so the caster's own tower doesn't
// shade it.
function _computeSunOcclusion(body) {
  if (!mapRef || !observerCache || !body) return false;
  const oLon = observerCache.lon, oLat = observerCache.lat;   // caster ground
  const bLon = body.lon, bLat = body.lat;                     // sun anchor ground
  // Need the sun anchor above the caster for the beam-height interpolation to be
  // monotonic (degenerate when the sun sits below the caster top — skip).
  if (body.altM <= OBJECT_H_M + 0.5) return false;

  const pa = mapRef.project([oLon, oLat]);
  const pb = mapRef.project([bLon, bLat]);
  const M = 20;
  const layers = ['building-3d'].filter((id) => mapRef.getLayer(id));
  if (!layers.length) return false;
  let features;
  try {
    features = mapRef.queryRenderedFeatures(
      [[Math.min(pa.x, pb.x) - M, Math.min(pa.y, pb.y) - M],
       [Math.max(pa.x, pb.x) + M, Math.max(pa.y, pb.y) + M]],
      { layers },
    );
  } catch { return false; }
  if (!features || !features.length) return false;

  // For each building, the caster→sun ray crosses its outline twice: a caster-facing
  // edge (smaller t) and a sun-facing edge (larger t). The beam height rises with t, so
  // it's lowest at the caster-facing crossing — that's where a building blocks if it
  // blocks at all. But the light, coming FROM the sun, first MEETS the building at its
  // sun-facing roofline. So: confirm a block at the low (caster) side, then put the hit
  // at the sun-facing side — the roof-graze point where the descending beam meets roof
  // height (rayH = bldH), or the sun-facing wall if the beam is already below the roof
  // there. Keep the blocker whose hit is nearest the sun (largest tHit).
  const beamH = (t) => OBJECT_H_M * (1 - t) + body.altM * t;
  let bestT = -Infinity, bestHit = null;
  for (const feat of features) {
    const bldH = (feat.properties?.render_height ?? feat.properties?.height) || 0;
    if (bldH < 1) continue;
    const polys = feat.geometry.type === 'Polygon'
      ? [feat.geometry.coordinates]
      : feat.geometry.type === 'MultiPolygon' ? feat.geometry.coordinates : [];
    // Collect this building's ray crossings → caster-facing tMin, sun-facing tMax.
    let tMin = Infinity, tMax = -Infinity, own = false;
    for (const poly of polys) {
      const ring = poly[0];
      if (_ringContainsPoint(ring, oLon, oLat)) { own = true; break; }   // caster's own building
      for (let i = 0; i < ring.length - 1; i++) {
        const t = _segIntersect(oLon, oLat, bLon, bLat,
          ring[i][0], ring[i][1], ring[i+1][0], ring[i+1][1]);
        if (t === null) continue;
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      }
    }
    if (own || tMax < 0) continue;                       // no crossing / own building
    if (bldH <= beamH(tMin)) continue;                   // beam clears the roof → no block
    // Sun-facing contact: roof-graze (rayH = bldH) if the beam is still above the roof at
    // the sun-facing edge, else the sun-facing wall itself.
    let tHit, hitH;
    if (beamH(tMax) > bldH) {
      tHit = (bldH - OBJECT_H_M) / (body.altM - OBJECT_H_M);   // rayH(tHit) === bldH
      tHit = Math.min(tMax, Math.max(tMin, tHit));
      hitH = bldH;
    } else {
      tHit = tMax; hitH = beamH(tMax);
    }
    if (tHit <= bestT) continue;                         // keep the hit nearest the sun
    bestT = tHit;
    bestHit = { lon: oLon + tHit*(bLon-oLon), lat: oLat + tHit*(bLat-oLat), rayH: hitH, bldH, t: tHit };
  }
  return bestHit || false;
}

// ── Reflection geometry (sun ray bouncing off a vertical building wall) ────────
// Shared by the auto first-bounce (occluded caster ray) and the aim-mode reflector.

const _PI = Math.PI;

// Unit vector pointing the way sunlight travels (from the body toward the ground):
// horizontal toward azimuth+180, descending by the altitude. [east, north, up].
function _sunDir(p) {
  const toAz = p.azimuthDeg * _PI / 180 + _PI;
  const cosAlt = Math.cos(p.altitudeDeg * _PI / 180);
  const sinAlt = Math.sin(p.altitudeDeg * _PI / 180);
  return [Math.sin(toAz) * cosAlt, Math.cos(toAz) * cosAlt, -sinAlt];
}

// Horizontal unit normal of a footprint edge, flipped to face INTO the incoming
// light (so D·n < 0) — the orientation needed to reflect the beam off the wall.
function _edgeNormalFacingSun(p1, p2, latRef, D) {
  const cosLat = Math.cos(latRef * _PI / 180);
  const eE = (p2[0] - p1[0]) * 111320 * cosLat;
  const eN = (p2[1] - p1[1]) * 111320;
  const len = Math.hypot(eE, eN) || 1;
  let nE = eN / len, nN = -eE / len;
  if (D[0] * nE + D[1] * nN > 0) { nE = -nE; nN = -nN; }
  return [nE, nN];
}

// Reflect the light direction D off a vertical wall (horizontal normal nE,nN) at
// world point W{lon,lat,h} and project the reflected beam down to the ground.
// Returns {lon,lat} of the landing point, or null if the face isn't lit / the
// reflected beam doesn't descend.
function _reflectToGround(W, nE, nN, D) {
  const dotDN = D[0] * nE + D[1] * nN;
  if (dotDN >= -0.02) return null;          // wall not facing the sun
  const R = [D[0] - 2 * dotDN * nE, D[1] - 2 * dotDN * nN, D[2]];
  if (R[2] >= -0.001) return null;          // reflected beam not going downward
  const cosLat = Math.cos(W.lat * _PI / 180);
  const t = W.h / (-R[2]);
  const dE = t * R[0], dN = t * R[1];
  return { lon: W.lon + dE / (111320 * cosLat), lat: W.lat + dN / 111320 };
}

// Push a reflection (wall point W, facing normal, light dir D) into the GL arrays:
// the reflected leg W→G, the ground landing dot G (same circular dot as the shadow
// end), optionally the incoming sun→W line and the wall point itself.
function _pushReflection(W, normal, D, color, sunAnchor, drawWallDot, occluded, groundM, segments) {
  const G = _reflectToGround(W, normal[0], normal[1], D);
  if (!G) return;
  const wpt = { lon: W.lon, lat: W.lat, altM: W.h };
  const gpt = { lon: G.lon, lat: G.lat, altM: 0 };
  if (drawWallDot) occluded.push({ ...wpt, color, sizePx: 13 });
  if (sunAnchor) segments.push({ a: sunAnchor, b: wpt, color });
  segments.push({ a: wpt, b: gpt, color });
  groundM.push({ ...gpt, color, sizePx: 16 });
}

// ── Tap-to-reflect: pick an exact point on a building wall ─────────────────────
// Set / read the current reflector. The reflection redraws against the live sun on
// every shadow update (time/observer/mode), so the glint tracks the sun as you scrub.
export function setReflector(r) {
  _reflector = (r && Number.isFinite(r.lon) && Number.isFinite(r.lat) &&
                Number.isFinite(r.h) && r.edge) ? r : null;
  if (visible) update();
}
export function getReflector() { return _reflector; }

// Möller–Trumbore ray/triangle intersection in 3-D mercator space (double-sided).
// O, D are {x,y,z}; A,B,C are triangle verts. Returns distance t>EPS along D, or null.
function _rayTri(O, D, A, B, C) {
  const EPS = 1e-12;
  const e1 = [B.x - A.x, B.y - A.y, B.z - A.z];
  const e2 = [C.x - A.x, C.y - A.y, C.z - A.z];
  const pvec = [D.y * e2[2] - D.z * e2[1], D.z * e2[0] - D.x * e2[2], D.x * e2[1] - D.y * e2[0]];
  const det = e1[0] * pvec[0] + e1[1] * pvec[1] + e1[2] * pvec[2];
  if (Math.abs(det) < EPS) return null;                 // ray parallel to triangle
  const inv = 1 / det;
  const tvec = [O.x - A.x, O.y - A.y, O.z - A.z];
  const u = (tvec[0] * pvec[0] + tvec[1] * pvec[1] + tvec[2] * pvec[2]) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return null;
  const qvec = [tvec[1] * e1[2] - tvec[2] * e1[1], tvec[2] * e1[0] - tvec[0] * e1[2], tvec[0] * e1[1] - tvec[1] * e1[0]];
  const v = (D.x * qvec[0] + D.y * qvec[1] + D.z * qvec[2]) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;
  const t = (e2[0] * qvec[0] + e2[1] * qvec[1] + e2[2] * qvec[2]) * inv;
  return t > EPS ? t : null;
}

// Tap-pick the exact point on a building wall under a screen point. Builds the camera
// ray from the FREE camera position through the unprojected ground point (public API
// only — no internal matrix access), then intersects it against the tapped building's
// wall quads (each footprint edge extruded 0→height) and returns the nearest hit.
// Returns { lon, lat, h, edge:[p1,p2], bldH } or null (no building / wall under the tap).
export function pickWallPoint(map, screenPt) {
  if (!map || !maplibregl || !maplibregl.MercatorCoordinate) return null;
  const MC = maplibregl.MercatorCoordinate;
  const layers = ['building-3d'].filter((id) => map.getLayer(id));
  if (!layers.length) return null;
  let feats;
  try { feats = map.queryRenderedFeatures(screenPt, { layers }); } catch { return null; }
  if (!feats || !feats.length) return null;
  const feat = feats[0];                                   // topmost rendered building
  const bldH = (feat.properties?.render_height ?? feat.properties?.height) || 0;
  if (bldH < 3) return null;

  // Camera ray in mercator space: origin = real camera, through the z=0 ground point.
  let O;
  try { O = map.getFreeCameraOptions().position; } catch { return null; }
  if (!O) return null;
  const gll = map.unproject(screenPt);
  const G = MC.fromLngLat([gll.lng, gll.lat], 0);
  const D = { x: G.x - O.x, y: G.y - O.y, z: G.z - O.z };

  const polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates]
    : feat.geometry.type === 'MultiPolygon' ? feat.geometry.coordinates : [];
  let bestT = Infinity, best = null;
  for (const poly of polys) {
    const ring = poly[0];
    if (!ring || ring.length < 2) continue;
    for (let i = 0; i < ring.length - 1; i++) {
      const p1 = ring[i], p2 = ring[i + 1];
      // Wall quad corners (let MercatorCoordinate handle the altitude→z conversion so
      // we never depend on the sign/scale of the mercator z axis).
      const A = MC.fromLngLat([p1[0], p1[1]], 0);
      const B = MC.fromLngLat([p2[0], p2[1]], 0);
      const Ctop = MC.fromLngLat([p2[0], p2[1]], bldH);
      const Dtop = MC.fromLngLat([p1[0], p1[1]], bldH);
      let t = _rayTri(O, D, A, B, Ctop);
      if (t === null) t = _rayTri(O, D, A, Ctop, Dtop);
      if (t === null || t >= bestT) continue;
      bestT = t;
      const hit = new MC(O.x + t * D.x, O.y + t * D.y, O.z + t * D.z);
      const ll = hit.toLngLat();
      best = { lon: ll.lng, lat: ll.lat, h: Math.max(0, hit.toAltitude()), edge: [p1, p2], bldH };
    }
  }
  return best;
}

// Shot-wizard setup view: when on, the shadow layer draws only the caster sphere +
// pole (no sun line, shadow end, reflections or day arc). Clears the day arc on entry.
export function setSetupMode(v) {
  _setupMode = !!v;
  if (_setupMode) clearShadowArc();
  if (visible) update();
}
