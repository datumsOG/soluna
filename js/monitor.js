// Lightweight error monitor: persists to localStorage ring buffer.
// Access from browser console: window.__sunLog() / window.__sunClearLog()
//
// Optional Sentry: set window.SENTRY_DSN before this module loads, then
// uncomment the Sentry CDN script in index.html. Errors are forwarded to
// Sentry automatically when the SDK is present and a DSN is configured.

const RING_KEY = 'sun_error_log';
const RING_SIZE = 50;

let _getState = null;

function safeState() {
  try {
    const s = _getState?.();
    if (!s) return null;
    return {
      mode: s.mode,
      view: s.view,
      lat: s.observer?.lat,
      lon: s.observer?.lon,
      datetime: s.datetime?.toISOString?.(),
      shadowOn: s.shadowEnabled,
    };
  } catch { return null; }
}

function push(entry) {
  try {
    const log = JSON.parse(localStorage.getItem(RING_KEY) || '[]');
    log.push(entry);
    if (log.length > RING_SIZE) log.splice(0, log.length - RING_SIZE);
    localStorage.setItem(RING_KEY, JSON.stringify(log));
  } catch {}
  const err = entry._err;
  delete entry._err;
  if (window.Sentry?.captureException && err instanceof Error) {
    try { window.Sentry.captureException(err, { extra: entry }); } catch {}
  }
}

export function initMonitor(stateGetter) {
  _getState = stateGetter;

  if (window.Sentry && window.SENTRY_DSN) {
    try {
      window.Sentry.init({
        dsn: window.SENTRY_DSN,
        release: 'sun-stable@v110',
        integrations: [],
      });
    } catch {}
  }

  window.addEventListener('error', (e) => {
    push({
      ts: new Date().toISOString(),
      type: 'error',
      msg: e.message,
      file: e.filename,
      line: e.lineno,
      stack: e.error?.stack,
      state: safeState(),
      ua: navigator.userAgent,
      _err: e.error,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const err = e.reason;
    push({
      ts: new Date().toISOString(),
      type: 'rejection',
      msg: err?.message || String(err),
      stack: err?.stack,
      state: safeState(),
      ua: navigator.userAgent,
      _err: err instanceof Error ? err : null,
    });
  });

  window.__sunLog = () => {
    try { return JSON.parse(localStorage.getItem(RING_KEY) || '[]'); } catch { return []; }
  };
  window.__sunClearLog = () => {
    try { localStorage.removeItem(RING_KEY); } catch {}
    console.log('Error log cleared.');
  };
}

export function captureError(err, context = {}) {
  push({
    ts: new Date().toISOString(),
    type: 'caught',
    msg: err?.message || String(err),
    stack: err?.stack,
    state: safeState(),
    ...context,
    _err: err instanceof Error ? err : null,
  });
}
