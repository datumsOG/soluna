// Reflection pick controller. Replaces the old aim mode (over-the-shoulder camera +
// crosshair + auto face-pick). The model is now direct and tactile: tap a point on a
// building wall and the sun's reflection off THAT point draws to the ground and tracks
// the sun as you scrub time. No camera choreography, no crosshair, no debug readout.
//
// State split: the reflector itself (the picked wall point) lives in shadow.js, which
// redraws it against the live sun every frame. This module owns only the transient
// "waiting for the next tap" pick mode and the button behaviour.

import { pickWallPoint, setReflector, getReflector } from '../layers/shadow.js';

let _map = null;
let _showToast = () => {};
let _picking = false;

export function initReflect(map, opts = {}) {
  _map = map;
  _showToast = opts.showToast || (() => {});
}

export function isPickingReflector() { return _picking; }
export function hasReflector() { return !!getReflector(); }

// Button behaviour: if a reflection is set, clear it; if mid-pick, cancel; otherwise
// start picking. Caller syncs the button visual afterwards (see syncReflectBtn).
export function toggleReflect() {
  if (getReflector()) { setReflector(null); _picking = false; _showToast('Reflection cleared'); return; }
  if (_picking) { _picking = false; _showToast('Cancelled'); return; }
  _picking = true;
  _showToast('Tap a sunlit building wall');
}

// Routed here by the map click handler while picking. Returns true if the tap was
// consumed (so the handler doesn't also move the observer).
export function handleReflectTap(screenPt) {
  if (!_picking || !_map) return false;
  let r = null;
  try { r = pickWallPoint(_map, screenPt); } catch { r = null; }
  if (!r) { _showToast('No wall there — tap a building face'); return true; }
  setReflector({ lon: r.lon, lat: r.lat, h: r.h, edge: r.edge });
  _picking = false;
  _showToast('Reflection set — scrub time to follow the glint');
  return true;
}
