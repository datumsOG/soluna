import { getPosition, getMoonPos } from './solar.js';
import { PERF, noteInteraction, countRender } from './perf.js';
// MapLibre setup using OpenFreeMap (no API key, no signup).
// Terrain elevation uses AWS Terrain Tiles (Terrarium format, public, no key).

const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export function initMap(container, center) {
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: [center.lon, center.lat],
    zoom: 14,
    pitch: 55,
    attributionControl: false,
    dragRotate: true,
    pitchWithRotate: true,
    maxPitch: 85,
    minZoom: 14, // floor: the basemap tiles only carry buildings at z14+, so locking the
                 // zoom-out here means buildings are ALWAYS present (never disappear, and
                 // they're on-screen through the whole boot reveal so they don't pop in).
    maxZoom: 20, // capped: extreme zoom + extrusions spiked iOS memory (grid mode is gone)
    // Hardware MSAA on the WebGL context. Defaults to false in MapLibre, which left
    // the custom-layer pole/shadow/beam quads (and building edges) jagged — the alpha
    // feather alone can't antialias geometry edges. This smooths them at the source.
    // ?msaa=0 turns this off. Hardware MSAA over 3D extrusions is the single
    // most expensive rendering option available on a phone GPU.
    antialias: PERF.msaa !== 0,
    // Cap the render resolution. MapLibre defaults to the device's own ratio,
    // which is 3 on recent iPhones — 2.25x the fragments of 2x for a difference
    // nobody has reported being able to see. ?dpr=1 halves it again.
    pixelRatio: Math.min(window.devicePixelRatio || 1, PERF.dpr),
  });
  // Any interaction re-arms the animated comets, which stop themselves when the
  // app goes idle so the map can settle. See js/perf.js.
  for (const ev of ['movestart', 'mousedown', 'touchstart', 'wheel', 'keydown']) {
    try { map.on(ev, noteInteraction); } catch {}
  }
  map.on('render', countRender);
  if (map.touchPitch && typeof map.touchPitch.enable === 'function') {
    try { map.touchPitch.enable(); } catch {}
  }
  // Brighten labels (pure white with dark halo) once the style is up.
  // style.load fires once per full style (re)load — not on every tile event.
  // Using styledata here would run 50-100 setPaintProperty calls on every tile fetch.
  // Dark tuning always runs first (the default, recruiter-facing path is untouched);
  // light mode then layers its overrides ON TOP when the body is in `invert`.
  map.on('style.load', () => {
    tuneLabels(map); tuneRoads(map); brightenBuildings(map);
    if (document.body.classList.contains('invert')) applyLightTheme(map);
  });
  return map;
}

// Labels: brighter near-white text so street names pop against the dark basemap
// (was dimmed to 0.5 for the "void" look — Blair wants them to read more).
function tuneLabels(map) {
  try {
    const layers = map.getStyle().layers || [];
    for (const layer of layers) {
      if (layer.type !== 'symbol') continue;
      // Dim grey, legible but recessive — readable without washing out the luminous
      // overlay graphics. Strong dark halo keeps them crisp on the dark roads.
      try { map.setPaintProperty(layer.id, 'text-color', 'rgba(174,182,196,0.62)'); } catch {}
      try { map.setPaintProperty(layer.id, 'text-halo-color', 'rgba(0,0,0,0.9)'); } catch {}
      try { map.setPaintProperty(layer.id, 'text-halo-width', 1.3); } catch {}
      try { map.setPaintProperty(layer.id, 'text-opacity', 0.62); } catch {}
    }
  } catch {}
}

// Roads: the OpenFreeMap "dark" style draws streets almost black (#181818,
// hsl(0,0%,7%), …) so they vanish. Override the known transportation layers with an
// explicit lighter ramp — minor = medium grey, arterial = light grey, motorway =
// near-white — so the street grid reads clearly. (Keyed to that style's layer ids;
// any unknown transportation line gets the medium-grey default.)
// Muted ramp: clearly lighter than the near-black originals so the grid reads, but
// kept GREY (not white) and well below the luminous overlay graphics so the arc/beam
// still dominate. Distinct tiers: path → minor → arterial → motorway.
const ROAD_COLORS = {
  road_pier:               '#262626',
  highway_path:            '#2c2c2c',
  highway_minor:           '#3c3c3c',   // residential / minor — dark grey
  highway_major_casing:    '#282828',   // arterial edge
  highway_major_inner:     '#525252',   // arterial body — medium-dark grey
  highway_major_subtle:    '#4a4a4a',
  highway_motorway_casing: '#333333',   // motorway edge
  highway_motorway_inner:  '#6c6c6c',   // motorway body — medium grey (recessive)
  highway_motorway_subtle: '#5e5e5e',
};
function tuneRoads(map) {
  try {
    const layers = map.getStyle().layers || [];
    for (const layer of layers) {
      if (layer.type !== 'line') continue;
      if ((layer['source-layer'] || '') !== 'transportation') continue;
      if (/railway/i.test(layer.id)) continue;   // leave rail dark so it doesn't clutter
      const col = ROAD_COLORS[layer.id] || '#9a9a9a';
      try { map.setPaintProperty(layer.id, 'line-color', col); } catch {}
    }
  } catch {}
}

// ── Real light theme ───────────────────────────────────────────────────────────
// Light mode used to be a CSS `invert(1)` over the whole canvas — a photo-negative,
// not a real light map (roads/water/graphics came out colour-shifted). Instead we now
// recolour the basemap to a genuine light palette via paint properties, and the CSS
// drops the invert so the luminous overlay graphics keep their true colours. Only the
// layers below are touched; `applyDarkTheme` restores the originals (roads/labels via
// the existing dark tuners, plus the background/water/land/boundary fills). Building
// colour is handled separately in app.js (`applyBuildingTheme`).
const ROAD_COLORS_LIGHT = {
  road_pier:               '#dcdcdc',
  highway_path:            '#dadada',
  highway_minor:           '#ffffff',
  highway_major_casing:    '#cdcdcd',
  highway_major_inner:     '#ffffff',
  highway_major_subtle:    '#efefef',
  highway_motorway_casing: '#c4c4c4',
  highway_motorway_inner:  '#ffffff',
  highway_motorway_subtle: '#ededed',
};

// Background / water / land / boundary fills — the layers the road/label tuners don't
// touch. light=true recolours them; light=false restores the dark style's originals.
function _themeFills(map, light) {
  const set = (id, prop, val) => { try { map.setPaintProperty(id, prop, val); } catch {} };
  let layers; try { layers = map.getStyle().layers || []; } catch { return; }
  for (const l of layers) {
    const sl = l['source-layer'] || '', id = l.id;
    if (l.type === 'background') {
      set(id, 'background-color', light ? '#e8e8ea' : 'rgb(12,12,12)');
    } else if (sl === 'water' || sl === 'waterway') {
      set(id, l.type === 'fill' ? 'fill-color' : 'line-color', light ? '#bcd6ea' : 'rgb(27,27,29)');
    } else if (sl === 'landcover' || sl === 'landuse') {
      const park = /wood|park|grass|forest/i.test(id);
      const dark = park ? 'rgb(32,32,32)' : (/residential/i.test(id) ? 'hsl(0,2%,5%)' : 'rgb(12,12,12)');
      set(id, 'fill-color', light ? (park ? '#d8e4d2' : '#e3e3e5') : dark);
    } else if (sl === 'boundary') {
      set(id, 'line-color', light ? '#c2c2c2' : 'hsl(0,0%,22%)');
    }
  }
}

export function applyLightTheme(map) {
  _themeFills(map, true);
  try {
    const layers = map.getStyle().layers || [];
    for (const l of layers) {
      const sl = l['source-layer'] || '';
      if (sl === 'transportation' && l.type === 'line') {
        if (/railway/i.test(l.id)) { try { map.setPaintProperty(l.id, 'line-color', '#d2d2d2'); } catch {} continue; }
        try { map.setPaintProperty(l.id, 'line-color', ROAD_COLORS_LIGHT[l.id] || '#ffffff'); } catch {}
      } else if (l.type === 'symbol') {
        try { map.setPaintProperty(l.id, 'text-color', 'rgba(40,44,52,0.85)'); } catch {}
        try { map.setPaintProperty(l.id, 'text-halo-color', 'rgba(255,255,255,0.9)'); } catch {}
        try { map.setPaintProperty(l.id, 'text-opacity', 0.92); } catch {}
      }
    }
  } catch {}
}

export function applyDarkTheme(map) {
  _themeFills(map, false);
  tuneRoads(map);
  tuneLabels(map);
}

// Light the 3D buildings from the real body position: facing faces brighten,
// shadowed faces fall to near-black. Sexy AND meaningful. Call per frame as the
// body moves. polar 0 = overhead, 90 = horizon; azimuthal = compass azimuth.
//
// NEUTRAL directional light. The light DIRECTION tracks the body (so faces shade
// light/dark by sun/moon position — the moving-shadow effect Blair liked), but the
// COLOUR stays near-white: only a whisper of warm (sun) / cool (moon). A strongly
// time-tinted light read as pink at dawn, indigo at dusk and tan midday across the
// day — neutral keeps the buildings a clean grey at every time. Intensity eases
// down a little below the horizon so night reads a touch calmer.
function _lerp(a, b, t) { return a + (b - a) * t; }
function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Where the body reaches its highest point on a given local day — solar noon for
// the sun, upper culmination ("mathematical noon") for the moon. Sampled rather
// than solved: SunCalc gives a position for an instant, not a transit time, and a
// two-stage scan is a few hundred cheap calls once per day.
const _noonCache = new Map();

function _culmination(date, lat, lon, moon) {
  const d0 = new Date(date); d0.setHours(0, 0, 0, 0);
  const key = `${d0.toDateString()}|${moon ? 'm' : 's'}|${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = _noonCache.get(key);
  if (hit) return hit;

  const at = (t) => (moon ? getMoonPos(t, lat, lon) : getPosition(t, lat, lon));
  let best = null;
  const scan = (startMs, endMs, stepMs) => {
    for (let t = startMs; t <= endMs; t += stepMs) {
      const p = at(new Date(t));
      if (!best || p.altitudeDeg > best.altitudeDeg) best = { ...p, t };
    }
  };
  const base = d0.getTime();
  scan(base, base + 864e5, 6e5);                       // whole day, 10-minute steps
  scan(best.t - 6e5, best.t + 6e5, 3e4);               // refine ±10 min, 30-second steps

  // The moon can spend a whole local day below the horizon. Use its high point
  // anyway — it is still the most stable, most overhead direction available — but
  // never let the light come from under the ground.
  const out = { az: best.azimuthDeg, alt: Math.max(best.altitudeDeg, 5) };
  if (_noonCache.size > 8) _noonCache.clear();
  _noonCache.set(key, out);
  return out;
}

export function setSceneLight(map, azDeg, altDeg, moon = false, ctx = null) {
  if (!map || !map.setLight) return;
  // Below the horizon the body's azimuth keeps sweeping UNDER the earth, which
  // rotated the building shading at night ("light through the planet").
  //
  // The old fix froze the direction and dropped intensity to 0.2. Blair,
  // 2026-09-14: "the lighting actually really washes out the 3d buildings before
  // or after sunset... when the sun/moon is below the horizon, let's have it
  // default to noon lighting (mathematical noon for moon)."
  //
  // So below the horizon we now light the scene from THAT DAY'S CULMINATION —
  // the sun at solar noon, the moon at its transit — at full daytime intensity.
  // High and nearly overhead means roofs read bright and walls keep their
  // separation, which is exactly the contrast that was being lost. It is also
  // static, so the night scene still does not rotate.
  const below = altDeg <= 0;
  let az, polar, intensity;
  if (below) {
    let noon = null;
    if (ctx && Number.isFinite(ctx.lat) && Number.isFinite(ctx.lon) && ctx.date) {
      try { noon = _culmination(ctx.date, ctx.lat, ctx.lon, moon); } catch {}
    }
    // Fallback if the caller gave us no context: due south, steep. Toronto is in
    // the northern hemisphere, so the high point is always southward.
    az = noon ? ((noon.az % 360) + 360) % 360 : 180;
    polar = _clamp(90 - (noon ? noon.alt : 45), 5, 85);
    intensity = 0.5;                                   // the top of the daytime ramp
  } else {
    az = ((azDeg % 360) + 360) % 360;
    polar = _clamp(90 - altDeg, 5, 95);
    const aboveT = _clamp((altDeg + 4) / 12, 0, 1);    // ~0 just above horizon → 1 by ~+8°
    intensity = _lerp(0.3, 0.5, aboveT);
  }
  try {
    map.setLight({
      anchor: 'map',
      position: [1.4, az, polar],
      color: moon ? '#eef1f6' : '#f7f2ea',          // barely cool / barely warm — near-white
      intensity,
    });
  } catch {}
}

function brightenBuildings(map) {
  try {
    if (map.getLayer('building-3d')) return;
    // Keep buildings BELOW the arc-gl custom layer when it already exists, so the
    // arc renders last and tests against the buildings' depth (they occlude it).
    const beforeId = map.getLayer('arc-gl') ? 'arc-gl' : undefined;
    map.addLayer({
      id: 'building-3d',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 14, // tiles only carry buildings at z14+; below that there are no buildings
      paint: {
        // Warm-neutral dark base (R≥G≥B). MUST NOT be cool: the always-on canvas
        // filter brightness(1.6) contrast(1.1) exaggerates any blue bias — a base
        // of (42,42,46) renders as (61,61,69), an intense blue-purple, and since
        // shadowed faces show the base, the whole low-light scene went blue. A
        // faintly warm base filters to a neutral grey instead.
        // Darkened (#2b2a28 → #201f1d): the brighter roads/labels lifted the whole
        // scene, washing out the luminous arc/beam — pulling buildings back down lets
        // the overlay graphics dominate again. (Still warm-neutral so the canvas
        // brightness filter doesn't tint it blue.)
        'fill-extrusion-color': '#201f1d',
        'fill-extrusion-height': ['get', 'render_height'],
        'fill-extrusion-base': ['get', 'render_min_height'],
        // OPAQUE on purpose (opacity defaults to 1.0): a constant-opaque extrusion
        // renders in the OPAQUE pass and writes the depth buffer, so the arc-gl
        // custom layer above it is occluded by it. A zoom-interpolated / <1 opacity
        // would push it to the translucent pass, which skips depth-write and breaks
        // occlusion — the reason the arc looked "in front" of buildings before.
      },
    }, beforeId);
  } catch {}
}

/**
 * Add Terrarium DEM source for elevation queries.
 * exaggeration:0 keeps the map visually flat so SVG overlays stay aligned,
 * while still allowing queryTerrainElevation() for terrain-aware shadows.
 * Safe to call multiple times; no-op if terrain already set.
 */
export function addTerrain(map) {
  try {
    if (!map.getSource('terrain-dem')) {
      map.addSource('terrain-dem', {
        type: 'raster-dem',
        tiles: [TERRAIN_TILES],
        tileSize: 256,
        encoding: 'terrarium',
        maxzoom: 14,
      });
    }
    map.setTerrain({ source: 'terrain-dem', exaggeration: 0 });
  } catch (e) {
    console.warn('terrain setup failed', e);
  }
}

// Resolve when the style is ready, but NEVER hang: also resolve on a style
// load error or after a timeout. The map style + tiles are cross-origin
// (OpenFreeMap) and uncached, so on a flaky mobile network the fetch can fail
// or stall — if this promise never resolved, main() would stall after the UI
// painted but before layers/handlers attached (blank, dead map). Resolves with
// a boolean: did the style actually load?
export function whenStyleReady(map, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (map.isStyleLoaded()) { resolve(true); return; }
    let done = false;
    const finish = (ok) => { if (done) return; done = true; resolve(ok); };
    map.once('styledata', () => finish(true));
    map.once('error', () => finish(map.isStyleLoaded()));
    setTimeout(() => finish(map.isStyleLoaded()), timeoutMs);
  });
}
