// Device orientation (compass) handling.
// iOS 13+ requires a permission request from a user gesture.
// EMA smoothing on heading; we publish to store.compassHeading.

import * as store from '../state.js';

const SMOOTHING = 0.12;         // lower = more stable (was 0.2)
const PITCH_SMOOTHING = 0.18;
const SPIKE_THRESHOLD = 45;     // degrees — discard jumps larger than this
const MAX_PITCH = 75;
let smoothed = null;
let smoothedPitch = null;
let attached = false;

export async function enableCompass() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') return false;
    }
    if (!attached) {
      // Prefer absolute orientation; fall back to relative
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
      attached = true;
    }
    store.set({ compassEnabled: true });
    return true;
  } catch (e) {
    return false;
  }
}

export function disableCompass() {
  if (attached) {
    window.removeEventListener('deviceorientationabsolute', onOrient, true);
    window.removeEventListener('deviceorientation', onOrient, true);
    attached = false;
  }
  smoothed = null;
  smoothedPitch = null;
  store.set({ compassEnabled: false, compassHeading: null, compassPitch: null });
}

function onOrient(e) {
  let heading = null;
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
    heading = e.webkitCompassHeading; // iOS, already 0=N clockwise
  } else if (e.absolute && typeof e.alpha === 'number') {
    heading = (360 - e.alpha) % 360;
  } else if (typeof e.alpha === 'number') {
    heading = (360 - e.alpha) % 360;
  }
  if (heading == null) return;

  // Account for screen orientation
  const so = (screen.orientation && screen.orientation.angle) || 0;
  heading = (heading + so) % 360;

  if (smoothed == null) {
    smoothed = heading;
  } else {
    const delta = ((heading - smoothed + 540) % 360) - 180;
    if (Math.abs(delta) > SPIKE_THRESHOLD) return; // discard spike
    smoothed = (smoothed + delta * SMOOTHING + 360) % 360;
  }

  // Tilt: device beta is rotation around X (front/back). beta=0 → screen flat
  // facing up (top-down map). beta=90 → portrait, looking at horizon (max pitch).
  // Compensate for screen orientation so landscape uses gamma instead.
  let pitch = null;
  const beta = (typeof e.beta === 'number') ? e.beta : null;
  const gamma = (typeof e.gamma === 'number') ? e.gamma : null;
  if (so === 0 || so === 180) {
    if (beta != null) pitch = beta;
  } else {
    if (gamma != null) pitch = Math.abs(gamma);
  }
  if (pitch != null) {
    pitch = Math.max(0, Math.min(MAX_PITCH, pitch));
    if (smoothedPitch == null) smoothedPitch = pitch;
    else smoothedPitch = smoothedPitch + (pitch - smoothedPitch) * PITCH_SMOOTHING;
    store.set({ compassHeading: smoothed, compassPitch: smoothedPitch });
  } else {
    store.set({ compassHeading: smoothed });
  }
}
