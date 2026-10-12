// pack.js — measured elements in, shader uniform buffers out. Pure: no DOM, no GL.
//
// The host measures every [data-glass] element and hands the list here. Two kinds:
//   pane    a sheet of glass
//   button  its own piece of glass, flush-mounted in a hole in a pane
// Panes are packed first so that when there are more elements than the shader can
// hold, it is buttons that fall back to their CSS skin, never a whole pane.

export const MAX_ELEMENTS = 32;

const ok = (it) =>
  it && [it.left, it.top, it.width, it.height].every(Number.isFinite) && it.width >= 6 && it.height >= 6;

export function packElements(items, { scale, bufferHeight }) {
  const valid = items.map((it, index) => ({ it, index })).filter((e) => ok(e.it));
  const sortedE = [...valid.filter((e) => e.it.kind !== 'button'), ...valid.filter((e) => e.it.kind === 'button')];
  const keptE = sortedE.slice(0, MAX_ELEMENTS);
  const sorted = sortedE.map((e) => e.it);
  const kept = keptE.map((e) => e.it);

  const out = {
    count: kept.length,
    kept: keptE.map((e) => e.index),   // positions in the input list, in packed order
    dropped: sorted.length - kept.length,
    rect: new Float32Array(MAX_ELEMENTS * 4),
    rad: new Float32Array(MAX_ELEMENTS),
    kind: new Float32Array(MAX_ELEMENTS),
    frost: new Float32Array(MAX_ELEMENTS),
    absorb: new Float32Array(MAX_ELEMENTS * 3),
    press: new Float32Array(MAX_ELEMENTS),
    parent: new Int8Array(MAX_ELEMENTS).fill(-1),
  };

  kept.forEach((it, i) => {
    out.rect[i * 4]     = (it.left + it.width / 2) * scale;
    out.rect[i * 4 + 1] = bufferHeight - (it.top + it.height / 2) * scale;   // flip to GL origin
    out.rect[i * 4 + 2] = (it.width / 2) * scale;
    out.rect[i * 4 + 3] = (it.height / 2) * scale;
    out.rad[i] = Math.min(it.radius || 0, it.width / 2, it.height / 2) * scale;
    out.kind[i] = it.kind === 'button' ? 1 : 0;
    out.frost[i] = it.frost || 0;
    const a = it.absorb || [0, 0, 0];
    out.absorb[i * 3] = a[0]; out.absorb[i * 3 + 1] = a[1]; out.absorb[i * 3 + 2] = a[2];
    out.press[i] = it.press || 0;
  });

  // A button's parent is the pane that contains its centre.
  kept.forEach((b, i) => {
    if (b.kind !== 'button') return;
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const p = kept.findIndex((q) => q.kind !== 'button'
      && cx >= q.left && cx <= q.left + q.width && cy >= q.top && cy <= q.top + q.height);
    out.parent[i] = p;
  });
  return out;
}
