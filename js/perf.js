// Performance switches and a live meter.
//
// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-15, Blair: "That app is also not smooth the way it can sometimes be,
// probably too resource intensive. See what's using up all the processing power
// and give me some options to lighten the load, even if it means losing some of
// the cool stuff."
//
// I cannot profile his phone from here, so this ships the measurement AND the
// switches. Reading the code first, the costs in descending order of suspicion:
//
// 1. THE APP NEVER GOES IDLE. MapLibre only repaints when something changes —
//    except that two rAF loops (the shadow-arc comet in layers/shadow.js and the
//    sun-ray comet in layers/sun-path.js) call setPaintProperty(line-gradient)
//    on EVERY frame. Each call re-uploads that line's gradient ramp and marks the
//    map dirty, so the entire scene — 3D buildings, terrain, every custom layer —
//    re-renders at 60fps forever, on a still map, until the tab is closed.
//    Everything below is a consequence of this one being true.
//
// 2. THE GLASS LAYER IS A FULL-SCREEN PASS. layers/glass.js does a
//    copyTexSubImage2D of the whole framebuffer and then a full-screen refraction
//    shader with a multi-tap blur, every frame the map renders. At DPR 3 that is
//    a lot of fill rate for a dock. It also calls getBoundingClientRect() on
//    every [data-glass] element per frame, which forces layout.
//
// 3. MSAA + DEVICE PIXEL RATIO. map.js asks for antialias:true, and MapLibre
//    otherwise renders at the full devicePixelRatio — 3 on his iPhone. Hardware
//    MSAA over 3D extrusions at 3x is the most expensive combination available.
//
// Toggles, appended to the URL:
//   ?perf=1     show the meter
//   ?pulse=0    stop the two travelling comets — expected to be the big one
//   ?glass=0    flat UI panels instead of real refraction
//   ?msaa=0     no hardware antialiasing
//   ?dpr=1      render at 1x instead of the device's ratio (2 = cap at 2x)
//   ?light=1    all of the above at once
// ─────────────────────────────────────────────────────────────────────────────

const Q = new URLSearchParams(location.search);
const num = (k, dflt) => (Q.has(k) && isFinite(parseFloat(Q.get(k))) ? parseFloat(Q.get(k)) : dflt);
const LIGHT = num('light', 0) === 1;

export const PERF = {
  meter: num('perf', 0) === 1,
  // Defaults changed 2026-09-15, both deliberately:
  //   pulse stays ON but is throttled and now stops when the app is idle, so the
  //   map can finally settle; dpr is capped at 2 because the third x costs ~44%
  //   more fragments for a difference nobody has ever reported seeing.
  pulse: LIGHT ? 0 : num('pulse', 1),
  pulseFps: num('pulsefps', 30),
  pulseIdleMs: num('pulseidle', 45000),
  glass: LIGHT ? 0 : num('glass', 1),
  msaa: LIGHT ? 0 : num('msaa', 1),
  dpr: num('dpr', 2),
};

// ── the meter ────────────────────────────────────────────────────────────────
const marks = Object.create(null);
let el = null, frames = 0, renders = 0, lastT = 0, fps = 0, rps = 0;

export function countRender() { renders++; }

/** Time a named phase. `perfMark('glass')` returns a function you call when done. */
export function perfMark(name) {
  if (!PERF.meter) return () => {};
  const t0 = performance.now();
  return () => {
    const dt = performance.now() - t0;
    const m = marks[name] || (marks[name] = { ms: 0, n: 0, last: 0 });
    m.ms += dt; m.n++; m.last = dt;
  };
}

export function initPerfMeter() {
  if (!PERF.meter) return;
  el = document.createElement('div');
  el.id = 'perf-meter';
  el.style.cssText = [
    'position:fixed', 'top:calc(env(safe-area-inset-top) + 8px)', 'left:8px', 'z-index:9999',
    'font:11px/1.35 ui-monospace,Menlo,monospace', 'color:#9fe6b0',
    'background:rgba(0,0,0,0.72)', 'padding:6px 8px', 'border-radius:8px',
    'pointer-events:none', 'white-space:pre', 'border:1px solid rgba(159,230,176,0.25)',
  ].join(';');
  document.body.appendChild(el);

  const tick = (t) => {
    frames++;
    if (t - lastT >= 500) {
      const secs = (t - lastT) / 1000;
      fps = frames / secs; rps = renders / secs;
      frames = 0; renders = 0; lastT = t;
      const rows = [
        `fps      ${fps.toFixed(0)}`,
        `map draw ${rps.toFixed(0)}/s${rps > 5 ? '  <-- never idle' : ''}`,
        `dpr      ${PERF.dpr}   msaa ${PERF.msaa ? 'on' : 'off'}`,
        `pulse    ${PERF.pulse ? PERF.pulseFps + 'fps' : 'off'}   glass ${PERF.glass ? 'on' : 'off'}`,
      ];
      for (const k of Object.keys(marks)) {
        const m = marks[k];
        rows.push(`${k.padEnd(8)} ${(m.ms / Math.max(1, m.n)).toFixed(2)}ms x${m.n}`);
        m.ms = 0; m.n = 0;
      }
      el.textContent = rows.join('\n');
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── idle tracking, shared by both comet loops ────────────────────────────────
let lastInteract = performance.now();
export function noteInteraction() { lastInteract = performance.now(); }
export function idleMs() { return performance.now() - lastInteract; }
