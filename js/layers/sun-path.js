// Sun/moon path: the arc, live body dot and drop line are now drawn by the
// WebGL custom layer in arc-gl.js (so 3D buildings occlude them and we don't
// re-position 60+ DOM nodes every frame). This module owns the day-level
// geometry: it computes the arc samples and the live body position, converts
// them to world points (ground lng/lat + altitude in metres), and hands them
// to arc-gl. It also still owns the flat sunrise/sunset/ray GL LINE layers,
// which sit on the ground.
//
// Sphere model (unchanged): each sample's ground point is the radial projection
// of the body azimuth at horizontal distance R·cos(alt); its altitude is
// R·sin(alt) (+ anchorLift when a caster height is set, so body→caster→shadow
// stays collinear). arc-gl places the dot at exactly that world point.

import { getDayBoundaries, getPosition, getMoonPos, getMoonTimes } from '../solar.js';
import { PERF, perfMark, idleMs } from '../perf.js';
import { destination } from '../util.js';
import {
  arcLayer, isArcLayerAdded,
  setArcPoints, setLivePoint, setDropLine, setArcColor, setArcVisible,
} from './arc-gl.js';

const RAY_SRC = 'sun-ray-src';
const RAY_LINE = 'sun-ray-line';
const SR_SRC = 'sunrise-vec-src';
const SR_LINE = 'sunrise-vec-line';
const SS_SRC = 'sunset-vec-src';
const SS_LINE = 'sunset-vec-line';
// Wide blurred "glow" underlays, beneath each core line, so the rise/set/ray
// lines bloom like the shadow-arc (neon glow).
const SR_GLOW = 'sunrise-vec-glow';
const SS_GLOW = 'sunset-vec-glow';
const RAY_GLOW = 'sun-ray-glow';
// Faint "ghost" copies, drawn on top (via app.js restack) so these ground lines
// stay readable THROUGH buildings — the x-ray look. The solid copies above are
// re-stacked below the buildings, so on open ground they're full strength.
const SR_GHOST = 'sunrise-vec-line-ghost';
const SS_GHOST = 'sunset-vec-line-ghost';
const RAY_GHOST = 'sun-ray-line-ghost';
// Mega halos (huge + soft) — the bulk of the bloom, matching the shadow arc's mass.
const SR_MEGA = 'sunrise-vec-mega';
const SS_MEGA = 'sunset-vec-mega';
const RAY_MEGA = 'sun-ray-mega';
// Travelling comet pulse on the ray (the live sunbeam): light flowing in toward
// the observer. Only the ray pulses, so the per-frame animated line count stays low.
const RAY_PULSE = 'sun-ray-pulse';

// Tapered line gradient: fades to nothing at both tips, full in the middle.
const SR_RGB = [255, 138, 61];   // rise (orange)
const SS_RGB = [255, 94, 61];    // set (red)
const RAY_GOLD_RGB = [255, 184, 69];
const RAY_MOON_RGB = [208, 216, 232];
function _lineGradient([r, g, b], peak) {
  return ['interpolate', ['linear'], ['line-progress'],
    0, `rgba(${r},${g},${b},0)`, 0.18, `rgba(${r},${g},${b},${peak})`,
    0.82, `rgba(${r},${g},${b},${peak})`, 1, `rgba(${r},${g},${b},0)`];
}
const CORE_W = 6, CORE_PEAK = 0.62;   // bright core
const GLOW_W = 16, GLOW_BLUR = 8, GLOW_PEAK = 0.22;   // wide blurred bloom
// The x-ray "ghost" copy (drawn on top, seen THROUGH buildings) is deliberately
// dim + heavily blurred — so an occluded line reads as a soft diffuse glow behind
// slightly-translucent glass, clearly distinct from the crisp bright line on open
// ground. (The shadow-arc uses these same values for a consistent look.)
const GHOST_W = 11, GHOST_BLUR = 16, GHOST_PEAK = 0.2;
// Mega halo dims (shared by all three spokes).
const MEGA_W = 34, MEGA_BLUR = 18, MEGA_PEAK = 0.14;

// ── Ray comet pulse ──────────────────────────────────────────────────────────
const _PULSE_OFF = ['interpolate', ['linear'], ['line-progress'], 0, 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,0)'];
let _rayRgb = RAY_GOLD_RGB;          // tracks the live ray colour (gold sun / silver moon)
let _rayPulsePos = 1, _rayPulseRAF = 0, _rayPulseLast = 0;

function _pulseGradient(pos, [r, g, b]) {
  const w = 0.12;
  const lo = Math.max(0.0001, pos - w);
  const hi = Math.min(0.9999, pos + w);
  const s = ['interpolate', ['linear'], ['line-progress'], 0, `rgba(${r},${g},${b},0)`];
  if (lo > 0.0001) s.push(lo, `rgba(${r},${g},${b},0)`);
  s.push(pos, `rgba(255,255,255,0.85)`);
  if (hi < 0.9999) s.push(hi, `rgba(${r},${g},${b},0)`);
  s.push(1, `rgba(${r},${g},${b},0)`);
  return s;
}
let _rayPulsePaint = 0;
function _startRayPulse(map) {
  if (_rayPulseRAF) return;
  if (!PERF.pulse) { _stopRayPulse(map); return; }
  const tick = (t) => {
    _rayPulseRAF = 0;
    if (!map.getLayer || !map.getLayer(RAY_PULSE)) return;     // wiped (style reload) → let restart re-arm
    // See the note in layers/shadow.js: this loop keeps the entire map
    // repainting at 60fps on a still scene. Idle stop, and throttled paint.
    if (idleMs() > PERF.pulseIdleMs) { _stopRayPulse(map); return; }
    const dt = _rayPulseLast ? Math.min(50, t - _rayPulseLast) : 16; _rayPulseLast = t;
    _rayPulsePos -= dt / 1600;          // flow inward (tip → observer), ~1.6 s
    if (_rayPulsePos <= 0) _rayPulsePos += 1;
    if (t - _rayPulsePaint >= 1000 / PERF.pulseFps) {
      _rayPulsePaint = t;
      const done = perfMark('rayPulse');
      try { map.setPaintProperty(RAY_PULSE, 'line-gradient', _pulseGradient(_rayPulsePos, _rayRgb)); } catch {}
      done();
    }
    _rayPulseRAF = requestAnimationFrame(tick);
  };
  _rayPulseRAF = requestAnimationFrame(tick);
}
function _stopRayPulse(map) {
  if (_rayPulseRAF) { cancelAnimationFrame(_rayPulseRAF); _rayPulseRAF = 0; }
  _rayPulseLast = 0;
  if (map && map.getLayer && map.getLayer(RAY_PULSE)) {
    try { map.setPaintProperty(RAY_PULSE, 'line-gradient', _PULSE_OFF); } catch {}
  }
}

let arcRadiusKm = 1.5;          // adjustable via vertical slider
let anchorLiftMetres = 0;       // baseline lift added to every sample (caster height when shadow on)
const SAMPLES = 60;
let mapRef = null;

let arcSamples = [];            // [{ lon, lat, altDeg, azDeg }]
let liveSample = null;          // { lon, lat, altDeg, azDeg }
let visible = true;
let _suppressed = false;        // when true, the bead arc + live body are held cleared
                                // (used by the shot wizard's decluttered setup view)

// Hex → [r,g,b] in 0..1 for the GL color uniform.
const GOLD = [1.0, 0.722, 0.27];   // #ffb845
// Deepened from #d0d8e8: a richer silver-blue so the lit-sphere shading (white
// hotspot + corona) actually reads on the moon beads instead of washing out.
const MOON = [0.66, 0.75, 0.95];   // #a8bff2

export function setArcRadiusKm(km) {
  // Floor lowered to 5 m so very-close arcs are possible.
  arcRadiusKm = Math.max(0.005, +km || 1.5);
  // Horizontal positions change with radius, so a full day recompute is needed;
  // app.js already calls updateSunPathDay after moving this slider.
}
export function getArcRadiusKm() { return arcRadiusKm; }

/**
 * Re-anchor the arc to a different vertical baseline (in metres). Only the
 * altitude changes (not the ground lng/lat), so we just recompute altitudes and
 * push the arc + live point to the GL layer.
 */
export function setAnchorLiftMetres(m) {
  anchorLiftMetres = Math.max(0, +m || 0);
  if (mapRef) { pushArc(); pushLive(); }
}
export function getAnchorLiftMetres() { return anchorLiftMetres; }

export function addSunPathLayer(map) {
  mapRef = map;

  // GL source + layer setup: guard on source presence so this re-runs after a
  // style reload (which wipes all custom sources and layers).
  if (map.getSource(SR_SRC)) {
    // Sources exist; make sure the arc custom layer is also present (it lives
    // separately and is what a style reload removes alongside the sources).
    if (!isArcLayerAdded(map)) { try { map.addLayer(arcLayer); } catch {} }
    _startRayPulse(map);
    return;
  }
  const empty = { type: 'FeatureCollection', features: [] };

  // All three now carry lineMetrics so the ray can use the same tapered gradient.
  map.addSource(SR_SRC, { type: 'geojson', data: empty, lineMetrics: true });
  map.addSource(SS_SRC, { type: 'geojson', data: empty, lineMetrics: true });
  map.addSource(RAY_SRC, { type: 'geojson', data: empty, lineMetrics: true });

  // Mega halos (hugest + softest) at the very bottom, for the shadow-arc-grade bloom.
  map.addLayer({ id: SR_MEGA, type: 'line', source: SR_SRC,
    layout: { 'line-cap': 'round' }, paint: { 'line-width': MEGA_W, 'line-blur': MEGA_BLUR, 'line-gradient': _lineGradient(SR_RGB, MEGA_PEAK) } });
  map.addLayer({ id: SS_MEGA, type: 'line', source: SS_SRC,
    layout: { 'line-cap': 'round' }, paint: { 'line-width': MEGA_W, 'line-blur': MEGA_BLUR, 'line-gradient': _lineGradient(SS_RGB, MEGA_PEAK) } });
  map.addLayer({ id: RAY_MEGA, type: 'line', source: RAY_SRC,
    layout: { 'line-cap': 'round' }, paint: { 'line-width': MEGA_W, 'line-blur': MEGA_BLUR, 'line-gradient': _lineGradient(RAY_GOLD_RGB, MEGA_PEAK) } });

  // Glow underlays (wide + blurred) first, so the bright cores sit on top.
  map.addLayer({ id: SR_GLOW, type: 'line', source: SR_SRC,
    layout: { 'line-cap': 'round' }, paint: { 'line-width': GLOW_W, 'line-blur': GLOW_BLUR, 'line-gradient': _lineGradient(SR_RGB, GLOW_PEAK) } });
  map.addLayer({ id: SS_GLOW, type: 'line', source: SS_SRC,
    layout: { 'line-cap': 'round' }, paint: { 'line-width': GLOW_W, 'line-blur': GLOW_BLUR, 'line-gradient': _lineGradient(SS_RGB, GLOW_PEAK) } });
  map.addLayer({ id: RAY_GLOW, type: 'line', source: RAY_SRC,
    layout: { 'line-cap': 'round' }, paint: { 'line-width': GLOW_W, 'line-blur': GLOW_BLUR, 'line-gradient': _lineGradient(RAY_GOLD_RGB, GLOW_PEAK) } });

  map.addLayer({ id: SR_LINE, type: 'line', source: SR_SRC,
    layout: { 'line-cap': 'round' }, paint: { 'line-width': CORE_W, 'line-gradient': _lineGradient(SR_RGB, CORE_PEAK) } });
  map.addLayer({ id: SS_LINE, type: 'line', source: SS_SRC,
    layout: { 'line-cap': 'round' }, paint: { 'line-width': CORE_W, 'line-gradient': _lineGradient(SS_RGB, CORE_PEAK) } });
  map.addLayer({ id: RAY_LINE, type: 'line', source: RAY_SRC,
    layout: { 'line-cap': 'round' }, paint: { 'line-width': CORE_W, 'line-gradient': _lineGradient(RAY_GOLD_RGB, CORE_PEAK) } });
  // Comet pulse on the ray (starts dark; the rAF drives it).
  map.addLayer({ id: RAY_PULSE, type: 'line', source: RAY_SRC,
    layout: { 'line-cap': 'round' }, paint: { 'line-width': 9, 'line-blur': 2, 'line-gradient': _PULSE_OFF } });

  // X-ray ghosts (restacked on top) — tapered gradient + soft blur so the
  // through-building view still glows and fades at the tips.
  map.addLayer({ id: SR_GHOST, type: 'line', source: SR_SRC,
    layout: { 'line-cap': 'round' }, paint: { 'line-width': GHOST_W, 'line-blur': GHOST_BLUR, 'line-gradient': _lineGradient(SR_RGB, GHOST_PEAK) } });
  map.addLayer({ id: SS_GHOST, type: 'line', source: SS_SRC,
    layout: { 'line-cap': 'round' }, paint: { 'line-width': GHOST_W, 'line-blur': GHOST_BLUR, 'line-gradient': _lineGradient(SS_RGB, GHOST_PEAK) } });
  map.addLayer({ id: RAY_GHOST, type: 'line', source: RAY_SRC,
    layout: { 'line-cap': 'round' }, paint: { 'line-width': GHOST_W, 'line-blur': GHOST_BLUR, 'line-gradient': _lineGradient(RAY_GOLD_RGB, GHOST_PEAK) } });

  // The arc custom layer goes on top so the building depth buffer occludes it.
  if (!isArcLayerAdded(map)) { try { map.addLayer(arcLayer); } catch {} }
  _startRayPulse(map);
}

export function setSunPathVisible(map, vis) {
  visible = vis;
  const v = vis ? 'visible' : 'none';
  for (const id of [SR_MEGA, SS_MEGA, SR_GLOW, SS_GLOW, SR_LINE, SS_LINE, SR_GHOST, SS_GHOST]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
  setArcVisible(vis);
}

export function setBodyColor(map, moonMode) {
  setArcColor(moonMode ? MOON : GOLD);
  // The ray follows the body colour (gold sun / silver moon); rise/set keep their
  // distinct warm colours in BOTH modes (orange = rise, red = set).
  const rayRgb = moonMode ? RAY_MOON_RGB : RAY_GOLD_RGB;
  _rayRgb = rayRgb;   // the comet pulse picks this up on its next frame
  const set = (id, grad) => { if (map && map.getLayer(id)) try { map.setPaintProperty(id, 'line-gradient', grad); } catch {} };
  set(RAY_LINE, _lineGradient(rayRgb, CORE_PEAK));
  set(RAY_GLOW, _lineGradient(rayRgb, GLOW_PEAK));
  set(RAY_MEGA, _lineGradient(rayRgb, MEGA_PEAK));
  set(RAY_GHOST, _lineGradient(rayRgb, GHOST_PEAK));
}

// Hold the bead arc + live body cleared (or release them). Used by the shot
// wizard's decluttered setup view, which wants only ground-zero + caster on screen.
// Survives slider-driven repushes because pushArc/pushLive honour the flag.
export function setArcSuppressed(v) {
  _suppressed = !!v;
  if (_suppressed) { setArcPoints([]); setLivePoint(null); }
  else if (mapRef) { pushArc(); pushLive(); }
}

// Toggle just the flat sunrise/sunset spokes (without touching the arc-gl layer),
// so the wizard can hide them while the caster graphics keep rendering.
export function setRiseSetVisible(map, vis) {
  const v = vis ? 'visible' : 'none';
  for (const id of [SR_MEGA, SS_MEGA, SR_GLOW, SS_GLOW, SR_LINE, SS_LINE, SR_GHOST, SS_GHOST]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}

// Ray line is controlled independently so it can be toggled without touching the
// rest of the sun-path layers.
export function setRayLineVisible(map, vis) {
  const v = vis ? 'visible' : 'none';
  for (const id of [RAY_MEGA, RAY_GLOW, RAY_LINE, RAY_PULSE, RAY_GHOST]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
  if (vis) _startRayPulse(map); else _stopRayPulse(map);
}

// True spherical projection: horizontal distance = R·cos(alt), vertical lift = R·sin(alt).
function liftMetresAtAltitude(altDeg) {
  if (altDeg <= 0) return anchorLiftMetres;
  return arcRadiusKm * 1000 * Math.sin(altDeg * Math.PI / 180) + anchorLiftMetres;
}
function horizontalKmAtAltitude(altDeg) {
  return arcRadiusKm * Math.max(0, Math.cos(altDeg * Math.PI / 180));
}
function sampleSizePx(altDeg) {
  // Twice as many beads now, each half the size, so the arc reads as a finer trail
  // of suns. (The live body keeps its full size in pushLive.)
  return Math.round(8 + 6.5 * Math.sin(Math.min(90, Math.max(0, altDeg)) * Math.PI / 180));
}

// Build the arc point array (ground lng/lat + altitude in metres) and push to GL.
// The bead arc is subsampled down to ~ARC_BEADS dramatic suns; arcSamples itself
// stays dense so the shadow-arc line (which reads getArcSamples) stays smooth.
const ARC_BEADS = 24;
function pushArc() {
  if (_suppressed) { setArcPoints([]); return; }
  const n = arcSamples.length;
  if (!n) { setArcPoints([]); return; }
  const stride = Math.max(1, Math.round(n / ARC_BEADS));
  const pts = [];
  for (let i = 0; i < n; i++) {
    if (i % stride !== 0 && i !== n - 1) continue;   // keep strided beads + the last
    const s = arcSamples[i];
    pts.push({ lon: s.lon, lat: s.lat, altM: liftMetresAtAltitude(s.altDeg), sizePx: sampleSizePx(s.altDeg) });
  }
  setArcPoints(pts);
}

function pushLive() {
  if (_suppressed) { setLivePoint(null); setDropLine(null, null); return; }
  if (!liveSample) { setLivePoint(null); setDropLine(null, null); return; }
  const altM = liftMetresAtAltitude(liveSample.altDeg);
  setLivePoint({ lon: liveSample.lon, lat: liveSample.lat, altM, sizePx: 32 });
  // Vertical drop line removed per design — the live dot stands on its own.
  setDropLine(null, null);
}

/**
 * Day-level recompute. moonMode → use moon arc. Returns { rise, set }.
 */
export function updateSunPathDay(map, observer, datetime, moonMode = false) {
  const { lat, lon } = observer;

  let rise, set;
  if (moonMode) {
    const now = datetime;
    const yest  = getMoonTimes(new Date(now.getTime() - 24 * 3600 * 1000), lat, lon);
    const today = getMoonTimes(now, lat, lon);
    const tom   = getMoonTimes(new Date(now.getTime() + 24 * 3600 * 1000), lat, lon);
    const rises = [yest.rise, today.rise, tom.rise].filter(Boolean).sort((a, b) => a - b);
    const sets  = [yest.set,  today.set,  tom.set ].filter(Boolean).sort((a, b) => a - b);
    const pastRise = [...rises].reverse().find((r) => r <= now);
    if (pastRise) {
      const matchingSet = sets.find((s) => s > pastRise);
      if (matchingSet) { rise = pastRise; set = matchingSet; }
    }
    if (!rise) {
      const nextRise = rises.find((r) => r > now);
      if (nextRise) {
        const matchingSet = sets.find((s) => s > nextRise);
        if (matchingSet) { rise = nextRise; set = matchingSet; }
      }
    }
  } else {
    const t = getDayBoundaries(datetime, lat, lon);
    rise = t.sunrise; set = t.sunset;
  }

  arcSamples = [];
  if (rise && set && rise < set) {
    const total = set.getTime() - rise.getTime();
    const stepMs = total / SAMPLES;
    const getPos = moonMode ? getMoonPos : getPosition;
    for (let i = 0; i <= SAMPLES; i++) {
      const d = new Date(rise.getTime() + i * stepMs);
      const p = getPos(d, lat, lon);
      if (p.altitudeDeg < 0) continue;
      const [glon, glat] = destination(lat, lon, p.azimuthDeg, horizontalKmAtAltitude(p.altitudeDeg));
      arcSamples.push({ lon: glon, lat: glat, altDeg: p.altitudeDeg, azDeg: p.azimuthDeg });
    }
  }
  pushArc();

  const getPos = moonMode ? getMoonPos : getPosition;
  if (rise) {
    const az = getPos(rise, lat, lon).azimuthDeg;
    setLine(map, SR_SRC, [[lon, lat], destination(lat, lon, az, arcRadiusKm * 1.4)]);
  } else setLine(map, SR_SRC, []);
  if (set) {
    const az = getPos(set, lat, lon).azimuthDeg;
    setLine(map, SS_SRC, [[lon, lat], destination(lat, lon, az, arcRadiusKm * 1.4)]);
  } else setLine(map, SS_SRC, []);

  return { rise, set };
}

export function updateSunNow(map, observer, datetime, posOverride = null) {
  const { lat, lon } = observer;
  const p = posOverride || getPosition(datetime, lat, lon);

  if (p.altitudeDeg < -1) {
    setLine(map, RAY_SRC, []);
    liveSample = null;
    pushLive();
    return p;
  }
  const horizKm = horizontalKmAtAltitude(p.altitudeDeg);
  const [glon, glat] = destination(lat, lon, p.azimuthDeg, horizKm);
  // Ray: a fixed-length spoke from the observer toward the body's ground azimuth,
  // identical in length to the sunrise/sunset spokes (R·1.4) so the three match.
  setLine(map, RAY_SRC, [[lon, lat], destination(lat, lon, p.azimuthDeg, arcRadiusKm * 1.4)]);

  liveSample = { lon: glon, lat: glat, altDeg: p.altitudeDeg, azDeg: p.azimuthDeg };
  pushLive();
  return p;
}

/** Live body world position (used by shadow renderer for the sky→caster line). */
export function getLiveBodyAnchor() {
  if (!liveSample) return null;
  return { ...liveSample, altM: liftMetresAtAltitude(liveSample.altDeg) };
}

/** Snapshot of the arc samples (for shadow-position arc + future AR overlay). */
export function getArcSamples() {
  return arcSamples.slice();
}

function setLine(map, srcId, coords) {
  const valid = coords && coords.length >= 2;
  const src = map.getSource(srcId);
  if (!src) return;
  if (!valid) {
    src.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  src.setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }],
  });
}
