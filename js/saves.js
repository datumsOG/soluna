// saves.js — save / load / delete shots (localStorage key sun_saves).

import * as store from './state.js';
import { formatDate, formatTime } from './util.js';

const SAVES_KEY = 'sun_saves';

let _map = null;
let _deps = null;

// Load-list scope: which save type the list currently shows. Defaults to
// 'position' every time the panel is opened (v109 spec).
let _scope = 'position';

function _loadAll() {
  try { return JSON.parse(localStorage.getItem(SAVES_KEY) || '[]'); } catch { return []; }
}

function _persistAll(arr) {
  try { localStorage.setItem(SAVES_KEY, JSON.stringify(arr)); } catch {}
}

/**
 * Wire up the saves UI.
 * deps: { dom, setShadowHeight, setFloorHeight, sliderToHeight, syncLock, showToast }
 */
export function initSaves(map, deps) {
  _map = map;
  _deps = deps;

  const savesBtn        = document.getElementById('saves-btn');
  const saveModal       = document.getElementById('save-modal');
  const saveNameInput   = document.getElementById('save-name-input');
  const savePosBtn      = document.getElementById('save-pos-btn');
  const saveFullBtn     = document.getElementById('save-ok-btn');
  const saveCancelBtn   = document.getElementById('save-cancel-btn');
  const scopeBtn        = document.getElementById('saves-scope-btn');

  const _closeModal = () => {
    if (saveModal) saveModal.hidden = true;
    if (savesBtn) { savesBtn.classList.remove('active'); savesBtn.setAttribute('aria-pressed', 'false'); }
  };

  if (savesBtn) {
    savesBtn.addEventListener('click', () => {
      if (saveModal && !saveModal.hidden) { _closeModal(); return; }
      _openNameModal();
      if (savesBtn) { savesBtn.classList.add('active'); savesBtn.setAttribute('aria-pressed', 'true'); }
    });
  }

  if (savePosBtn)  savePosBtn.addEventListener('click', () => _doSave('position'));
  if (saveFullBtn) saveFullBtn.addEventListener('click', () => _doSave('full'));

  if (saveCancelBtn) saveCancelBtn.addEventListener('click', _closeModal);

  if (saveNameInput) {
    saveNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') _doSave('full');
      if (e.key === 'Escape') _closeModal();
    });
  }

  if (scopeBtn) {
    scopeBtn.addEventListener('click', () => {
      _scope = _scope === 'position' ? 'full' : 'position';
      _syncScopeBtn();
      _renderList();
    });
  }
}

function _syncScopeBtn() {
  const scopeBtn = document.getElementById('saves-scope-btn');
  if (!scopeBtn) return;
  const isFull = _scope === 'full';
  scopeBtn.textContent = isFull ? 'Full states' : 'Positions';
  scopeBtn.classList.toggle('active', isFull);
  scopeBtn.setAttribute('aria-pressed', isFull ? 'true' : 'false');
}

function _openNameModal() {
  const saveNameInput = document.getElementById('save-name-input');
  if (!saveNameInput) return;
  const s = store.get();
  const dt = s.datetime instanceof Date ? s.datetime : new Date(s.datetime);
  saveNameInput.value = `${formatDate(dt)} ${formatTime(dt)}`;
  const saveModal = document.getElementById('save-modal');
  if (saveModal) saveModal.hidden = false;
  _scope = 'position';   // load list always opens on Positions (spec)
  _syncScopeBtn();
  _renderList();   // populate the load list whenever the panel opens
  setTimeout(() => { try { saveNameInput.select(); saveNameInput.focus(); } catch {} }, 40);
}

function _doSave(type) {
  const saveNameInput = document.getElementById('save-name-input');
  if (!saveNameInput || !_map || !_deps) return;
  const name = saveNameInput.value.trim() || 'Unnamed';
  const saveModal  = document.getElementById('save-modal');
  const savesBtn   = document.getElementById('saves-btn');
  if (saveModal) saveModal.hidden = true;
  if (savesBtn) { savesBtn.classList.remove('active'); savesBtn.setAttribute('aria-pressed', 'false'); }
  _captureAndSave(name, type);
}

function _captureAndSave(name, type) {
  const s = store.get();
  const { dom } = _deps;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ts = new Date().toISOString();

  let snap;
  if (type === 'position') {
    // Position-only: place + map view. No time/mode/heights — loading it keeps
    // whatever's currently set so Blair can check "is there a good shot here now".
    snap = {
      id, name, ts, type: 'position',
      observer: { lat: s.observer.lat, lon: s.observer.lon },
      zoom:    _map.getZoom(),
      bearing: _map.getBearing(),
    };
  } else {
    snap = {
      id, name, ts, type: 'full',
      observer: { lat: s.observer.lat, lon: s.observer.lon },
      mode: s.mode,
      datetime: s.datetime instanceof Date ? s.datetime.toISOString() : String(s.datetime),
      casterH:     dom.shadowElev   ? dom.shadowElev.value   : '0',
      floorH:      dom.floorElev    ? dom.floorElev.value    : '0',
      radiusSlider: dom.radiusSlider ? dom.radiusSlider.value : '445',
      tilt:         dom.tiltSlider   ? dom.tiltSlider.value   : '45',
      zoom:    _map.getZoom(),
      bearing: _map.getBearing(),
      locked: s.locked,
    };
  }

  const arr = _loadAll();
  arr.unshift(snap);
  _persistAll(arr);
  _deps.showToast(type === 'position' ? 'Position saved' : 'Shot saved');
  _scope = type === 'position' ? 'position' : 'full';
  _syncScopeBtn();
  _renderList();
}

function _applySnap(snap) {
  if (!_map || !_deps) return;
  const { dom, setShadowHeight, setFloorHeight, sliderToHeight, syncLock, showToast } = _deps;

  // Any save, either type, engages the observer/height lock on load so the
  // view it put you at can't be nudged by an accidental tap (v109 spec —
  // "locked" is this app's existing tap-lock, see lock-btn in app.js).
  if (snap.type === 'position') {
    const s = store.get();
    const nowDt = new Date();
    const upd = {
      observer: { lat: snap.observer.lat, lon: snap.observer.lon },
      datetime: nowDt,
      locked: true,
    };
    if (s.mode === 'moon') upd.moonDatetime = nowDt;
    else upd.sunDatetime = nowDt;
    store.set(upd);

    // Map view only — zoom/bearing from the save, current tilt/pitch untouched.
    try {
      _map.jumpTo({
        center: [snap.observer.lon, snap.observer.lat],
        zoom: snap.zoom,
        bearing: snap.bearing,
      });
    } catch {}

    syncLock();
    showToast('Position loaded');
  } else {
    const dt = new Date(snap.datetime);
    const upd = {
      observer: { lat: snap.observer.lat, lon: snap.observer.lon },
      mode: snap.mode,
      datetime: isNaN(dt) ? new Date() : dt,
      locked: true,
    };
    if (snap.mode === 'moon') upd.moonDatetime = upd.datetime;
    else upd.sunDatetime = upd.datetime;
    store.set(upd);

    // Caster height — set directly then sync DOM
    const cH = sliderToHeight(snap.casterH);
    setShadowHeight(cH);
    if (dom.shadowElev)    dom.shadowElev.value   = String(snap.casterH);
    if (dom.shadowElevVal) dom.shadowElevVal.value = String(cH);

    // Floor height
    const fH = sliderToHeight(snap.floorH);
    setFloorHeight(fH);
    if (dom.floorElev)    dom.floorElev.value   = String(snap.floorH);
    if (dom.floorElevVal) dom.floorElevVal.value = String(fH);

    // Radius — dispatch 'input' to reuse existing applyRadius() + saveUI() logic
    if (dom.radiusSlider) {
      dom.radiusSlider.value = String(snap.radiusSlider);
      dom.radiusSlider.dispatchEvent(new Event('input'));
    }

    // Tilt slider — dispatch 'input' to reuse stopDrift + _applyTiltSlider + saveUI
    if (dom.tiltSlider) {
      dom.tiltSlider.value = String(snap.tilt);
      dom.tiltSlider.dispatchEvent(new Event('input'));
    }

    // Map framing (pitch may override the slider-dispatched setPitch — same value, harmless)
    try {
      _map.jumpTo({
        center: [snap.observer.lon, snap.observer.lat],
        zoom: snap.zoom,
        bearing: snap.bearing,
        pitch: +snap.tilt,
      });
    } catch {}

    syncLock();
    showToast('Shot loaded');
  }

  const saveModal = document.getElementById('save-modal');
  const savesBtn  = document.getElementById('saves-btn');
  if (saveModal) saveModal.hidden = true;
  if (savesBtn) { savesBtn.classList.remove('active'); savesBtn.setAttribute('aria-pressed', 'false'); }
}

function _deleteSnap(id) {
  const arr = _loadAll().filter(s => s.id !== id);
  _persistAll(arr);
  _renderList();
}

function _renderList() {
  const list = document.getElementById('saves-list');
  if (!list) return;
  // Backward compat: saves persisted before v109 have no `type` — they were
  // always full-state captures, so treat a missing type as 'full'.
  const arr = _loadAll().filter(s => (s.type || 'full') === _scope);
  list.innerHTML = '';
  if (!arr.length) {
    const p = document.createElement('p');
    p.className = 'saves-empty';
    p.textContent = _scope === 'position' ? 'No saved positions yet.' : 'No saved shots yet.';
    list.appendChild(p);
    return;
  }
  for (const snap of arr) {
    const row = document.createElement('div');
    row.className = 'saves-row';

    const nameBtn = document.createElement('button');
    nameBtn.className = 'saves-row-name';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = snap.name;

    const subSpan = document.createElement('span');
    subSpan.className = 'saves-row-sub';
    subSpan.textContent = snap.type === 'position'
      ? `position · ${formatTime(new Date(snap.ts))}`
      : `${snap.mode} · ${formatTime(new Date(snap.ts))}`;

    nameBtn.appendChild(nameSpan);
    nameBtn.appendChild(subSpan);
    nameBtn.addEventListener('click', () => _applySnap(snap));

    const delBtn = document.createElement('button');
    delBtn.className = 'saves-del-btn';
    delBtn.setAttribute('aria-label', 'Delete save');
    delBtn.textContent = '×';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); _deleteSnap(snap.id); });

    row.appendChild(nameBtn);
    row.appendChild(delBtn);
    list.appendChild(row);
  }
}
