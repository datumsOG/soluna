// Utility helpers.

import { getArcMatrix } from './layers/arc-gl.js';

const EARTH_RADIUS_KM = 6371;

/** Project from (lat, lon) by `distanceKm` along compass `bearingDeg`. */
export function destination(lat, lon, bearingDeg, distanceKm) {
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const brng = (bearingDeg * Math.PI) / 180;
  const ang = distanceKm / EARTH_RADIUS_KM;
  const sinLat1 = Math.sin(lat1), cosLat1 = Math.cos(lat1);
  const sinAng = Math.sin(ang), cosAng = Math.cos(ang);
  const sinLat2 = sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(brng);
  const lat2 = Math.asin(sinLat2);
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * sinAng * cosLat1,
    cosAng - sinLat1 * sinLat2,
  );
  return [((lon2 * 180 / Math.PI) + 540) % 360 - 180, (lat2 * 180) / Math.PI];
}

/** Compass bearing from (lat1, lon1) to (lat2, lon2). */
export function bearing(lat1, lon1, lat2, lon2) {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

/** Smallest signed delta from a→b in degrees, in (-180, 180]. */
export function azDelta(a, b) {
  let d = ((b - a + 540) % 360) - 180;
  return d;
}

export function formatTime(date) {
  if (!date || isNaN(date)) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatDate(date) {
  if (!date || isNaN(date)) return '—';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return 'Today';
  // "Nov 12" — short month + day, no year, to keep the date button compact and
  // stable-width. (The native date-picker popup keeps the OS's own full format.)
  const mon = date.toLocaleString('en', { month: 'short' });
  return `${mon} ${date.getDate()}`;
}

export function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function throttleRaf(fn) {
  let pending = false, lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...lastArgs);
    });
  };
}

/** Replace today's date with the given Date's HH:MM, returning a new Date. */
export function withTime(baseDate, hours, minutes) {
  const d = new Date(baseDate);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

export function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

export function withMinutes(baseDate, totalMinutes) {
  const d = new Date(baseDate);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(totalMinutes);
  return d;
}

export function startOfLocalDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Project a 3D world point (lng, lat, altMeters above ground) to screen pixels.
 *
 * Uses the EXACT projection matrix the arc-gl custom layer renders with (captured
 * each frame), applied to the same MercatorCoordinate. So every elevated DOM/SVG
 * graphic (caster sphere, shadow end, sky line, coord labels) lands precisely
 * where the GL arc draws — on AND off the screen centre, under any pitch/bearing.
 *
 * The previous implementation was a flat-earth ray-cast approximation that was
 * only accurate near screen-centre and drifted laterally as you panned.
 */
export function project3D(map, lng, lat, altMeters) {
  if (!altMeters || Math.abs(altMeters) < 1e-6) return map.project([lng, lat]);

  const m = getArcMatrix();
  const t = map && map.transform;
  if (!m || !t || !maplibregl || !maplibregl.MercatorCoordinate) {
    return map.project([lng, lat]);  // matrix not captured yet → degrade to ground
  }

  const mc = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], altMeters);
  const X = mc.x, Y = mc.y, Z = mc.z;
  // clip = M · [X,Y,Z,1]  (column-major mat4, as WebGL uses)
  const cx = m[0]*X + m[4]*Y + m[8]*Z  + m[12];
  const cy = m[1]*X + m[5]*Y + m[9]*Z  + m[13];
  const cw = m[3]*X + m[7]*Y + m[11]*Z + m[15];
  if (!(cw > 0)) return map.project([lng, lat]);  // behind the camera → degrade gracefully

  const ndcX = cx / cw, ndcY = cy / cw;
  // NDC → CSS pixels over the full viewport (matches map.project's space).
  return { x: (ndcX * 0.5 + 0.5) * t.width, y: (0.5 - ndcY * 0.5) * t.height };
}
