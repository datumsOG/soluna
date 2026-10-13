// Main wiring. Boots map, layers, UI; subscribes to state changes.

import * as store from './state.js';
import { initPerfMeter, noteInteraction } from './perf.js';
// applyLightTheme/applyDarkTheme kept in map.js but unwired here — the light-mode
// button is removed for now (works, but wants tuning); easy to revive later.
import { initMap, whenStyleReady, setSceneLight } from './map.js';
import { createGlassLayer } from '../kit/glass/host-maplibre.js?v=1.0.0';
import { PERF } from './perf.js';

// The glass is the UI kit's (kit/, pinned release 1.0.0; never edited here). It replaced
// this app's own js/layers/glass.js on 2026-10-10. Two things that file did and the kit
// does not are kept by wrapping render(): nothing is drawn while the boot veil is up,
// and ?glass=0 switches the glass off. The kit sets body.lg itself, after the first
// frame it has really drawn, so until then every surface keeps its CSS skin.
const GLASS_LAYER_ID = 'glass';
const glassLayer = createGlassLayer();
{
  const draw = glassLayer.render;
  glassLayer.render = (...a) => {
    if (!PERF.glass || document.body.classList.contains('booting')) return;
    draw(...a);
  };
}
// A toggle that is ON is stained amber glass (the kit's palette), where it used to get
// an amber CSS fill. The kit reads data-tint; this keeps it in step with aria-pressed.
function syncTints() {
  document.querySelectorAll('[data-glass][aria-pressed]').forEach((el) => {
    const on = el.getAttribute('aria-pressed') === 'true';
    if (on && el.dataset.tint !== 'amber') el.dataset.tint = 'amber';
    else if (!on && el.dataset.tint) delete el.dataset.tint;
  });
}
import { addObserverLayer, setObserver, setObserverVisible } from './layers/observer.js';
import { addSunPathLayer, updateSunPathDay, updateSunNow, setSunPathVisible, setRayLineVisible, setBodyColor, setArcRadiusKm, getArcRadiusKm, setArcSuppressed, setRiseSetVisible } from './layers/sun-path.js';
import { addTargetLayer, setTarget } from './layers/target.js';
import { addShadowLayer, updateShadow, updateShadowArcDay, setShadowVisible, setShadowHeight, setFloorHeight, getShadowHeight, getFloorHeight, getShadowEndLngLat, getFloorDotLngLat, setSetupMode } from './layers/shadow.js';
import { initScrubber, renderScrubberTicks, setScrubberRange, paintScrubberDayRamp } from './ui/scrubber.js';
import { initSearch } from './ui/search.js';
import { enableCompass, disableCompass } from './ui/sensor.js';
import { attachHashSync } from './share.js';
import { getPosition, getMoonPos, getMoonIllumination, getMoonTimes, getDayBoundaries, getSunTimes } from './solar.js';
import { findAlignmentBetweenPoints } from './alignment.js';
import { formatTime, formatDate, throttleRaf, startOfLocalDay, debounce } from './util.js';
import { checkAndNotify } from './reminders.js';
import { initMonitor, captureError } from './monitor.js';
import { initSaves } from './saves.js';

const $ = (id) => document.getElementById(id);

const dom = {
  map: $('map'),
  search: $('search'),
  searchResults: $('search-results'),
  scrubber: $('scrubber'),
  scrubberTicks: $('scrubber-ticks'),
  scrubberWrap: $('scrubber-wrap'),
  hh: $('time-hh'),
  dateBtn: $('date-btn'),
  dateLabel: $('date-label'),
  dateInput: $('date-input'),
  bodyToggle: $('body-toggle'),
  bodyIconSun: $('body-icon-sun'),
  bodyIconMoon: $('body-icon-moon'),
  sunAlt: $('sun-alt'),
  locateBtn: $('locate-btn'),
  compassToggle: $('compass-toggle'),
  lockBtn: $('lock-btn'),
  dataBtn: $('data-btn'),
  dataModal: $('data-modal'),
  dataText: $('data-text'),
  dataCopy: $('data-copy-btn'),
  dataClose: $('data-close-btn'),
  alignWizardBtn: $('align-wizard-btn'),
  pastWarning: $('past-warning'),
  shadowElevPanel: $('shadow-elev-panel'),
  shadowElev: $('shadow-elev'),
  shadowElevVal: $('shadow-elev-val'),
  floorElev: $('floor-elev'),
  floorElevVal: $('floor-elev-val'),
  toast: $('toast'),
  tiltSlider: $('tilt-slider'),
  radiusSlider: $('radius-slider'),
  alignPanel: $('align-panel'),
  alignNext: $('align-next-btn'),
  alignDone: $('align-done-btn'),
  alignClose: $('align-close'),
  alignStepA: $('align-step-a'),
  alignStepB: $('align-step-b'),
};

let map;
let lastDayKey = null;
let lastObserverKey = null;
let _restoredSession = null;   // saved last-session snapshot applied at boot (zoom restored after map init)
let _applyDefaultCaster = false; // first-run only: push DEFAULT_CASTER_M into the caster slider after restoreUI

// First-run default scene (no saved session, no shared link): stand at the CN Tower
// with the tower itself as the caster, so the very first load throws a dramatic shadow
// across downtown rather than asking for geolocation. Blair plans shots elsewhere, so
// we deliberately do NOT geolocate on first run (the locate button still works on demand).
const DEFAULT_OBSERVER = { lat: 43.6426, lon: -79.3871 }; // CN Tower, Toronto
const DEFAULT_CASTER_M = 446;                              // CN Tower height (m)
const PAST_WARNING_WINDOW_MS = 60 * 86400000;              // see updateNowText

// Opening time for the first-run default scene:
//   sun above horizon now  → now (it already looks good with a live sun)
//   sun below horizon now  → next morning, when the sun is 20% of the way through its
//                            above-horizon arc (sunrise + 0.2·(sunset−sunrise)) — a low
//                            morning sun that rakes long shadows across the city.
// "Next morning" = the next future occurrence: pre-dawn loads land on today's morning,
// post-sunset loads land on tomorrow's. Scans up to 3 days as a safety net.
function defaultOpeningDatetime(lat, lon) {
  const now = new Date();
  if (getPosition(now, lat, lon).altitudeDeg > 0) return now;
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 86400000);
    const t = getSunTimes(probe, lat, lon);
    if (t.sunrise && t.sunset && t.sunset > t.sunrise) {
      const moment = new Date(t.sunrise.getTime() + 0.2 * (t.sunset.getTime() - t.sunrise.getTime()));
      if (moment.getTime() > now.getTime()) return moment;
    }
  }
  return now;
}

// Apply the first-run default scene (CN Tower as viewpoint + 446 m caster, at a good
// time). Used both on a genuine first visit and on a reload (see main()).
function applyDefaultScene() {
  const dt = defaultOpeningDatetime(DEFAULT_OBSERVER.lat, DEFAULT_OBSERVER.lon);
  store.set({ observer: { ...DEFAULT_OBSERVER }, mode: 'sun', datetime: dt, sunDatetime: dt });
  _applyDefaultCaster = true;
}

// True when this page load is a reload (Cmd-R, hard reload, or pull-to-refresh) rather
// than a fresh navigation or PWA cold launch. A reload deliberately drops you back on the
// intro scene — the low-friction way to get the default view back.
function isReloadNavigation() {
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav && nav.type) return nav.type === 'reload';
    return !!(performance.navigation && performance.navigation.type === 1);
  } catch { return false; }
}

// Idle perspective drift — gentle bearing+pitch oscillation when map is static.
let _driftRafId = null;
let _driftBaseBearing = 0;
let _driftBasePitch = 55;
let _driftT0 = 0;
let _driftLastFrame = 0;
let _lastInteract = Date.now();
const DRIFT_IDLE_MS = 4000;   // start after 4 s of no interaction
const DRIFT_FPS_MS = 40;      // ~25 fps — gentle drift doesn't need 60, and 60 fps
                              // re-render of the whole map pinned the iOS GPU.
const DRIFT_MAX_MS = 90000;   // auto-stop after 90 s so idle never holds the GPU hot forever

function _driftFrame(ts) {
  if (!map) { _driftRafId = null; return; }
  const s = store.get();
  // Stop drifting if compass took over or the app was backgrounded.
  if (s.compassEnabled || document.hidden) { _driftRafId = null; return; }
  if (ts - _driftT0 > DRIFT_MAX_MS) { stopDrift(); return; }
  _driftRafId = requestAnimationFrame(_driftFrame);
  if (ts - _driftLastFrame < DRIFT_FPS_MS) return;   // throttle the actual map writes
  _driftLastFrame = ts;
  const t = (ts - _driftT0) / 1000;
  const maxP = (map.getMaxPitch && map.getMaxPitch()) || 85;
  const bear = _driftBaseBearing + 2.0 * Math.sin(2 * Math.PI * t / 16);
  const pitch = Math.min(maxP, _driftBasePitch + 1.5 * Math.sin(2 * Math.PI * t / 22));
  try { map.jumpTo({ bearing: bear, pitch }); } catch {}
}

function stopDrift() {
  if (_driftRafId) {
    cancelAnimationFrame(_driftRafId);
    _driftRafId = null;
    if (map) map.easeTo({ bearing: _driftBaseBearing, pitch: _driftBasePitch, duration: 600, easing: (t) => t < 0.5 ? 2*t*t : -1+(4-2*t)*t });
  }
  _lastInteract = Date.now();
}

// Pause compass bearing/pitch updates while user is touching (panning/zooming)
// to prevent programmatic setBearing() from interrupting MapLibre's gesture handler.
let _touching = false;

// Apply the tilt slider: simple 0-85° pitch.
function _applyTiltSlider() {
  if (!dom.tiltSlider) return;
  const v = Math.max(0, Math.min(85, +dom.tiltSlider.value || 0));
  try { map.setPitch(v); } catch {}
}

function _startDrift() {
  return;   // idle drift disabled
  if (_driftRafId) return;
  if (document.hidden) return;
  const s = store.get();
  if (s.compassEnabled) return;
  // Don't start drift while a flyTo/easeTo is in progress — would conflict
  if (map.isMoving && map.isMoving()) return;
  _driftBaseBearing = map.getBearing();
  _driftBasePitch = map.getPitch();
  _driftT0 = performance.now();
  _driftRafId = requestAnimationFrame(_driftFrame);
}

// Map slider value 0..1000 to height 0..1000 m on a log curve (default 333 → ~10 m).
// 0 → 0 m exactly, otherwise log-curved from 1 m up to 1000 m.
function sliderToHeight(v) {
  const n = +v;
  if (n <= 0) return 0;
  const t = Math.min(1, n / 1000);
  return Math.max(1, Math.round(Math.pow(1000, t)));
}
// Inverse: metres → slider value (for syncing the number input back to the slider).
function heightToSlider(h) {
  if (h <= 0) return 0;
  const clamped = Math.max(1, Math.min(1000, h));
  return Math.max(1, Math.min(1000, Math.round(1000 * Math.log(clamped) / Math.log(1000))));
}
// Map slider value 0..1000 to arc radius (km) on a log curve. The TOP of the range is
// capped so the largest arc just fits the screen width at the most-zoomed-out level
// (the map's minZoom is 14) — you can't zoom out further, so a bigger arc would just
// run off-screen. ~0.7 km fills an iPhone width at Toronto's latitude at z14; nudge
// ARC_KM_MAX if it sits slightly off on the device. (Was 0.02–50 km, which let the
// upper ~60% of the slider make arcs far larger than the screen could ever show.)
const ARC_KM_MIN = 0.05;
const ARC_KM_MAX = 0.7;
function sliderToRadiusKm(v) {
  const t = Math.max(0, Math.min(1, +v / 1000));
  return ARC_KM_MIN * Math.pow(ARC_KM_MAX / ARC_KM_MIN, t);
}

// ── Alignment wizard ────────────────────────────────────────────────────────
// Shot wizard. Step 1 ("caster"): tap = move ground zero, caster slider = caster
// height. Step 2 ("camera"): tap = where you'll shoot from, floor slider = its
// elevation. Done searches for when the sun sits behind the caster as seen from the
// camera — which makes the caster's shadow fall toward, and land at, the camera.
let _alignStep = null;          // null | 'caster' | 'camera'
let _alignSetup = false;        // true while the decluttered setup view is active
let _alignCamera = null;        // { lat, lon } camera location
let _alignCameraMarker = null;  // maplibregl.Marker for the camera point

function _openAlignWizard() {
  if (!dom.alignPanel) return;
  if (dom.alignWizardBtn) { dom.alignWizardBtn.classList.add('active'); dom.alignWizardBtn.setAttribute('aria-pressed', 'true'); }
  // The wizard needs taps + sliders to work, so clear any existing lock.
  if (store.get().locked) { store.set({ locked: false }); syncLock(); }
  _alignStep = 'caster';
  _alignSetup = true;
  _alignCamera = null;
  _removeCameraMarker();
  if (dom.alignStepA) dom.alignStepA.hidden = false;
  if (dom.alignStepB) dom.alignStepB.hidden = true;
  if (dom.alignDone) dom.alignDone.disabled = true;
  dom.alignPanel.hidden = false;
  try { syncChrome(store.get()); } catch {}
  showToast('Tap the map to set ground zero');
}

function _closeAlignWizard() {
  _alignStep = null;
  _alignSetup = false;
  _alignCamera = null;
  _removeCameraMarker();
  if (dom.alignPanel) dom.alignPanel.hidden = true;
  if (dom.alignWizardBtn) { dom.alignWizardBtn.classList.remove('active'); dom.alignWizardBtn.setAttribute('aria-pressed', 'false'); }
  try { syncChrome(store.get()); } catch {}
}

function _removeCameraMarker() {
  if (_alignCameraMarker) { try { _alignCameraMarker.remove(); } catch {} _alignCameraMarker = null; }
}

function _setCameraMarker(lat, lon) {
  if (_alignCameraMarker) { _alignCameraMarker.setLngLat([lon, lat]); return; }
  try { _alignCameraMarker = new maplibregl.Marker({ color: '#4dff9a' }).setLngLat([lon, lat]).addTo(map); } catch {}
}

function _doneAlignWizard() {
  if (!_alignCamera) { showToast('Tap the map to set your camera location first'); return; }
  const s = store.get();
  const moonMode = s.mode === 'moon';
  const caster = { lat: s.observer.lat, lon: s.observer.lon, height: getShadowHeight() };
  const camera = { lat: _alignCamera.lat, lon: _alignCamera.lon, height: getFloorHeight() };
  if (dom.alignDone) dom.alignDone.textContent = 'Searching…';
  setTimeout(() => {
    // sun behind the caster as seen from the camera → positions reckoned at the camera.
    const result = findAlignmentBetweenPoints(camera, caster, s.datetime, moonMode);
    if (dom.alignDone) dom.alignDone.textContent = 'Done';
    if (!result) { showToast('No shot found in the next year for this setup'); return; }
    _closeAlignWizard();
    store.set({ datetime: result.datetime });
    // Frame it "behind the sun" looking down the arc at the caster — the clearest
    // read of a lined-up shot.
    const sp = moonMode ? getMoonPos(result.datetime, caster.lat, caster.lon)
                        : getPosition(result.datetime, caster.lat, caster.lon);
    try {
      map.easeTo({
        center: [caster.lon, caster.lat],
        bearing: (sp.azimuthDeg + 180) % 360,
        pitch: Math.max(25, Math.min(85, 90 - sp.altitudeDeg)),
        zoom: Math.max(map.getZoom(), 16.5),
        duration: 800,
      });
    } catch {}
    // Lock by default so the lined-up shot can't be nudged accidentally.
    store.set({ locked: true }); syncLock(); saveUI();
    showToast(`Lined up: ${formatDate(result.datetime)} ${formatTime(result.datetime)} — locked`);
  }, 0);
}

// ── Shot data dialog (DATA button) ───────────────────────────────────────────
// A big read-only readout of the current shot's numbers, with copy-to-clipboard.
// (Replaces the old floating coord labels drawn beside the map dots.)

// 16-point compass label for an azimuth in degrees.
function _dirLabel(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

// Build the lines of text shown in the data dialog (and copied to the clipboard).
function _buildDataText(s) {
  if (!s || !s.observer) return '';
  const { lat, lon } = s.observer;
  const dt = s.datetime;
  const moonMode = s.mode === 'moon';

  const casterH = getShadowHeight();
  const camPt   = getFloorDotLngLat() || getShadowEndLngLat();
  const camHeight    = getFloorHeight();

  const az = (d) => (d == null) ? '—' : `${d.toFixed(1)}° ${_dirLabel(d)}`;
  const ll = (p) => p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : '—';

  let bodyLines;
  if (moonMode) {
    const moonNow = getMoonPos(dt, lat, lon);
    const { rise, set } = getMoonTimes(dt, lat, lon);
    const riseAz = rise ? getMoonPos(rise, lat, lon).azimuthDeg : null;
    const setAz  = set  ? getMoonPos(set,  lat, lon).azimuthDeg : null;
    const mi = getMoonIllumination(dt);
    bodyLines = [
      `Moonrise angle:     ${az(riseAz)}`,
      `Moonset angle:      ${az(setAz)}`,
      `Moon angle:         ${az(moonNow.azimuthDeg)}`,
      `Moon vertical angle:${moonNow.altitudeDeg.toFixed(1)}°`,
      `Moon phase:         ${mi.waxing ? 'Waxing' : 'Waning'}, ${Math.round(mi.fraction * 100)}% lit`,
    ];
  } else {
    const { sunrise, sunset } = getDayBoundaries(dt, lat, lon);
    const sunNow = getPosition(dt, lat, lon);
    const riseAz = sunrise ? getPosition(sunrise, lat, lon).azimuthDeg : null;
    const setAz  = sunset  ? getPosition(sunset,  lat, lon).azimuthDeg : null;
    bodyLines = [
      `Sunrise angle:      ${az(riseAz)}`,
      `Sunset angle:       ${az(setAz)}`,
      `Sun angle:          ${az(sunNow.azimuthDeg)}`,
      `Sun vertical angle: ${sunNow.altitudeDeg.toFixed(1)}°`,
    ];
  }

  const lines = [
    `Time & date:        ${formatTime(dt)}  ${formatDate(dt)}`,
    ...bodyLines,
    `Ground zero:        ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    `Caster elevation:   ${Math.round(casterH)} m`,
    `Camera location:    ${ll(camPt)}`,
    `Camera elevation:   ${Math.round(camHeight)} m`,
  ];
  return lines.join('\n');
}

function _openDataModal() {
  if (!dom.dataModal) return;
  if (dom.dataText) dom.dataText.textContent = _buildDataText(store.get());
  dom.dataModal.hidden = false;
  if (dom.dataBtn) { dom.dataBtn.classList.add('active'); dom.dataBtn.setAttribute('aria-pressed', 'true'); }
}
function _closeDataModal() {
  if (dom.dataModal) dom.dataModal.hidden = true;
  if (dom.dataBtn) { dom.dataBtn.classList.remove('active'); dom.dataBtn.setAttribute('aria-pressed', 'false'); }
}

// Enforce the x-ray layer order (bottom → top). moveLayer(id) lifts a layer to
// the top, so iterating this list bottom-to-top leaves them in exactly this order.
// Ground-plane graphics are split: a SOLID copy beneath the buildings (occluded
// on open ground) and a faint GHOST copy on top (still readable through buildings).
const LAYER_ORDER = [
  // ground-plane — solid, occluded by buildings
  'sunrise-vec-mega', 'sunset-vec-mega', 'sun-ray-mega',
  'sunrise-vec-glow', 'sunset-vec-glow', 'sun-ray-glow',
  'sunrise-vec-line', 'sunset-vec-line', 'sun-ray-line', 'sun-ray-pulse',
  'shadow-arc-mega', 'shadow-arc-glow', 'shadow-arc-core', 'shadow-arc-pulse',
  'observer-ring',
  // opaque buildings (write depth)
  'building-3d',
  // 3D overlays — truly depth-occluded by the buildings
  'arc-gl',
  // ground-plane — faint ghosts, on top (the x-ray pass)
  'sunrise-vec-line-ghost', 'sunset-vec-line-ghost', 'sun-ray-line-ghost',
  'shadow-arc-core-ghost',
  // Liquid glass LAST: it samples the framebuffer everything above just drew, so
  // the dock refracts the finished scene (map + buildings + arc + shadows).
  'glass',
];
function restackLayers(map) {
  // Add the glass pane once the style is up. Done here (not at boot) because a
  // style reload — light/dark theme — drops custom layers, and restack runs then.
  if (map && map.getStyle && !map.getLayer(GLASS_LAYER_ID)) {
    try { map.addLayer(glassLayer); } catch (e) { console.warn('glass', e); }
    // MapLibre only repaints on demand, and the glass panes are measured from the
    // DOM during render — so a modal or toast appearing without any map movement
    // would show no glass until you happened to touch the map. Nudge a repaint
    // whenever the UI actually changes shape.
    try {
      // Nudge a repaint when the UI changes SHAPE, so a modal or toast gets glass
      // without waiting for a map gesture.
      //
      // Watching 'style' here was a mistake: the app rewrites inline styles every
      // frame (scrubber fill, slider thumbs, readouts), so every frame triggered a
      // repaint, which triggered more style writes — a feedback loop that kept the
      // renderer permanently busy and made the whole app feel choppy
      // (Blair, 2026-07-29). Watch only the attributes that mean a surface
      // appeared or disappeared, and coalesce to at most one repaint per frame.
      let queued = false;
      const glassRepaint = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; syncTints(); try { map.triggerRepaint(); } catch {} });
      };
      new MutationObserver(glassRepaint).observe(document.body, {
        subtree: true, childList: true,
        attributes: true, attributeFilter: ['hidden', 'class', 'aria-pressed'],
      });
      window.addEventListener('resize', glassRepaint);
    } catch {}
    // ?glassdebug — health as TEXT on the real device. A black screenshot proves
    // nothing (headless won't rasterise vector tiles), so this is how we actually
    // know whether the glass is running. See (internal path)
    if (/(^|[#?&])glassdebug\b/.test(location.search + location.hash) && !document.getElementById('glass-dbg')) {
      const box = document.createElement('pre');
      box.id = 'glass-dbg';
      box.style.cssText = 'position:fixed;top:8px;left:8px;right:8px;z-index:9999;margin:0;' +
        'padding:10px;border-radius:10px;background:rgba(0,0,0,.85);color:#cfe;' +
        'font:11px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;pointer-events:none';
      document.body.appendChild(box);
      setInterval(() => {
        box.textContent = JSON.stringify({
          version: APP_VERSION, ok: glassLayer.ok, panes: glassLayer.panes,
          error: glassLayer.lastError || '',
          marked: document.querySelectorAll('[data-glass]').length,
        }, null, 2);
      }, 500);
    }
  }
  for (const id of LAYER_ORDER) {
    if (map.getLayer(id)) { try { map.moveLayer(id); } catch {} }
  }
}

// Light mode now recolours the basemap to a real light palette (see map.js
// applyLightTheme) instead of inverting the canvas, so buildings get a direct light
// grey rather than an invert target. Dark mode keeps the original warm-near-black.
// Re-applied on every style (re)load since the building layer is rebuilt then.
const BUILDING_COLOR_DARK  = '#201f1d';
const BUILDING_COLOR_LIGHT = '#c9c9c9';   // direct light grey on the light basemap
function applyBuildingTheme() {
  if (!map || !map.getLayer || !map.getLayer('building-3d')) return;
  const light = document.body.classList.contains('invert');
  try {
    map.setPaintProperty('building-3d', 'fill-extrusion-color',
      light ? BUILDING_COLOR_LIGHT : BUILDING_COLOR_DARK);
  } catch {}
}

// Fraction of screen height (from the top) treated as the "horizon zone" for
// the tap and drag guards below: at this pitch, pixels there unproject to
// world points so far away that a tiny pointer move pans/flings the map by
// kilometres. Below SAFE_PITCH the whole screen is safe (camera looking
// mostly down). From SAFE_PITCH up to the map's maxPitch (camera nearly
// level with the ground), the zone grows linearly to MAX_UNSAFE_FRAC — a
// fixed cutoff under-guards exactly at the high pitches ("low to the
// ground") where the horizon line is furthest down the screen.
// SAFE_PITCH lowered 35 -> 18 and a floor added: the guard used to switch OFF
// entirely below 35 degrees, and runaway was still reachable there (Blair,
// 2026-07-31). A small permanent band at the top of the screen costs nothing -
// that region is sky or far horizon at every pitch - and closes the hole.
const SAFE_PITCH = 18;
const MIN_UNSAFE_FRAC = 0.10;
const MAX_UNSAFE_FRAC = 0.45;
function _unsafeZoneFrac(mapInstance) {
  const pitch = mapInstance.getPitch();
  const maxP = (mapInstance.getMaxPitch && mapInstance.getMaxPitch()) || 85;
  if (pitch <= SAFE_PITCH) return MIN_UNSAFE_FRAC;
  const t = Math.min(1, (pitch - SAFE_PITCH) / (maxP - SAFE_PITCH));
  return MIN_UNSAFE_FRAC + t * (MAX_UNSAFE_FRAC - MIN_UNSAFE_FRAC);
}

const APP_VERSION = "v122";

// Tapping a number box selects the number (Blair, 2026-10-10: a rule for every app). Typing
// then replaces it; a second tap puts the cursor where he wants it.
document.addEventListener('focusin', (e) => {
  const t = e.target;
  if (t && t.matches && t.matches('input[type="number"], input[inputmode="numeric"], input[inputmode="decimal"]')) setTimeout(() => { try { t.select(); } catch {} }, 0);
});

// Reached from the blairz.ca home page inside its home-screen icon there is no browser bar,
// so no way back (Blair, 2026-10-10). Only then does the app show a back button.
(() => {
  const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  let fromSite = false;
  try { const r = new URL(document.referrer); fromSite = r.origin === location.origin && !r.pathname.startsWith(new URL('.', location.href).pathname); } catch {}
  if (!(standalone && fromSite) && !/[?&]standalone=1\b/.test(location.search)) return;
  const a = document.createElement('a');
  a.id = 'site-back'; a.href = '/'; a.setAttribute('aria-label', 'Back to blairz.ca');
  a.innerHTML = '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5"/></svg>';
  document.body.appendChild(a);
  // It takes the corner the sun/moon button lives in, so that button moves down one place
  // (css/style.css). v120 put this on top of it and the toggle could not be reached.
  document.body.classList.add('has-site-back');
})();

async function main() {
  // Stamp the loaded build version bottom-left (so a stale Safari cache is obvious).
  try { const vt = document.getElementById('version-tag'); if (vt) vt.textContent = APP_VERSION.toUpperCase(); } catch {}
  // Init error monitor first so it captures everything that follows.
  initMonitor(() => store.get());
  // ?perf=1 — a small live meter, top-left. The row that matters is "map draw":
  // anything above a few per second on a still map means something is holding
  // MapLibre awake. See js/perf.js for the switches and what they cost.
  initPerfMeter();
  for (const ev of ['pointerdown', 'touchstart', 'keydown', 'input']) {
    document.addEventListener(ev, noteInteraction, { passive: true, capture: true });
  }

  // A reload is the low-friction way to get the intro back: strip the live-synced session
  // hash so it can't override, then drop straight onto the default scene — ignoring both
  // the hash and any saved session. (Fresh navigations + PWA cold launches still restore.)
  const reload = isReloadNavigation();
  if (reload) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch {}
  }

  attachHashSync();
  if (reload) {
    applyDefaultScene();
  } else if (hashHasObserver()) {
    // Shared link: keep its explicit observer, open at the current time.
    store.set({ datetime: new Date() });
  } else {
    const sess = loadSession();
    if (sess && sess.observer && Number.isFinite(sess.observer.lat) && Number.isFinite(sess.observer.lon)) {
      // Restore the last session's framing.
      _restoredSession = sess;
      const upd = { observer: sess.observer };
      if (sess.mode === 'sun' || sess.mode === 'moon') upd.mode = sess.mode;
      // Time: only restore if still in the future; otherwise open at now.
      const savedDt = sess.datetime ? new Date(sess.datetime) : null;
      const future = savedDt && !isNaN(savedDt) && savedDt.getTime() > Date.now();
      upd.datetime = future ? savedDt : new Date();
      if (upd.mode === 'moon') upd.moonDatetime = upd.datetime; else upd.sunDatetime = upd.datetime;
      store.set(upd);
    } else {
      // No saved session and no shared link → first-run default scene: the CN Tower
      // as both viewpoint and caster, at a time the sun makes look good. No geolocation
      // (Blair always plans shots elsewhere; the locate button covers the rare case).
      applyDefaultScene();
    }
  }

  const init = store.get();
  map = initMap(dom.map, init.observer);

  // Diagnostics: surface why the map might fail to load / freeze on device.
  captureError(new Error('map init'), { phase: 'mapInit', w: dom.map.clientWidth, h: dom.map.clientHeight });
  map.on('error', (e) => {
    const err = (e && e.error) ? e.error : new Error('map error: ' + (e && e.type));
    captureError(err, { phase: 'mapError' });
  });
  const canvasEl = map.getCanvas();
  // WebGL context loss = blank/frozen map (often GPU pressure). Log + recover.
  canvasEl.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    captureError(new Error('webglcontextlost'), { phase: 'webgl' });
    showReloadToast('Map graphics lost — tap to reload.');
  }, false);
  canvasEl.addEventListener('webglcontextrestored', () => {
    captureError(new Error('webglcontextrestored'), { phase: 'webgl' });
    try { map.resize(); map.triggerRepaint(); } catch {}
  }, false);

  // Latch "the map produced a frame" on the FIRST 'load' or 'idle'. Registered
  // BEFORE the style-ready await below so an early event can't be missed: a
  // once-listener attached after the await would silently drop an event that
  // already fired, leaving the flag stuck false (a root cause of the bogus
  // "map didn't load" toast). Sticky — never resets — so the 9 s watchdog can
  // trust it even while a source (e.g. the terrain DEM) is mid-fetch.
  // 'idle' is the belt-and-suspenders: it fires when the boot camera ease-up
  // settles even on the rare load where 'load' itself is delayed by the sources.
  let _mapLoaded = false;
  const _markMapLoaded = () => { if (_mapLoaded) return; _mapLoaded = true; try { map.resize(); } catch {} };
  if (map.loaded && map.loaded()) _markMapLoaded();
  map.once('load', _markMapLoaded);
  map.once('idle', _markMapLoaded);

  const styleOK = await whenStyleReady(map);
  if (!styleOK) captureError(new Error('style not ready after wait'), { phase: 'styleTimeout' });

  // iOS standalone can mis-size the canvas at first paint — force a resize once
  // layout settles so the map fills the viewport rather than rendering blank.
  setTimeout(() => { try { map.resize(); } catch {} }, 400);

  // Watchdog: warn ONLY on a genuinely blank map — no frame ever rendered AND the
  // style never loaded. It trusts the sticky _mapLoaded latch + the latched styleOK
  // from boot, NOT a fresh isStyleLoaded()/loaded(): both of those read false
  // whenever a source (e.g. the terrain DEM) is mid-fetch, which is what made
  // this toast fire on a perfectly good map.
  setTimeout(() => {
    const styleEverLoaded = styleOK || !!(map.isStyleLoaded && map.isStyleLoaded());
    if (!_mapLoaded && !styleEverLoaded) {
      captureError(new Error('map not loaded after 9s'), { phase: 'mapWatchdog', styleOK });
      showReloadToast("Map didn’t load (network?). Tap to retry.");
    }
  }, 9000);

  // Center on the observer at startup; restore last zoom if we have one.
  const jump = { center: [init.observer.lon, init.observer.lat] };
  if (_restoredSession && Number.isFinite(_restoredSession.zoom)) jump.zoom = _restoredSession.zoom;
  try { map.jumpTo(jump); } catch {}

  // Try each layer add separately so a bad layer doesn't kill all overlays.
  const safe = (label, fn) => {
    try { fn(); } catch (e) { console.error(label, e); showToast(label + ': ' + e.message); }
  };
  safe('observer', () => addObserverLayer(map, init.observer.lat, init.observer.lon));
  safe('sun-path', () => addSunPathLayer(map));
  safe('target', () => addTargetLayer(map));
  safe('shadow', () => addShadowLayer(map));
  safe('restack', () => restackLayers(map));
  // building-3d is added asynchronously by the style-load hook; restack once more
  // after the first full render so it lands in the right place in the stack.
  map.once('idle', () => {
    try { restackLayers(map); } catch {}
  });

  // style.load fires on every full style (re)load — e.g. after WebGL context
  // restore or a network-driven style refetch. Re-add all custom GL sources and
  // layers (each add-function is idempotent: skips if source already present).
  // Then force a full redraw so layer data is repopulated.
  map.on('style.load', () => {
    const s = store.get();
    safe('observer', () => addObserverLayer(map, s.observer.lat, s.observer.lon));
    safe('sun-path', () => addSunPathLayer(map));
    safe('target', () => addTargetLayer(map));
    safe('shadow', () => addShadowLayer(map));
    safe('restack', () => restackLayers(map));
    safe('building-theme', () => applyBuildingTheme());   // re-apply light/dark building grey
    try {
      redraw(s, ['observer', 'datetime', 'mode', 'view', 'target', 'shadowEnabled']);
    } catch (e) { captureError(e, { phase: 'style-reload-redraw' }); }
  });

  // Pause compass updates while finger is down so drag-pan gestures aren't interrupted
  map.getCanvas().addEventListener('touchstart',  () => { _touching = true;  }, { passive: true });
  map.getCanvas().addEventListener('touchend',    () => { _touching = false; }, { passive: true });
  map.getCanvas().addEventListener('touchcancel', () => { _touching = false; }, { passive: true });

  const due = checkAndNotify();
  if (due.length && Notification.permission !== 'granted') {
    showToast(`Reminder: ${due[0].mode} shot at ${formatTime(new Date(due[0].datetime))}`);
  }

  let suppressClick = false;
  map.on('click', (e) => {
    if (suppressClick) { suppressClick = false; return; }
    if (e.originalEvent && e.originalEvent.target && e.originalEvent.target.closest('#dock,#search-results,#cam-hud,#data-panel,#data-modal,#align-panel,#saves-panel,#save-modal')) return;

    if (store.get().locked) return;

    // Alignment wizard intercepts taps for point A/B selection.
    if (_alignStep === 'caster') {
      store.set({ observer: { lat: e.lngLat.lat, lon: e.lngLat.lng } });
      return;
    }
    if (_alignStep === 'camera') {
      _alignCamera = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      _setCameraMarker(_alignCamera.lat, _alignCamera.lon);
      if (dom.alignDone) dom.alignDone.disabled = false;
      return;
    }

    // Horizon-tap guard: at high tilt, the upper portion of the screen maps
    // to points kilometres away. Ignore taps there to avoid flinging the
    // observer across the world. Threshold scales with pitch — see _unsafeZoneFrac.
    const screenY = e.point && e.point.y;
    const screenH = map.getCanvas().clientHeight || window.innerHeight;
    if (screenY != null && screenY < screenH * _unsafeZoneFrac(map)) return;

    store.set({ observer: { lat: e.lngLat.lat, lon: e.lngLat.lng } });
  });

  // Long-press alignment finder removed — the gold card was confusing.

  initScrubber({
    scrubber: dom.scrubber, ticks: dom.scrubberTicks,
    hh: dom.hh, dateBtn: dom.dateBtn, dateLabel: dom.dateLabel, dateInput: dom.dateInput,
  });
  initSearch({ input: dom.search, results: dom.searchResults }, map);

  // Saves: must initialise after map is ready; sliders wired up later but
  // the listener dispatch in _applySnap runs at user time (after full init).
  safe('saves', () => initSaves(map, {
    dom,
    setShadowHeight,
    setFloorHeight,
    sliderToHeight,
    syncLock,
    showToast,
  }));

  // Body toggle: sun ↔ moon. Each mode keeps its own datetime memory.
  dom.bodyToggle.addEventListener('click', () => {
    const s = store.get();
    const next = s.mode === 'sun' ? 'moon' : 'sun';
    // Stash the current datetime under the mode you're leaving
    const update = {
      mode: next,
      [s.mode === 'sun' ? 'sunDatetime' : 'moonDatetime']: s.datetime,
    };
    if (next === 'moon') {
      // Restore last moon time, or compute a sensible anchor at the active arc
      if (s.moonDatetime) {
        update.datetime = s.moonDatetime;
      } else {
        const now = new Date();
        const today = getMoonTimes(now, s.observer.lat, s.observer.lon);
        let anchor;
        if (today.rise && today.set && today.rise < today.set && now >= today.rise && now <= today.set) {
          anchor = today.rise;
        } else if (today.rise && now < today.rise) {
          anchor = new Date(today.rise.getTime() - 5 * 60 * 1000);
        } else {
          const tomorrow = getMoonTimes(new Date(now.getTime() + 24*3600*1000), s.observer.lat, s.observer.lon);
          anchor = tomorrow.rise ? new Date(tomorrow.rise.getTime() - 5*60*1000) : now;
        }
        update.datetime = anchor;
      }
    } else {
      // Restore last sun time, or fall back to now
      update.datetime = s.sunDatetime || new Date();
    }
    store.set(update);
  });

  dom.locateBtn.addEventListener('click', tryGeolocate);

  dom.compassToggle.addEventListener('click', async () => {
    if (store.get().compassEnabled) {
      disableCompass();
      dom.compassToggle.classList.remove('active');
      dom.compassToggle.setAttribute('aria-pressed', 'false');
      // Re-enable user gesture handlers
      try { map.dragRotate.enable(); } catch {}
      try { map.touchPitch && map.touchPitch.enable(); } catch {}
      try { map.touchZoomRotate.enableRotation(); } catch {}
      map.easeTo({ bearing: 0, duration: 400 });
    } else {
      const ok = await enableCompass();
      if (ok) {
        dom.compassToggle.classList.add('active');
        dom.compassToggle.setAttribute('aria-pressed', 'true');
        // Sensor drives bearing+pitch; disable manual rotation/pitch gestures so
        // two-finger pinch is interpreted purely as zoom (not rotate-or-pitch).
        // dragPan stays enabled so the user can reposition the map freely.
        try { map.dragPan.enable(); } catch {}
        try { map.dragRotate.disable(); } catch {}
        try { map.touchPitch && map.touchPitch.disable(); } catch {}
        try { map.touchZoomRotate.disableRotation(); } catch {}
        // Center on observer so the bearing snap doesn't disorient.
        const s = store.get();
        map.easeTo({ center: [s.observer.lon, s.observer.lat], duration: 500 });
        showToast('Compass on — pan freely, pinch to zoom');
      } else {
        showToast('Compass denied');
      }
    }
  });

  // Slider → updates number input + height
  dom.shadowElev.addEventListener('input', () => {
    const h = sliderToHeight(dom.shadowElev.value);
    setShadowHeight(h);
    if (dom.shadowElevVal) dom.shadowElevVal.value = String(h);
    const s = store.get();
    if (s.shadowEnabled) updateShadow(map, s.observer, s.datetime, s.mode === 'moon');
    saveUI();
  });
  // Number input → updates slider + height (fires on blur / Enter)
  if (dom.shadowElevVal) {
    dom.shadowElevVal.addEventListener('change', () => {
      const h = Math.max(0, Math.min(1000, Math.round(+dom.shadowElevVal.value) || 0));
      dom.shadowElevVal.value = String(h);
      dom.shadowElev.value = String(heightToSlider(h));
      setShadowHeight(h);
      const s = store.get();
      if (s.shadowEnabled) updateShadow(map, s.observer, s.datetime, s.mode === 'moon');
      saveUI();
    });
  }
  // Initialise from default slider value
  setShadowHeight(sliderToHeight(dom.shadowElev.value));
  if (dom.shadowElevVal) dom.shadowElevVal.value = String(sliderToHeight(dom.shadowElev.value));

  if (dom.floorElev) {
    dom.floorElev.addEventListener('input', () => {
      const h = sliderToHeight(dom.floorElev.value);
      setFloorHeight(h);
      if (dom.floorElevVal) dom.floorElevVal.value = String(h);
      const s = store.get();
      if (s.shadowEnabled) updateShadow(map, s.observer, s.datetime, s.mode === 'moon');
      saveUI();
    });
    if (dom.floorElevVal) {
      dom.floorElevVal.addEventListener('change', () => {
        const h = Math.max(0, Math.min(1000, Math.round(+dom.floorElevVal.value) || 0));
        dom.floorElevVal.value = String(h);
        dom.floorElev.value = String(heightToSlider(h));
        setFloorHeight(h);
        const s = store.get();
        if (s.shadowEnabled) updateShadow(map, s.observer, s.datetime, s.mode === 'moon');
        saveUI();
      });
    }
    setFloorHeight(sliderToHeight(dom.floorElev.value));
    if (dom.floorElevVal) dom.floorElevVal.value = String(sliderToHeight(dom.floorElev.value));
  }

  // Vertical sliders (right edge)
  if (dom.tiltSlider) {
    dom.tiltSlider.addEventListener('input', () => {
      stopDrift();
      _applyTiltSlider();
      saveUI();
    });
  }
  if (dom.radiusSlider) {
    const applyRadius = () => {
      const km = sliderToRadiusKm(dom.radiusSlider.value);
      setArcRadiusKm(km);
      // Force a day-level recompute so markers reposition.
      const s = store.get();
      const t = updateSunPathDay(map, s.observer, s.datetime, s.mode === 'moon');
      updateSunNow(map, s.observer, s.datetime, s.mode === 'moon' ? getMoonPos(s.datetime, s.observer.lat, s.observer.lon) : null);
      // Rebuild the shadow so the body→caster→shadow line follows the resized arc
      // (the live body anchor moves with the radius).
      if (s.shadowEnabled) updateShadow(map, s.observer, s.datetime, s.mode === 'moon');
      renderScrubberTicks(dom.scrubberTicks, t.rise, t.set, s.datetime);
      try {
        paintScrubberDayRamp(dom, s.mode === 'moon' ? 'moon' : 'sun',
          getDayBoundaries(s.datetime, s.observer.lat, s.observer.lon), s.datetime);
      } catch (e) { captureError(e, { phase: 'scrubberRamp' }); }
    };
    // Restore persisted slider values before first applyRadius() so they take effect immediately.
    restoreUI(map);
    // First-run default: stand the caster at the CN Tower's height. Runs AFTER restoreUI
    // so a returning user's saved caster always wins (the flag is only set when there was
    // no session to restore).
    if (_applyDefaultCaster && dom.shadowElev) {
      dom.shadowElev.value = String(heightToSlider(DEFAULT_CASTER_M));
      setShadowHeight(DEFAULT_CASTER_M);
      if (dom.shadowElevVal) dom.shadowElevVal.value = String(DEFAULT_CASTER_M);
    }
    dom.radiusSlider.addEventListener('input', () => { applyRadius(); saveUI(); });
    applyRadius();
  }
  // Sync tilt slider when user drags the map (skip during drift or underground view)
  map.on('pitch', () => {
    if (_driftRafId) return;
    if (dom.tiltSlider) dom.tiltSlider.value = String(Math.round(map.getPitch()));
  });

  // Idle drift — stop on any map interaction
  const _onInteract = () => stopDrift();
  map.getCanvas().addEventListener('mousedown', _onInteract, { passive: true });
  map.getCanvas().addEventListener('touchstart', _onInteract, { passive: true });
  map.getCanvas().addEventListener('wheel', _onInteract, { passive: true });
  // Poll for idle; start drift after DRIFT_IDLE_MS of no interaction
  setInterval(() => {
    if (document.hidden) return;
    if (!_driftRafId && Date.now() - _lastInteract > DRIFT_IDLE_MS) _startDrift();
  }, 1000);

  // Pause drift the moment the app is backgrounded (saves battery; the rAF loop
  // would otherwise keep re-rendering the map until the OS suspends the tab).
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopDrift(); });

  // Top-of-screen pan guard: block single-touch (and mouse) map drag inside the
  // horizon zone. At a fixed screen fraction this under-guards as pitch climbs
  // toward maxPitch (camera nearly level with the ground) — the horizon line
  // itself drops further down the screen, so a flat 28%/35% cutoff leaves a
  // band of "safe-looking" screen that still unprojects to points kilometres
  // away. _unsafeZoneFrac grows the cutoff with pitch instead of using a
  // constant. Multi-touch (pinch-to-zoom) and taps pass through unaffected.
  const _inHorizonZone = (clientY) => {
    const screenH = map.getCanvas().clientHeight || window.innerHeight;
    return clientY < screenH * _unsafeZoneFrac(map);
  };
  map.getCanvas().addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && _inHorizonZone(e.touches[0].clientY)) {
      e.stopImmediatePropagation();
    }
  }, { capture: true, passive: true });
  // Mirror the guard for mouse drag-pan (desktop). MapLibre's dragPan handler
  // tracks an active drag via mousemove regardless of which element it's
  // bound on; capture:true on window runs before any bubble-phase listener
  // anywhere in the document, so this reliably intercepts it first.
  window.addEventListener('mousemove', (e) => {
    if (e.buttons === 1 && _inHorizonZone(e.clientY)) {
      e.stopImmediatePropagation();
    }
  }, { capture: true });

  // Lock button: toggles the observer/height lock so an accidental tap can't move
  // your setup.
  if (dom.lockBtn) {
    dom.lockBtn.addEventListener('click', () => {
      store.set({ locked: !store.get().locked });
      syncLock();
      saveUI();
    });
  }

  // DATA button: open a big read-only dialog of the shot's numbers + copy button.
  if (dom.dataBtn) dom.dataBtn.addEventListener('click', () => {
    if (dom.dataModal && !dom.dataModal.hidden) { _closeDataModal(); } else { _openDataModal(); }
  });
  if (dom.dataClose) dom.dataClose.addEventListener('click', _closeDataModal);
  if (dom.dataCopy) dom.dataCopy.addEventListener('click', async () => {
    const txt = dom.dataText ? dom.dataText.textContent : '';
    try {
      await navigator.clipboard.writeText(txt);
      showToast('Copied to clipboard');
    } catch {
      // Clipboard API blocked (insecure context / permission) → execCommand fallback.
      try {
        const ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand('copy'); ta.remove();
        showToast('Copied to clipboard');
      } catch { showToast('Copy failed'); }
    }
  });

  // Alignment wizard: crosshair button on control row
  if (dom.alignWizardBtn) {
    dom.alignWizardBtn.addEventListener('click', () => {
      if (!dom.alignPanel || !dom.alignPanel.hidden) {
        _closeAlignWizard();
      } else {
        _openAlignWizard();
      }
    });
  }
  if (dom.alignClose) {
    dom.alignClose.addEventListener('click', _closeAlignWizard);
  }
  if (dom.alignNext) {
    dom.alignNext.addEventListener('click', () => {
      // Accept the caster and move on to picking the camera location.
      _alignStep = 'camera';
      if (dom.alignStepA) dom.alignStepA.hidden = true;
      if (dom.alignStepB) dom.alignStepB.hidden = false;
      showToast("Tap where you'll shoot from");
    });
  }
  if (dom.alignDone) {
    dom.alignDone.addEventListener('click', _doneAlignWizard);
  }

  // Transparent time input overlaid on #time-hh — native picker on direct tap.
  // On desktop a transparent <input type=time> only focuses on click (no popup),
  // so open the picker explicitly when supported (the "unreliable on PC" fix).
  const timeExactInput = $('time-exact-input');
  if (timeExactInput) {
    timeExactInput.addEventListener('click', () => {
      if (typeof timeExactInput.showPicker === 'function') {
        try { timeExactInput.showPicker(); } catch {}
      }
    });
    timeExactInput.addEventListener('change', () => {
      const [hh, mm] = (timeExactInput.value || '').split(':').map(Number);
      if (!Number.isFinite(hh)) return;
      const s = store.get();
      const d = new Date(s.datetime);
      d.setHours(hh, mm || 0, 0, 0);
      store.set({ datetime: d });
    });
  }

  // Combine heading + pitch into one jumpTo so sensor updates fire ONE move
  // event per frame instead of two separate setBearing/setPitch calls.
  store.subscribeAll((s, changed) => {
    if (!changed.some(k => k === 'compassHeading' || k === 'compassPitch')) return;
    if (s.compassHeading == null || _touching) return;
    const maxPitch = map.getMaxPitch ? map.getMaxPitch() : 85;
    const jump = { bearing: s.compassHeading };
    if (s.compassPitch != null) {
      jump.pitch = Math.max(0, Math.min(maxPitch, s.compassPitch));
      if (dom.tiltSlider) dom.tiltSlider.value = String(Math.round(jump.pitch));
    }
    try { map.jumpTo(jump); } catch {}
  });

  store.subscribeAll(throttleRaf((s, changed) => {
    try { redraw(s, changed); } catch (e) {
      console.error('redraw failed', e);
      captureError(e, { phase: 'redraw', changed });
      showToast('Error: ' + e.message);
    }
  }));

  // Persist the session so a reopen lands where you left off (debounced so
  // scrubbing doesn't thrash localStorage). moveend covers zoom/pan framing.
  store.subscribeAll(() => saveSessionDebounced());
  map.on('moveend', saveSessionDebounced);

  // First draw
  try {
    redraw(store.get(), ['observer', 'datetime', 'mode', 'view', 'target', 'shadowEnabled']);
  } catch (e) {
    console.error('Initial redraw failed:', e);
    captureError(e, { phase: 'init-redraw' });
    showToast('Init error: ' + e.message);
  }

  // Intro: hold the graphics-only emblem on black, then reveal the UI.
  startIntro();

}

// Layers that make up the opening "emblem" — shown alone on black in the first beat.
// Everything else (the basemap AND the live ray) fades in afterward with the chrome.
// (The live sun ray is deliberately NOT here — Blair wants it to arrive with the UI.)
const _isEmblemLayer = (id) =>
  id === 'background' || /^(sunrise-|sunset-|shadow-arc|observer|arc-gl)/.test(id);

// Opacity paint property(ies) for a layer type, used to fade the basemap (+ live ray)
// in by OPACITY — which keeps labels placed (no corner-by-corner re-raster) and lets
// the emblem graphics stay visible the whole time (no blink).
function _opacityProps(type) {
  switch (type) {
    case 'background':     return ['background-opacity'];
    case 'fill':           return ['fill-opacity'];
    case 'line':           return ['line-opacity'];
    case 'symbol':         return ['icon-opacity', 'text-opacity'];
    case 'fill-extrusion': return ['fill-extrusion-opacity'];
    case 'raster':         return ['raster-opacity'];
    case 'circle':         return ['circle-opacity', 'circle-stroke-opacity'];
    default:               return [];
  }
}

let _fadeOrig = null;   // captured original opacities, restored on fade-in
function fadeNonEmblem(mapInstance, show, durationMs) {
  try {
    const layers = mapInstance.getStyle().layers || [];
    if (!show) {
      _fadeOrig = [];
      for (const l of layers) {
        if (_isEmblemLayer(l.id)) continue;
        for (const prop of _opacityProps(l.type)) {
          let orig;
          try { orig = mapInstance.getPaintProperty(l.id, prop); } catch {}
          if (orig === undefined) orig = 1;
          _fadeOrig.push({ id: l.id, prop, value: orig });
          try { mapInstance.setPaintProperty(l.id, prop + '-transition', { duration: 0 }); } catch {}
          try { mapInstance.setPaintProperty(l.id, prop, 0); } catch {}
        }
      }
    } else {
      for (const o of (_fadeOrig || [])) {
        try { mapInstance.setPaintProperty(o.id, o.prop + '-transition', { duration: durationMs || 800 }); } catch {}
        try { mapInstance.setPaintProperty(o.id, o.prop, o.value); } catch {}
      }
      _fadeOrig = null;
    }
  } catch {}
}

// Fade the 3D buildings up from transparent to fully opaque over `ms`, then hand the
// layer back to its DEFAULT opaque state. The reset at the end is the fix for the
// v88-era mobile flicker regression: an explicitly-set `fill-extrusion-opacity` — even
// =1 — keeps the extrusion in MapLibre's translucent pass, which writes the depth
// buffer differently. On a low-precision mobile/tablet depth buffer that made the flat
// ground graphics behind buildings z-fight (the move/zoom flicker). Reverting the
// property to default (undefined) once the reveal is done restores the constant-opaque
// depth-write — exactly the pre-v88 state — so occlusion is clean and nothing flickers.
// The reset is invisible: opacity is already 1 and the default is 1. building-3d is
// added late on `style.load` and so escapes fadeNonEmblem's capture, which is why it
// needs this dedicated fade (and why neutralising the property in v94D was enough to
// prove the diagnosis).
function fadeBuildingsIn(ms = 1000) {
  if (!map) return;
  const run = () => {
    if (!map.getLayer('building-3d')) return false;
    try { map.setPaintProperty('building-3d', 'fill-extrusion-opacity-transition', { duration: 0 }); } catch {}
    try { map.setPaintProperty('building-3d', 'fill-extrusion-opacity', 0); } catch {}
    requestAnimationFrame(() => {
      try { map.setPaintProperty('building-3d', 'fill-extrusion-opacity-transition', { duration: ms }); } catch {}
      try { map.setPaintProperty('building-3d', 'fill-extrusion-opacity', 1); } catch {}
      // After the reveal transition completes, drop the override → default opaque pass.
      setTimeout(() => {
        try { map.setPaintProperty('building-3d', 'fill-extrusion-opacity', undefined); } catch {}
      }, ms + 150);
    });
    return true;
  };
  // If buildings aren't in the style yet, fade them the first time the map goes idle.
  if (!run()) map.once('idle', run);
}

// Zoom that frames the sun arc (≈ diameter 2·R) to ~70% of the screen WIDTH.
function _arcFitZoom(lat) {
  let R = 0.65; try { R = getArcRadiusKm() || 0.65; } catch {}
  const vw = window.innerWidth || 400;
  const cos = Math.cos((lat || 43.66) * Math.PI / 180);
  const z = Math.log2(0.7 * vw * cos * 39.135 / Math.max(0.05, R));
  // Floor at 14 to match the map's minZoom (buildings only exist at z14+); a larger
  // arc just frames a little wider on screen rather than zooming out past the floor.
  return Math.max(14, Math.min(17, z));
}

// Boot intro — a DETERMINISTIC opening cinematic. The emblem beats run on fixed
// timers (they need no network: the arc/rays are our own GL geometry), so the
// sequence looks identical on every load regardless of connection speed. The only
// network-adaptive step is the final basemap fade-in: if tiles aren't ready yet we
// hold the emblem on black a little LONGER (up to a cap) so the basemap arrives clean
// — it can only lengthen the emblem moment, never skip or shorten it.
//
//   1) hold pure black under the veil (logo beat)
//   2) hide the basemap, lift the veil → emblem graphics fade in alone on black
//   3) hold on the emblem
//   4) fade the basemap + 3D buildings + chrome in together while the camera eases up
const BOOT = {
  holdBlack:   600,    // pure-black veil before the emblem appears
  veilFade:   1050,    // veil opacity transition (must match css #boot-veil)
  emblemHold: 1500,    // dwell on the emblem-on-black
  basemapFade:1100,    // basemap/buildings opacity fade-in
  camMove:    2400,    // camera ease down from the top-down hero to the settled framing
  camPitchDrop: 40,    // Hero opens this many degrees FLATTER (more top-down / higher
                       // vantage) than the settled pitch — so the sun arc reads as a "C"
                       // with tips UP. The ease then sweeps DOWN through edge-on (the arc
                       // momentarily a line) and settles below the arc's plane, tips DOWN.
                       // This is the RANGE of the move (start = end − camPitchDrop).
  camEndPitchShift: 15,// Settle this many degrees LOWER (toward the horizon / higher pitch)
                       // than the map's base pitch, shifting the whole sweep down together.
  zoomOut:    0.14,    // open AND settle ~10% wider (log2(1.1) ≈ 0.14 zoom levels).
  tileWaitCap:5000,    // max extra wait for tiles before revealing anyway
  preloadCap: 5000,    // max time under the black veil fetching the SETTLED view's tiles
};

function startIntro() {
  const veil = document.getElementById('boot-veil');
  const finish = () => {
    document.body.classList.remove('booting');
    try { initSliderFills(); } catch {}
    if (veil) { veil.style.opacity = '0'; veil.style.display = 'none'; }
  };
  if (!map) { finish(); return; }
  try {
    const obs = store.get().observer;
    const lat = (obs && Number.isFinite(obs.lat)) ? obs.lat : map.getCenter().lat;
    const fitZoom = _arcFitZoom(lat);
    const finalCam = {
      center: map.getCenter(),
      zoom: fitZoom + 0.4 - BOOT.zoomOut,   // a touch closer than the 80% framing, ~10% wider
      pitch: Math.min(85, map.getPitch() + BOOT.camEndPitchShift),  // settle 15° lower (horizon-ward)
      bearing: map.getBearing(),
    };
    // The hero opens ~10% wider than the building floor (z14); allow it briefly, then
    // restore the floor once the move settles (the settled zoom stays ≥14). See doReveal.
    try { map.setMinZoom(13); } catch {}
    // Hero: arc at ~80% width, viewed from well above its plane (top-down) so it opens as
    // a "C" with tips up; the reveal then eases the camera down past edge-on to the settled
    // framing (tips down) while the buildings fade in.
    const hero = {
      center: finalCam.center,
      // Never below 14 (v120). The basemap's tiles carry buildings only from zoom 14, and
      // below it the map draws zoom-13 tiles, which have none. The hero used to open at
      // about 13.86, so the buildings appeared the instant the ease crossed 14, about a
      // second into the reveal (Blair, 2026-10-10: "buildings pop in about a second after
      // the map shows"). Preloading tiles could not fix that; they were the wrong tiles.
      zoom: Math.max(14, fitZoom - BOOT.zoomOut),
      pitch: Math.max(0, finalCam.pitch - BOOT.camPitchDrop),
      bearing: finalCam.bearing,
    };
    // Load, then show (Blair, 2026-10-10: "sun app shows the map before buildings load").
    // The reveal ends on a lower, closer view than the hero, which needs tiles the hero
    // never asked for, so buildings used to pop in while the camera eased down. Under the
    // black veil the map now visits the SETTLED view first and waits for its tiles (the
    // buildings ride in the same tiles), then returns to the hero. Both views are then in
    // the tile cache before anything is shown. It can only lengthen the black beat.
    const tilesIn = (cap) => new Promise((res) => {
      const t0 = Date.now();
      const check = () => ((map.areTilesLoaded() || Date.now() - t0 >= cap) ? res() : setTimeout(check, 80));
      // Two drawn frames first: the map only asks for a view's tiles when it draws that
      // view, and a busy phone may not draw for a while after the jump.
      let frames = 0;
      const onRender = () => { if (++frames >= 2) { map.off('render', onRender); check(); } };
      map.on('render', onRender);
      map.triggerRepaint();
      setTimeout(() => { map.off('render', onRender); res(); }, cap);
    });
    map.jumpTo(finalCam);
    tilesIn(BOOT.preloadCap).then(() => {
      map.jumpTo(hero);
      // Tile readiness for the hero view gates ONLY the basemap fade-in (step 4), never
      // the emblem beats (steps 1–3).
      revealIntro(finalCam, () => map.areTilesLoaded());
    });
  } catch { finish(); }
}

function revealIntro(finalCam, tilesReady) {
  const veil = document.getElementById('boot-veil');
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

  // Beats 1–2: hold black, then hide the basemap and lift the veil so the emblem
  // graphics fade in alone on black. Fixed schedule — no network dependence.
  setTimeout(() => {
    fadeNonEmblem(map, false);            // basemap + live ray → opacity 0 (instant)
    if (veil) veil.style.opacity = '0';   // CSS fade → emblem appears on black
  }, BOOT.holdBlack);

  // Beats 3–4: after the emblem has held, fade the basemap + buildings + chrome in
  // together while the camera eases up. Holds longer (capped) if tiles aren't ready.
  const doReveal = () => {
    if (veil) veil.style.display = 'none';
    fadeNonEmblem(map, true, BOOT.basemapFade);
    fadeBuildingsIn(BOOT.basemapFade);   // smooth building reveal, regardless of layer-add timing
    try { map.easeTo({ ...finalCam, duration: BOOT.camMove, easing: easeInOut }); } catch {}
    // Restore the z14 building floor once the move has settled (settled zoom is ≥14, so
    // this is a no-op on the resting view; it just re-arms the floor for user gestures).
    setTimeout(() => { try { map.setMinZoom(14); } catch {} }, BOOT.camMove + 200);
    document.body.classList.remove('booting');
    try { initSliderFills(); } catch {}
    _lastInteract = Date.now();
  };
  const nominal = BOOT.holdBlack + BOOT.veilFade + BOOT.emblemHold;
  setTimeout(() => {
    const startWait = Date.now();
    const tryReveal = () => {
      if (tilesReady() || (Date.now() - startWait) >= BOOT.tileWaitCap) doReveal();
      else setTimeout(tryReveal, 100);
    };
    tryReveal();
  }, nominal);
}


function redraw(s, changed) {
  // Guard: skip entirely if observer coordinates are invalid (e.g. malformed hash)
  if (!s.observer || !Number.isFinite(s.observer.lat) || !Number.isFinite(s.observer.lon)) return;

  const observerChanged   = changed.includes('observer');
  const modeChanged       = changed.includes('mode');
  const viewChanged       = changed.includes('view');
  const targetChanged     = changed.includes('target');
  const shadowChanged     = changed.includes('shadowEnabled');
  const moonMode = s.mode === 'moon';

  if (observerChanged) {
    try { setObserver(map, s.observer.lat, s.observer.lon); } catch (e) { captureError(e, { phase: 'setObserver' }); }
  }

  // Day-level recompute — each call isolated so one failure doesn't block others
  const dayKey      = startOfLocalDay(s.datetime).toDateString();
  const observerKey = `${s.observer.lat.toFixed(4)},${s.observer.lon.toFixed(4)}`;
  const dayLevelChanged = (dayKey !== lastDayKey) || (observerKey !== lastObserverKey);
  if (dayLevelChanged || observerChanged || modeChanged) {
    let t = { rise: null, set: null };
    try { t = updateSunPathDay(map, s.observer, s.datetime, moonMode); } catch (e) { captureError(e, { phase: 'sunPathDay' }); }
    // Shadow-position arc reuses the day samples just computed above. (Hidden during
    // the wizard setup view, which shows only ground zero + caster.)
    try { if (s.shadowEnabled && !_alignSetup) updateShadowArcDay(map, s.observer, s.datetime, moonMode); } catch (e) { captureError(e, { phase: 'shadowArc' }); }
    // Sync scrubber range to active arc in moon mode (rise→set as 0..N minutes)
    setScrubberRange(
      { scrubber: dom.scrubber },
      moonMode ? 'moon' : 'sun',
      moonMode ? t.rise : null,
      moonMode ? t.set  : null,
    );
    renderScrubberTicks(dom.scrubberTicks, t.rise, t.set, s.datetime);
    // The track's light ramp, from THIS day's real solar events — see the note
    // in scrubber.js for why it is no longer five hardcoded percentages.
    try {
      paintScrubberDayRamp(dom, moonMode ? 'moon' : 'sun',
        getDayBoundaries(s.datetime, s.observer.lat, s.observer.lon), s.datetime);
    } catch (e) { captureError(e, { phase: 'scrubberRamp' }); }
    updateRiseSet(s, t);
    if (moonMode) updateMoonThumb(s.datetime);
    lastDayKey = dayKey;
    lastObserverKey = observerKey;
  }

  // Per-frame body position — each layer isolated so one crash doesn't kill others
  const moonPos = moonMode ? getMoonPos(s.datetime, s.observer.lat, s.observer.lon) : null;
  try { updateSunNow(map, s.observer, s.datetime, moonPos); } catch (e) { captureError(e, { phase: 'sunNow' }); }
  try { if (s.shadowEnabled) updateShadow(map, s.observer, s.datetime, moonMode); } catch (e) { captureError(e, { phase: 'shadow' }); }
  // Light the 3D buildings from the active body: the sun in sun mode (warm ramp,
  // amber→red at the horizon), the MOON in moon mode (cool, dim) so the night
  // city reads as moonlit rather than sun-shaded.
  try {
    const lp = moonMode ? (moonPos || getMoonPos(s.datetime, s.observer.lat, s.observer.lon))
                        : getPosition(s.datetime, s.observer.lat, s.observer.lon);
    setSceneLight(map, lp.azimuthDeg, lp.altitudeDeg, moonMode,
                  { date: s.datetime, lat: s.observer.lat, lon: s.observer.lon });
  } catch (e) { captureError(e, { phase: 'sceneLight' }); }
  updateNowText(s);

  if (modeChanged || viewChanged || shadowChanged) {
    try { syncChrome(s); } catch (e) { captureError(e, { phase: 'syncChrome' }); }
  }

  if (targetChanged || observerChanged) {
    try { setTarget(map, s.observer, s.target); } catch (e) { captureError(e, { phase: 'target' }); }
  }

}

function syncChrome(s) {
  const inSun = s.mode === 'sun';

  document.body.classList.toggle('mode-sun', inSun);
  document.body.classList.toggle('mode-moon', !inSun);

  // Wizard setup view declutters: only ground zero + caster + the line, so the user
  // can place ground zero and the caster cleanly with nothing else on screen.
  const setup  = _alignSetup;
  setSunPathVisible(map, true);
  setArcSuppressed(setup);                       // hide sun beads + live body in setup
  setRiseSetVisible(map, !setup);                // hide rise/set spokes in setup
  setRayLineVisible(map, !setup);
  setShadowVisible(map, true);
  setSetupMode(setup);                           // shadow draws caster-only in setup
  setObserverVisible(map, true);

  setBodyColor(map, !inSun);

  // Body icon: shows what you'd switch TO. In sun mode → show moon icon.
  if (dom.bodyIconSun)  dom.bodyIconSun.classList.toggle('hide', inSun);
  if (dom.bodyIconMoon) dom.bodyIconMoon.classList.toggle('hide', !inSun);

  if (dom.shadowElevPanel) dom.shadowElevPanel.hidden = false;
}


function updateRiseSet(s, t) {
  const fmt = (d, prefix) => d ? `${prefix} ${formatTime(d)}` : `${prefix} —`;
  if (dom.riseLabel) dom.riseLabel.textContent = fmt(t.rise, '↑');
  if (dom.setLabel)  dom.setLabel.textContent  = fmt(t.set, '↓');
}

function updateNowText(s) {
  const isMoon = s.mode === 'moon';
  const p = isMoon
    ? getMoonPos(s.datetime, s.observer.lat, s.observer.lon)
    : getPosition(s.datetime, s.observer.lat, s.observer.lon);
  const alt = p.altitudeDeg;
  const above = alt > 0;
  if (dom.sunAlt) {
    dom.sunAlt.textContent = above ? `↑${alt.toFixed(1)}°` : `↓${Math.abs(alt).toFixed(1)}°`;
    dom.sunAlt.classList.toggle('below', !above);
  }
  // Keep the time input's value current so it shows the right time when tapped
  const ti = document.getElementById('time-exact-input');
  if (ti && document.activeElement !== ti) {
    const d = s.datetime;
    ti.value = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
  // Past-time warning: the moon/sun arc UI makes it easy to land on a time that
  // already happened without noticing (e.g. scrubbing a moon arc across midnight).
  // Flag it when it's recently past — older-than-60-days reads as deliberate
  // historical browsing, not an accidental mix-up, so we don't nag for that.
  if (dom.pastWarning) {
    const pastMs = Date.now() - s.datetime.getTime();
    dom.pastWarning.hidden = !(pastMs > 0 && pastMs <= PAST_WARNING_WINDOW_MS);
  }
}

// Pick the opening scene based on current sky:
//   sun above horizon       → sun mode at now
//   sun below, moon above   → moon mode at now
//   both below              → sun mode at today's solar noon
function pickOpeningScene(lat, lon) {
  const now = new Date();
  const sunAlt = getPosition(now, lat, lon).altitudeDeg;
  if (sunAlt > 0) {
    store.set({ mode: 'sun', datetime: now, sunDatetime: now });
    return;
  }
  // Sun is down: open on a daytime golden-hour moment (low sun → nice shadows) rather
  // than a dark/moon scene. 1h before sunset, or 1h after sunrise — whichever clock time
  // is nearer to now, so the opening feels related to the real time of day.
  const b = getDayBoundaries(now, lat, lon);
  const cands = [];
  if (b.sunset)  cands.push(new Date(b.sunset.getTime()  - 3600 * 1000));
  if (b.sunrise) cands.push(new Date(b.sunrise.getTime() + 3600 * 1000));
  let dt = b.solarNoon || now;
  if (cands.length) {
    dt = cands.reduce((best, c) => Math.abs(c - now) < Math.abs(best - now) ? c : best);
  }
  store.set({ mode: 'sun', datetime: dt, sunDatetime: dt });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-15 — the "flyaway".
//
// Blair: "had a flyaway the last time I used it." No repro, but this function is
// the obvious suspect and it was asking for exactly that outcome:
//
//     { enableHighAccuracy: false, timeout: 6000, maximumAge: 60000 }
//
// enableHighAccuracy:false means the GPS is never consulted. The fix comes from
// Wi-Fi SSIDs and cell towers, which in a dense city is usually good to a block
// and is sometimes good to several kilometres — and `maximumAge: 60000` says a
// cached fix up to a minute old is fine, so a stale position from wherever the
// phone last resolved can be handed back instantly. The app then flew to it at
// zoom 15 with total confidence. From the user's side that is the map departing
// for somewhere they are not.
//
// Two changes. Ask for the real GPS. And — the part that matters — CHECK THE
// ACCURACY THAT COMES BACK. Every Position carries `coords.accuracy` in metres
// and this code was throwing it away. A fix worse than ACCURACY_LIMIT is not
// used to fly anywhere; it retries once at high accuracy, and if that is no
// better it places the observer but leaves the camera alone and says why.
//
// The toast prints the accuracy in metres. That is deliberate: I cannot
// reproduce this from here, so the next time it happens the number will be on
// screen and we will know whether this was the cause or whether I am wrong.
// ─────────────────────────────────────────────────────────────────────────────
const ACCURACY_LIMIT = 750;   // metres. Beyond this a fix is a neighbourhood, not a place.

function tryGeolocate() {
  stopDrift();
  const FALLBACK = { lat: 43.6426, lon: -79.3871 };  // CN Tower, Toronto
  const applyFallback = () => {
    store.set({ observer: { lat: FALLBACK.lat, lon: FALLBACK.lon } });
    pickOpeningScene(FALLBACK.lat, FALLBACK.lon);
    if (map) map.flyTo({ center: [FALLBACK.lon, FALLBACK.lat], zoom: 15, duration: 900 });
  };
  if (!navigator.geolocation) { applyFallback(); return; }

  const accept = (pos, isRetry) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    const acc = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : Infinity;
    if (acc > ACCURACY_LIMIT && !isRetry) {
      // Coarse fix on the first attempt — do not move the camera, ask the GPS.
      navigator.geolocation.getCurrentPosition(
        (p2) => accept(p2, true),
        () => accept(pos, true),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
      );
      return;
    }
    store.set({ observer: { lat, lon } });
    pickOpeningScene(lat, lon);
    if (acc > ACCURACY_LIMIT) {
      showToast(`Location accurate to ~${Math.round(acc)} m — map not moved. Drag to where you are.`);
      return;
    }
    if (map) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 13), duration: 900 });
  };

  navigator.geolocation.getCurrentPosition(
    (pos) => accept(pos, false),
    () => applyFallback(),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
  );
}

function hashHasObserver() { return /[#&]ll=/.test(location.hash); }

// Build an SVG data-URI of the moon at a given illuminated fraction + waxing
// flag, used as the slider thumb's background in moon mode. The terminator is a
// half-ellipse whose horizontal semi-axis = r·(1−2·fraction): full circle at
// new (nothing lit), straight line at quarter, inverted at full.
function moonPhaseDataURI(fraction, waxing) {
  const r = 32, d = 64;
  const LIT = '#eef2fb', SHADOW = '#2a3040';
  const rx = Math.max(0.01, Math.abs(r * (1 - 2 * fraction))).toFixed(2);
  let limbSweep, termSweep;
  if (waxing) { limbSweep = 1; termSweep = fraction < 0.5 ? 1 : 0; }
  else        { limbSweep = 0; termSweep = fraction < 0.5 ? 0 : 1; }
  // The computed region is the SHADOW side (disc starts fully lit), which puts
  // the illuminated limb on the correct side — waxing → lit on the right.
  const shadowPath = `M${r},0 A${r},${r} 0 0 ${limbSweep} ${r},${d} A${rx},${r} 0 0 ${termSweep} ${r},0 Z`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${d} ${d}'>`
    + `<circle cx='${r}' cy='${r}' r='${r}' fill='${LIT}'/>`
    + `<path d='${shadowPath}' fill='${SHADOW}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function updateMoonThumb(datetime) {
  if (!dom.scrubber) return;
  try {
    const ill = getMoonIllumination(datetime);
    dom.scrubber.style.setProperty('--moon-thumb', moonPhaseDataURI(ill.fraction, ill.phase <= 0.5));
  } catch {}
}

let toastTimer = null;
function showToast(msg) {
  dom.toast.textContent = msg;
  dom.toast.hidden = false;
  dom.toast.style.pointerEvents = 'none';
  dom.toast.onclick = null;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 2200);
}

// Persistent, tappable toast for recoverable failures (e.g. map didn't load).
// Reload is safe — session state is restored from localStorage on relaunch.
function showReloadToast(msg) {
  if (!dom.toast) return;
  dom.toast.textContent = msg;
  dom.toast.hidden = false;
  dom.toast.style.pointerEvents = 'auto';
  if (toastTimer) clearTimeout(toastTimer);
  dom.toast.onclick = () => location.reload();
}

// ── UI state persistence ─────────────────────────────────────────────────────
// Syncs the lock button visual and height-input disabled state to store.locked.
function syncLock() {
  const locked = store.get().locked;
  if (dom.lockBtn) {
    dom.lockBtn.classList.toggle('active', locked);
    dom.lockBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
  }
  const dis = locked;
  if (dom.shadowElev)    dom.shadowElev.disabled    = dis;
  if (dom.shadowElevVal) dom.shadowElevVal.disabled = dis;
  if (dom.floorElev)     dom.floorElev.disabled     = dis;
  if (dom.floorElevVal)  dom.floorElevVal.disabled  = dis;
}

// Saves slider positions to localStorage so a crash or close restores them.
// Observer / datetime / mode are persisted by attachHashSync via the URL hash.

function saveUI() {
  try {
    localStorage.setItem('sun_ui', JSON.stringify({
      casterH: dom.shadowElev?.value,
      floorH:  dom.floorElev?.value,
      radius:  dom.radiusSlider?.value,
      tilt:    dom.tiltSlider?.value,
      locked:  store.get().locked,
    }));
  } catch {}
}

function restoreUI(mapInstance) {
  let saved;
  try { saved = JSON.parse(localStorage.getItem('sun_ui') || 'null'); } catch {}
  if (!saved) return;

  if (saved.casterH != null && dom.shadowElev) {
    dom.shadowElev.value = saved.casterH;
    const h = sliderToHeight(saved.casterH);
    setShadowHeight(h);
    if (dom.shadowElevVal) dom.shadowElevVal.value = String(h);
  }
  if (saved.floorH != null && dom.floorElev) {
    dom.floorElev.value = saved.floorH;
    const h = sliderToHeight(saved.floorH);
    setFloorHeight(h);
    if (dom.floorElevVal) dom.floorElevVal.value = String(h);
  }
  if (saved.tilt != null && dom.tiltSlider) {
    const v = Math.max(0, Math.min(85, +saved.tilt || 0));
    dom.tiltSlider.value = String(v);
    try { mapInstance.setPitch(v); } catch {}
  }
  if (saved.radius != null && dom.radiusSlider) {
    // Value is read directly by applyRadius() which runs immediately after restoreUI().
    dom.radiusSlider.value = saved.radius;
    setArcRadiusKm(sliderToRadiusKm(saved.radius));
  }
  if (saved.locked) {
    store.set({ locked: true });
    syncLock();
  }
}

// ── Last-session persistence ─────────────────────────────────────────────────
// Restores the framing you closed at: observer coords, zoom, mode (sliders/tilt
// come from sun_ui above). Time is only restored if it's still in the FUTURE —
// a past time after days away would just invite mistakes, so we open at "now".
const SESSION_KEY = 'sun_session';

function saveSession() {
  if (!map) return;
  try {
    const s = store.get();
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      observer: s.observer,
      mode: s.mode,
      zoom: map.getZoom(),
      datetime: s.datetime instanceof Date ? s.datetime.toISOString() : null,
    }));
  } catch {}
}
const saveSessionDebounced = debounce(saveSession, 400);

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

// Global error trap → show in toast so crashes are visible on mobile.
// Logging to the persistent ring buffer is handled by initMonitor above.
window.addEventListener('error', (e) => {
  const t = document.getElementById('toast');
  if (t) { t.textContent = 'JS: ' + ((e && e.message) || 'unknown error'); t.hidden = false; }
});
window.addEventListener('unhandledrejection', (e) => {
  const t = document.getElementById('toast');
  if (t) { t.textContent = 'Promise: ' + ((e.reason && (e.reason.message || e.reason.toString())) || 'rejection'); t.hidden = false; }
});

main().catch((e) => {
  console.error(e);
  captureError(e, { phase: 'main' });
  const t = document.getElementById('toast');
  if (t) { t.textContent = 'main(): ' + e.message; t.hidden = false; }
  else document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;top:60px;left:10px;right:10px;padding:12px;background:#400;color:#fff;z-index:99;border-radius:8px;font:13px monospace;">main(): ${e.message}</div>`);
});

// Slider fill: every range input exposes its position as --fill so the CSS can
// draw the track only up to the thumb, making the thumb read as the end of a line
// it is extending (Blair, 2026-07-29). Idempotent; safe to call after any
// programmatic value change (saves/restore).
function initSliderFills() {
  const setFill = (el) => {
    if (!el) return;
    const min = +el.min || 0, max = +el.max || 100, v = +el.value;
    const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--fill', pct.toFixed(2) + '%');
  };
  document.querySelectorAll('input[type=range]').forEach((el) => {
    setFill(el);
    if (!el.dataset.fillBound) {
      el.addEventListener('input', () => setFill(el), { passive: true });
      el.dataset.fillBound = '1';
    }
  });
}
window.refreshSliderFills = initSliderFills;
