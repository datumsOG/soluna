// tint.js — stained glass. Pure: no DOM, no GL.
//
// Colour is absorption, not an overlay (Beer-Lambert): light that travels a path p
// through glass of density d comes out multiplied by exp(-a * d * p) per channel.
// `a` is chosen so that at d = 1, p = 1, white light comes out exactly the named
// colour. A longer path (the rim, where light crosses the glass obliquely) is
// therefore more saturated: pale through the face, deep at the edge. The shader
// (core.glsl.js) uses the same formula.

// The default palette is a token (src/tokens.json -> tokens.js).
import { PALETTE } from './tokens.js?v=1.0.0';
export { PALETTE };

const FLOOR = 0.002;   // keeps a zero channel finite (absorption tops out near 6.2)
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const warned = new Set();

function parse(nameOrHex, palette) {
  if (typeof nameOrHex !== 'string' || !nameOrHex) return null;
  const hex = (palette && palette[nameOrHex]) || nameOrHex;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  const m = /^#([0-9a-f]{6})$/i.exec(short ? '#' + short[1] + short[1] + short[2] + short[2] + short[3] + short[3] : hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255));
}

export function absorption(nameOrHex, palette = PALETTE) {
  const lin = parse(nameOrHex, palette);
  if (!lin) {
    const key = String(nameOrHex);
    if (nameOrHex && !warned.has(key)) { warned.add(key); console.warn('[glass] unknown tint, drawing clear:', key); }
    return [0, 0, 0];
  }
  return lin.map((v) => -Math.log(Math.max(v, FLOOR)));
}

export function transmitted(absorb, density, path = 1) {
  return absorb.map((a) => Math.exp(-a * density * path));
}

// White unless white would be hard to read on this glass; then black. `backdrop` is
// the brightness (linear, 0..1) of what the glass sits over: 1 is the worst case, a
// white page; a dark map is nearer 0.35, and there even amber glass is dark enough
// for white. 3:1 is the WCAG floor for large or bold text, which a control label is.
export function inkFor(nameOrHex, density, palette = PALETTE, backdrop = 1) {
  const [r, g, b] = transmitted(absorption(nameOrHex, palette), density).map((v) => v * backdrop);
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (L + 0.05) < 3 ? '#000' : '#fff';
}
