// Tiny pub/sub state store.
//
// Shape:
//   {
//     observer: { lat, lon },
//     datetime: Date,
//     mode: 'sun' | 'moon',                 // celestial body being tracked
//     view: 'map' | 'camera',               // which UI surface is active
//     shadowEnabled: boolean,
//     compassEnabled: boolean,
//     compassHeading: number | null,
//     target: { lat, lon } | null,
//   }

const listeners = new Map();
const allListeners = new Set();

const state = {
  observer: { lat: 43.6532, lon: -79.3832 },
  datetime: new Date(),
  // Per-mode datetime memory: switching sun↔moon restores the last datetime
  // you were on in that mode rather than carrying the cross-mode time over.
  sunDatetime: new Date(),
  moonDatetime: null,
  mode: 'sun',
  view: 'map',
  shadowEnabled: true,
  locked: false,
  compassEnabled: false,
  compassHeading: null,
  compassPitch: null,
  target: null,
};

export function get() { return state; }

export function subscribe(slice, fn) {
  if (!listeners.has(slice)) listeners.set(slice, new Set());
  listeners.get(slice).add(fn);
  return () => listeners.get(slice).delete(fn);
}

export function subscribeAll(fn) {
  allListeners.add(fn);
  return () => allListeners.delete(fn);
}

export function set(partial) {
  const changed = [];
  for (const k in partial) {
    if (!Object.is(state[k], partial[k])) {
      state[k] = partial[k];
      changed.push(k);
    }
  }
  if (!changed.length) return;
  for (const k of changed) {
    const ls = listeners.get(k);
    if (ls) for (const fn of ls) {
      try { fn(state[k], state); } catch (e) { console.error(e); }
    }
  }
  for (const fn of allListeners) {
    try { fn(state, changed); } catch (e) { console.error(e); }
  }
}
