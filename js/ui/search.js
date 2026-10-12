// Geocoding via Photon (Komoot's free, CORS-enabled, no-key endpoint).

import * as store from '../state.js';
import { debounce } from '../util.js';

const PHOTON = 'https://photon.komoot.io/api/';

export function initSearch(els, mapRef) {
  const { input, results } = els;
  const map = mapRef;

  const search = debounce(async (q) => {
    if (!q || q.trim().length < 2) {
      hide(results);
      return;
    }
    try {
      const url = new URL(PHOTON);
      url.searchParams.set('q', q);
      url.searchParams.set('limit', '6');
      const center = store.get().observer;
      url.searchParams.set('lat', String(center.lat));
      url.searchParams.set('lon', String(center.lon));
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) { hide(results); return; }
      const data = await res.json();
      render(results, data.features || []);
    } catch (e) {
      hide(results);
    }
  }, 280);

  input.addEventListener('input', (e) => search(e.target.value));
  input.addEventListener('focus', () => {
    document.body.classList.add('searching');
    if (input.value.trim()) search(input.value);
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      document.body.classList.remove('searching');
      hide(results);
    }, 180);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.blur(); hide(results); }
    if (e.key === 'Enter') {
      const first = results.querySelector('li');
      if (first) first.click();
    }
  });

  function render(ul, features) {
    if (!features.length) { hide(ul); return; }
    ul.innerHTML = '';
    for (const f of features) {
      const p = f.properties || {};
      const [lon, lat] = f.geometry.coordinates;
      const name = p.name || p.street || '(unnamed)';
      const sub = [p.city, p.state, p.country].filter(Boolean).join(', ');
      const li = document.createElement('li');
      li.innerHTML = `<div class="result-name">${escapeHtml(name)}</div><div class="result-sub">${escapeHtml(sub)}</div>`;
      li.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus to prevent blur cancel
      li.addEventListener('click', () => {
        store.set({ observer: { lat, lon } });
        if (map) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 13), duration: 900 });
        input.value = name;
        hide(ul);
        input.blur();
      });
      ul.appendChild(li);
    }
    ul.hidden = false;
  }

  function hide(ul) {
    ul.hidden = true;
    ul.innerHTML = '';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
