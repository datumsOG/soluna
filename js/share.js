// URL hash <-> state encoding.
// Format: #ll=43.6532,-79.3832&t=2026-04-30T18:30&m=moon&tg=43.66,-79.38

import * as store from './state.js';
import { debounce } from './util.js';

export function encodeStateToHash(state) {
  const parts = [];
  if (state.observer) {
    parts.push(`ll=${state.observer.lat.toFixed(5)},${state.observer.lon.toFixed(5)}`);
  }
  if (state.datetime) {
    const d = state.datetime;
    const pad = (n) => String(n).padStart(2, '0');
    const iso = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    parts.push(`t=${iso}`);
  }
  if (state.mode && state.mode !== 'sun') parts.push(`m=${state.mode}`);
  if (state.target) parts.push(`tg=${state.target.lat.toFixed(5)},${state.target.lon.toFixed(5)}`);
  return '#' + parts.join('&');
}

export function decodeHashToState(hash) {
  const out = {};
  if (!hash || hash.length < 2) return out;
  const params = new URLSearchParams(hash.slice(1));
  const ll = params.get('ll');
  if (ll) {
    const [lat, lon] = ll.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.observer = { lat, lon };
  }
  const t = params.get('t');
  if (t) {
    const d = new Date(t);
    if (!isNaN(d)) out.datetime = d;
  }
  const m = params.get('m');
  if (m === 'sun' || m === 'moon') out.mode = m;
  const tg = params.get('tg');
  if (tg) {
    const [lat, lon] = tg.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.target = { lat, lon };
  }
  return out;
}

export function attachHashSync() {
  const initial = decodeHashToState(location.hash);
  if (Object.keys(initial).length) store.set(initial);

  const update = debounce(() => {
    const s = store.get();
    const hash = encodeStateToHash(s);
    if (hash !== location.hash) {
      history.replaceState(null, '', location.pathname + location.search + hash);
    }
  }, 200);

  store.subscribeAll(update);
  window.addEventListener('hashchange', () => {
    const fromHash = decodeHashToState(location.hash);
    if (Object.keys(fromHash).length) store.set(fromHash);
  });
}
