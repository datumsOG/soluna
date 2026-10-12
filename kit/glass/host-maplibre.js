// host-maplibre.js — the glass core as a MapLibre CustomLayer.
//
// Lives INSIDE the map's own WebGL context: a second context plus
// preserveDrawingBuffer is what killed the map on iOS (liquid-glass.md, failure 1).
// render() runs after the map has drawn its frame. We copy that frame to a texture
// (copyTexSubImage2D, a GPU-to-GPU blit) and refract it through every [data-glass]
// element. The DOM stays crisp on top.
//
// Markup:
//   data-glass              a pane
//   data-glass="clear"      a pane with no frost
//   data-glass="button"     a flush-mounted glass button (must sit inside a pane;
//                           one that does not is drawn as a small pane)
//   data-tint="ruby|#hex"   stained glass, on a pane or a button
//
// body.lg is set only after the first frame the shader has actually drawn, and is
// removed on context loss, so CSS keeps an ordinary fallback whenever there is no
// glass on screen (failure 2).

import { shaderSource } from './core.glsl.js?v=1.0.0';
import { packElements, MAX_ELEMENTS } from './pack.js?v=1.0.0';
import { absorption, inkFor, PALETTE } from './tint.js?v=1.0.0';
import { PARAMS } from './tokens.js?v=1.0.0';

// The default optics are tokens (src/tokens.json -> tokens.js): Blair's profile,
// approved on the bench 2026-10-09. Lengths are CSS px and are multiplied by the
// device scale in render(). What each one does is described in the bench
// (bench/bench.js) and in docs/liquid-glass.md.
export const DEFAULT_PARAMS = PARAMS;

const PRESS_MS = 120;

// `backdrop` is how bright the map behind the glass is (linear, 0..1); it decides
// whether a label on stained glass is white or black. 0.05 suits a dark map; a light
// theme should pass something near 0.8.
export function createGlassLayer({ params = {}, palette = PALETTE, backdrop = 0.05 } = {}) {
  let gl = null, prog = null, quad = null, tex = null, map = null;
  let texW = 0, texH = 0, lastT = 0, hadDropped = false, filled = false, handed = false;
  const radCache = new WeakMap();     // element -> css border-radius
  const tintCache = new WeakMap();    // element -> { key, absorb }
  const pressNow = new WeakMap();     // element -> eased 0..1
  const meta = new Float32Array(MAX_ELEMENTS * 4);

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('glass shader: ' + gl.getShaderInfoLog(s));
    return s;
  }

  const UNI = ['u_tex', 'u_res', 'u_count', 'u_spread', 'u_curve', 'u_amp', 'u_blurK', 'u_base', 'u_rim',
    'u_spec', 'u_fres', 'u_shadow', 'u_gap', 'u_ring', 'u_seam', 'u_seat', 'u_density', 'u_rimSat', 'u_body'];


  const KICK_EVENTS = ['ember:moved', 'pointerdown', 'pointerup', 'pointercancel'];
  let onLost = null, dead = false, until = 0, ticking = false;
  // The map only redraws when it has a reason to. A control that moves (a toggle
  // sliding, a press easing) needs the glass to follow for a moment.
  function kick() {
    until = performance.now() + 350;
    if (ticking || !map) return;
    ticking = true;
    const tick = () => {
      if (map) map.triggerRepaint();
      if (performance.now() < until) requestAnimationFrame(tick); else ticking = false;
    };
    requestAnimationFrame(tick);
  }

  function teardown(why) {
    layer.ok = false; layer.lastError = why; prog = null; tex = null; quad = null;
    texW = texH = 0; layer.panes = layer.buttons = layer.dropped = 0; handed = false;
    document.body.classList.remove('lg');
    document.querySelectorAll('[data-glass-off]').forEach((el) => el.removeAttribute('data-glass-off'));
  }

  function init() {
    if (dead) return;
    teardown('');
    try {
      if (new URLSearchParams(location.search).get('glassfail') === '1') throw new Error('forced by ?glassfail=1');
      const { vert, frag } = shaderSource(MAX_ELEMENTS);
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vert));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('glass link: ' + gl.getProgramInfoLog(p));
      p.loc = { a_ndc: gl.getAttribLocation(p, 'a_ndc') };
      for (const u of UNI) p.loc[u] = gl.getUniformLocation(p, u);
      p.loc.u_rect = gl.getUniformLocation(p, 'u_rect[0]');
      p.loc.u_meta = gl.getUniformLocation(p, 'u_meta[0]');
      p.loc.u_absorb = gl.getUniformLocation(p, 'u_absorb[0]');
      // Create only. Nothing is BOUND here: MapLibre caches which buffer and texture
      // are bound and marks that cache dirty only around render(). Binding in init()
      // made MapLibre upload its own vertex data into our quad (seen 2026-10-09 as
      // glass drawn in a clipped triangle). Buffers are filled on the first render().
      quad = gl.createBuffer();
      tex = gl.createTexture();
      filled = false;
      prog = p;
      layer.ok = true;
      // body.lg is NOT set here. A linked shader is not a drawn frame: after a context
      // restore the map may never draw again, and then glass-skin controls would be
      // bare labels on nothing. render() sets it after the first frame it really draws
      // (liquid-glass.md, failure 2).
    } catch (e) {
      teardown(String((e && e.message) || e));
      console.warn('[glass]', e);
    }
  }

  const layer = {
    id: 'glass', type: 'custom', renderingMode: '2d',
    ok: false, lastError: '', panes: 0, buttons: 0, dropped: 0,
    params: { ...DEFAULT_PARAMS, ...params },
    palette: { ...palette },

    repaint() { if (map) map.triggerRepaint(); },
    // Edited the palette? Cached absorptions are keyed on the tint string AND the
    // colour it resolved to, so this is only needed to force an immediate redraw.
    readout() {
      return { ok: layer.ok, error: layer.lastError, panes: layer.panes, buttons: layer.buttons, dropped: layer.dropped };
    },

    onAdd(m, glc) {
      map = m; gl = glc;
      init();
      // iOS can drop the WebGL context when a tab sits in the background. Everything
      // made in init() is dead after that, so the controls go back to their CSS skin.
      // The glass then STAYS off until the page is reloaded: re-initialising inside a
      // restored MapLibre context drew a clipped, half-covered pane in testing
      // (2026-10-09, simulated with WEBGL_lose_context), and a well is always usable.
      const canvas = map.getCanvas();
      onLost = () => { dead = true; teardown('WebGL context lost; reload to bring the glass back'); };
      canvas.addEventListener('webglcontextlost', onLost);
      for (const ev of KICK_EVENTS) document.addEventListener(ev, kick, { passive: true });
    },

    onRemove() {
      const canvas = map && map.getCanvas();
      if (canvas) {
        canvas.removeEventListener('webglcontextlost', onLost);
      }
      for (const ev of KICK_EVENTS) document.removeEventListener(ev, kick);
      teardown('');
    },

    render() {
      if (!prog || !layer.ok || gl.isContextLost()) return;
      const P = layer.params;
      const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
      const canvas = map.getCanvas();
      const scale = bw / (canvas.clientWidth || window.innerWidth);

      // Nothing is glass until the UI has been revealed (see Pulse's boot fade).
      const ui = document.getElementById('ui');
      if (ui && !ui.classList.contains('ready')) { layer.panes = layer.buttons = 0; return; }

      const now = performance.now();
      const dt = lastT ? Math.min(now - lastT, 100) : 16;
      lastT = now;
      let easing = false;

      const items = [], itemEls = [];
      const els = document.querySelectorAll('[data-glass]');
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (el.hidden) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) continue;
        const isButton = el.dataset.glass === 'button';

        let cssR = radCache.get(el);
        if (cssR === undefined) { cssR = parseFloat(getComputedStyle(el).borderRadius) || 16; radCache.set(el, cssR); }

        const tintName = el.dataset.tint || '';
        const key = tintName + '|' + (layer.palette[tintName] || '') + '|' + P.density.toFixed(2);
        let tc = tintCache.get(el);
        if (!tc || tc.key !== key) {
          tc = { key, absorb: absorption(tintName, layer.palette) };
          tintCache.set(el, tc);
          // Tell the element which ink reads on its glass: black on pale tints.
          // Only real stained glass gets an opinion; an unknown tint name draws clear.
          // A clear BUTTON resets the variable so it cannot inherit a stained pane's ink.
          const stained = tc.absorb[0] + tc.absorb[1] + tc.absorb[2] > 0;
          if (stained) el.style.setProperty('--e-glass-ink', inkFor(tintName, P.density, layer.palette, backdrop));
          else if (isButton) el.style.setProperty('--e-glass-ink', 'initial');
          else el.style.removeProperty('--e-glass-ink');
        }

        let press = 0;
        if (isButton) {
          const target = el.matches(':active') || el.dataset.pressed === '1' ? 1 : 0;
          const cur = pressNow.get(el) || 0;
          press = cur + (target - cur) * Math.min(1, dt / PRESS_MS);
          if (Math.abs(target - press) < 0.01) press = target; else easing = true;
          pressNow.set(el, press);
        }

        itemEls.push(el);
        items.push({
          left: r.left, top: r.top, width: r.width, height: r.height, radius: cssR,
          kind: isButton ? 'button' : 'pane',
          frost: isButton || el.dataset.glass === 'clear' ? 0 : P.frost,
          absorb: tc.absorb, press,
        });
      }

      const k = packElements(items, { scale, bufferHeight: bh });
      let panes = 0, buttons = 0;
      for (let i = 0; i < k.count; i++) {
        // A button with no pane under it is drawn as a small pane, never as a hole
        // cut in nothing.
        const kind = k.kind[i] === 1 && k.parent[i] >= 0 ? 1 : 0;
        if (kind) buttons++; else panes++;
        meta[i * 4] = k.rad[i]; meta[i * 4 + 1] = kind; meta[i * 4 + 2] = k.frost[i]; meta[i * 4 + 3] = k.press[i];
      }
      layer.panes = panes; layer.buttons = buttons; layer.dropped = k.dropped;
      // More glass than the shader holds: the buttons that did not fit get their
      // CSS skin back (data-glass-off), so they are wells rather than bare labels.
      if (k.dropped || hadDropped) {
        const off = new Set();
        const keptSet = new Set(k.kept);
        itemEls.forEach((el, i) => { if (!keptSet.has(i)) off.add(el); });
        // Clear from the whole document, not only what was measured this frame, or an
        // element hidden at the moment the overflow ends keeps the attribute for good.
        document.querySelectorAll('[data-glass-off]').forEach((el) => { if (!off.has(el)) el.removeAttribute('data-glass-off'); });
        off.forEach((el) => el.setAttribute('data-glass-off', ''));
        hadDropped = k.dropped > 0;
      }
      if (!k.count) return;

      // Copy the finished frame BEFORE drawing, so the sample is the clean map.
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      if (!filled) {
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        filled = true;
      }
      if (bw !== texW || bh !== texH) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, bw, bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        texW = bw; texH = bh;
      }
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, bw, bh);

      const L = prog.loc;
      gl.useProgram(prog);
      gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
      gl.enable(gl.BLEND);
      // colour blends normally; alpha only ever accumulates, so the canvas stays opaque
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(L.u_tex, 0);
      gl.uniform2f(L.u_res, bw, bh);
      gl.uniform1i(L.u_count, k.count);
      gl.uniform4fv(L.u_rect, k.rect);
      gl.uniform4fv(L.u_meta, meta);
      gl.uniform3fv(L.u_absorb, k.absorb);
      gl.uniform1f(L.u_spread, P.spread * scale);
      gl.uniform1f(L.u_curve, P.curve);
      gl.uniform1f(L.u_amp, P.amp * scale);
      gl.uniform1f(L.u_blurK, P.edgeBlur * scale);
      gl.uniform1f(L.u_base, P.centreBlur * scale);
      gl.uniform1f(L.u_rim, P.rim);
      gl.uniform1f(L.u_spec, P.spec);
      gl.uniform1f(L.u_fres, P.fresnel);
      gl.uniform1f(L.u_shadow, P.shadow);
      gl.uniform1f(L.u_gap, P.gap * scale);
      gl.uniform1f(L.u_ring, P.ring * scale);
      gl.uniform1f(L.u_seam, P.seam);
      gl.uniform1f(L.u_seat, P.seat);
      gl.uniform1f(L.u_density, P.density);
      gl.uniform1f(L.u_rimSat, P.rimSat);
      gl.uniform1f(L.u_body, P.body);
      gl.enableVertexAttribArray(L.a_ndc);
      gl.vertexAttribPointer(L.a_ndc, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthMask(true);
      if (!handed) { handed = true; document.body.classList.add('lg'); }

      if (easing) map.triggerRepaint();   // keep drawing until a press has settled
    },
  };
  return layer;
}
