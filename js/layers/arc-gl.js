// WebGL custom layer for all 3D overlay geometry: the sun/moon arc, the live
// body dot + drop line (single colour), AND the shadow graphics (per-colour
// markers + line segments). Drawn inside the MapLibre 3D scene at true world
// altitude so the opaque buildings occlude them via the GPU depth buffer.
//
// Lines are rendered as screen-space-expanded QUADS (not gl.LINES, which is 1px
// on most hardware) so they have real, adjustable thickness while keeping the
// centre-line depth for correct occlusion. A small depth bias pulls markers /
// lines slightly toward the camera so a marker placed ON a building surface
// (e.g. an observation deck) doesn't z-fight/flicker with that surface.

const LAYER_ID = 'arc-gl';

let _gl = null;
let _dotProgram = null;     // arc dots + live dot (uniform colour)
let _cdotProgram = null;    // shadow markers (per-vertex colour)
let _lineProgram = null;    // thick per-vertex-colour line quads (drop + segments)

let _arcBuf = null, _liveBuf = null, _dropBuf = null, _markBuf = null, _segBuf = null, _groundBuf = null, _obsBuf = null;
let _arcCount = 0, _liveCount = 0, _dropCount = 0, _markCount = 0, _segCount = 0, _groundCount = 0, _obsCount = 0;

let _color = [1.0, 0.722, 0.27];   // gold (#ffb845); moon = bluish
let _visible = true;
let _zoomScale = 1;
let _lastMatrix = null;            // projection matrix MapLibre hands us each frame
const _dpr = Math.min(window.devicePixelRatio || 1, 2);
const SEG_WIDTH = 7.0;             // shadow/beam line thickness (CSS px)
const DROP_WIDTH = 6.0;            // drop-line thickness (CSS px)

let _arcPending = null, _livePending = null, _dropPending = null, _markPending = null, _segPending = null, _groundPending = null, _obsPending = null;
let _dropA = null, _dropB = null;  // remembered so a colour change can rebuild the drop quad
let _map = null;

// ── Shaders (WebGL1) ─────────────────────────────────────────────────────────
// Soft round dot, single uniform colour.
const DOT_VERT = `
attribute vec3 a_pos;
attribute float a_size;
uniform mat4 u_matrix;
uniform float u_dpr;
uniform float u_zoomScale;
uniform float u_bias;
uniform float u_wRef;
void main() {
  vec4 clip = u_matrix * vec4(a_pos, 1.0);
  // Perspective size: points nearer the camera (smaller clip.w than the map
  // centre's reference w) grow; farther ones shrink. So close-up suns read large.
  float persp = clamp(u_wRef / max(clip.w, 0.0001), 0.6, 3.2);
  clip.z -= u_bias * clip.w;
  gl_Position = clip;
  gl_PointSize = clamp(a_size * u_zoomScale * persp, 3.0, 42.0) * u_dpr;
}`;
const DOT_FRAG = `
precision mediump float;
uniform vec3 u_color;
uniform float u_alpha;
uniform float u_pulse;   // 0 = arc bead, 1 = live body showpiece (big corona + hotter)
void main() {
  // Treat the point sprite as a lit sphere: reconstruct a surface normal from the
  // sprite coords (z = height of the hemisphere) and light it from upper-left so
  // the orb reads as 3D — a hot offset highlight, a brighter lit face, a soft limb
  // and a faint corona rim. Emissive (never fully dark) since it's a sun/moon.
  vec2 d = (gl_PointCoord - vec2(0.5)) * 2.0;   // -1..1
  float r = length(d);
  if (r > 1.0) discard;
  float z = sqrt(max(0.0, 1.0 - r * r));        // sphere surface height
  vec3 n = vec3(d.x, d.y, z);
  vec3 L = normalize(vec3(-0.45, -0.5, 0.75));  // key light, upper-left toward viewer
  float lambert = clamp(dot(n, L), 0.0, 1.0);
  float hot = pow(lambert, 2.2);                // tight specular-ish hotspot
  float body = 0.4 + 0.6 * lambert;             // emissive body, lit side brighter
  float limb = smoothstep(1.0, 0.55, r);        // soft sphere edge
  float corona = smoothstep(1.0, 0.82, r) * 0.5;// rim / atmosphere brightening
  vec3 col = mix(u_color, vec3(1.0), hot * 0.9);
  float a = limb * body + corona;
  // Soft corona halo scaled by u_pulse: every bead gets some (drama for the
  // now-fewer suns), the live body gets the full showpiece amount.
  a += smoothstep(1.0, 0.0, r) * 0.4 * u_pulse;
  col = mix(col, vec3(1.0), 0.18 * u_pulse);
  gl_FragColor = vec4(col, a * u_alpha);
}`;

// Soft round dot, per-vertex colour (shadow markers).
const CDOT_VERT = `
attribute vec3 a_pos;
attribute float a_size;
attribute vec3 a_color;
uniform mat4 u_matrix;
uniform float u_dpr;
uniform float u_zoomScale;
uniform float u_bias;
uniform float u_wRef;
varying vec3 v_color;
void main() {
  vec4 clip = u_matrix * vec4(a_pos, 1.0);
  float persp = clamp(u_wRef / max(clip.w, 0.0001), 0.6, 3.2);
  clip.z -= u_bias * clip.w;
  gl_Position = clip;
  gl_PointSize = clamp(a_size * u_zoomScale * persp, 4.0, 44.0) * u_dpr;
  v_color = a_color;
}`;
const CDOT_FRAG = `
precision mediump float;
varying vec3 v_color;
uniform float u_alpha;
void main() {
  // Same lit-sphere model as DOT_FRAG, per-vertex colour (caster sphere, shadow-end
  // and observer markers now read as little glowing 3D orbs).
  vec2 d = (gl_PointCoord - vec2(0.5)) * 2.0;
  float r = length(d);
  if (r > 1.0) discard;
  float z = sqrt(max(0.0, 1.0 - r * r));
  vec3 n = vec3(d.x, d.y, z);
  vec3 L = normalize(vec3(-0.45, -0.5, 0.75));
  float lambert = clamp(dot(n, L), 0.0, 1.0);
  float hot = pow(lambert, 2.2);
  float body = 0.4 + 0.6 * lambert;
  float limb = smoothstep(1.0, 0.55, r);
  float corona = smoothstep(1.0, 0.82, r) * 0.5;
  vec3 col = mix(v_color, vec3(1.0), hot * 0.85);
  gl_FragColor = vec4(col, (limb * body + corona) * u_alpha);
}`;

// Thick line: expand each endpoint perpendicular to the segment in screen space.
const LINE_VERT = `
attribute vec3 a_pos;
attribute vec3 a_other;
attribute float a_side;
attribute vec3 a_color;
attribute float a_flow;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_width;
uniform float u_dpr;
uniform float u_bias;
varying vec3 v_color;
varying float v_edge;
varying float v_flow;
void main() {
  vec4 clipT = u_matrix * vec4(a_pos, 1.0);
  vec4 clipO = u_matrix * vec4(a_other, 1.0);
  vec2 ndcT = clipT.xy / clipT.w;
  vec2 ndcO = clipO.xy / clipO.w;
  vec2 sT = ndcT * 0.5 * u_viewport;
  vec2 sO = ndcO * 0.5 * u_viewport;
  vec2 dir = sO - sT;
  float len = length(dir);
  dir = len > 0.0001 ? dir / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 offPx = perp * a_side * (u_width * 0.5 * u_dpr);
  vec2 offNdc = offPx / (0.5 * u_viewport);
  float z = clipT.z - u_bias * clipT.w;
  gl_Position = vec4((ndcT + offNdc) * clipT.w, z, clipT.w);
  v_color = a_color;
  v_edge = a_side;   // -1..+1 across the line width, 0 at the centre
  v_flow = a_flow;   // 0..1 along a beam, or -1 for non-flowing segments
}`;
const LINE_FRAG = `
precision mediump float;
varying vec3 v_color;
varying float v_edge;
varying float v_flow;
uniform float u_alpha;
uniform float u_time;   // seconds * speed; the comet head is fract(u_time)
void main() {
  // Edge feather. With hardware MSAA now on (map antialias:true), the quad's geometry
  // edge is smoothed by the GPU, so we keep the fill mostly solid (crisp, clean line)
  // and only lightly feather the rim. Fragment stays limited to the identifiers v73
  // rendered with — adding any new uniform/varying here blanked the line on-device.
  float aa = smoothstep(1.0, 0.62, abs(v_edge));
  vec3 col = v_color;
  float boost = 0.0;
  // Comet of light pouring down the beam (sky → caster → ground): a bright window
  // sweeping flow 0→1, plus a short trailing tail behind it.
  if (v_flow >= 0.0) {
    float head = fract(u_time);
    float d = head - v_flow;                 // >0 means the head has passed this point
    float tail = exp(-max(d, 0.0) * 9.0);    // shorter glowing tail behind the head
    float core = smoothstep(0.08, 0.0, abs(d));
    boost = max(core * 0.4, tail * 0.18);    // toned down so the comet doesn't read as a stringy bright thread
    col = mix(col, vec3(1.0), boost * 0.45);
  }
  gl_FragColor = vec4(col, aa * (u_alpha + boost * 0.45));
}`;

function _compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn('arc-gl shader:', gl.getShaderInfoLog(sh)); gl.deleteShader(sh); return null; }
  return sh;
}
function _link(gl, vsSrc, fsSrc) {
  const vs = _compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = _compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn('arc-gl link:', gl.getProgramInfoLog(p)); gl.deleteProgram(p); return null; }
  p._loc = {
    a_pos: gl.getAttribLocation(p, 'a_pos'), a_size: gl.getAttribLocation(p, 'a_size'),
    a_color: gl.getAttribLocation(p, 'a_color'), a_other: gl.getAttribLocation(p, 'a_other'),
    a_side: gl.getAttribLocation(p, 'a_side'), a_flow: gl.getAttribLocation(p, 'a_flow'),
    u_time: gl.getUniformLocation(p, 'u_time'),
    u_matrix: gl.getUniformLocation(p, 'u_matrix'), u_dpr: gl.getUniformLocation(p, 'u_dpr'),
    u_zoomScale: gl.getUniformLocation(p, 'u_zoomScale'), u_color: gl.getUniformLocation(p, 'u_color'),
    u_alpha: gl.getUniformLocation(p, 'u_alpha'), u_viewport: gl.getUniformLocation(p, 'u_viewport'),
    u_width: gl.getUniformLocation(p, 'u_width'), u_bias: gl.getUniformLocation(p, 'u_bias'),
    u_wRef: gl.getUniformLocation(p, 'u_wRef'), u_pulse: gl.getUniformLocation(p, 'u_pulse'),
  };
  return p;
}

function _merc(lon, lat, altM) {
  const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], altM || 0);
  return [m.x, m.y, m.z];
}
function _triggerRepaint() { if (_map) try { _map.triggerRepaint(); } catch {} }

// Expand a list of segments into thick-line quad geometry.
// Per vertex: x,y,z, ox,oy,oz, side, r,g,b, flow  (stride 11 floats). 6 verts / segment.
// `flow` is a 0..1 parameter along a beam (s.fa at a, s.fb at b) used by the comet
// shader; -1 means "this segment does not flow".
function _buildLineQuads(segs) {
  const out = new Float32Array(segs.length * 6 * 11);
  let o = 0;
  const V = (t, oth, side, c, fl) => {
    out[o++]=t[0]; out[o++]=t[1]; out[o++]=t[2];
    out[o++]=oth[0]; out[o++]=oth[1]; out[o++]=oth[2];
    out[o++]=side; out[o++]=c[0]; out[o++]=c[1]; out[o++]=c[2]; out[o++]=fl;
  };
  for (const s of segs) {
    const A = _merc(s.a.lon, s.a.lat, s.a.altM || 0);
    const B = _merc(s.b.lon, s.b.lat, s.b.altM || 0);
    // "Other" for the B vertices continues the A→B direction (2B−A) so the vertex
    // shader computes the SAME perpendicular at both ends. Passing A here (the old code)
    // flipped the perpendicular at B, which made `side` (reused as the feather coord
    // v_edge) inconsistent: the long edges got no feather (aliased) and the quad's
    // diagonal sat at v_edge=+1 → feathered to transparent → a dark seam through the
    // beam. With a consistent perpendicular, v_edge runs a clean −1→+1 across the width.
    const Bo = [2 * B[0] - A[0], 2 * B[1] - A[1], 2 * B[2] - A[2]];
    const c = s.color || [1, 1, 1];
    const fa = (s.fa == null ? -1 : s.fa), fb = (s.fb == null ? -1 : s.fb);
    V(A, B, -1, c, fa); V(A, B, 1, c, fa); V(B, Bo, -1, c, fb);
    V(B, Bo, -1, c, fb); V(A, B, 1, c, fa); V(B, Bo, 1, c, fb);
  }
  return out;
}

// ── Public data setters ──────────────────────────────────────────────────────
export function setArcPoints(points) {
  _arcCount = points ? points.length : 0;
  if (!_arcCount) { _arcPending = new Float32Array(0); _uploadArc(); return; }
  const a = new Float32Array(_arcCount * 4);
  for (let i = 0; i < _arcCount; i++) {
    const p = points[i]; const [x, y, z] = _merc(p.lon, p.lat, p.altM);
    a[i*4]=x; a[i*4+1]=y; a[i*4+2]=z; a[i*4+3]=p.sizePx || 6;
  }
  _arcPending = a; _uploadArc();
}
export function setLivePoint(live) {
  if (!live) { _liveCount = 0; _livePending = new Float32Array(0); _uploadLive(); return; }
  const [x, y, z] = _merc(live.lon, live.lat, live.altM);
  _livePending = new Float32Array([x, y, z, live.sizePx || 18]); _liveCount = 1; _uploadLive();
}
export function setDropLine(a, b) {
  _dropA = a; _dropB = b;
  if (!a || !b) { _dropCount = 0; _dropPending = new Float32Array(0); _uploadDrop(); return; }
  _dropPending = _buildLineQuads([{ a, b, color: _color }]); _dropCount = 6; _uploadDrop();
}
export function setMarkers(points) {
  _markCount = points ? points.length : 0;
  if (!_markCount) { _markPending = new Float32Array(0); _uploadMark(); return; }
  _markPending = _buildMarks(points); _uploadMark();
}
export function setGroundMarkers(points) {
  _groundCount = points ? points.length : 0;
  if (!_groundCount) { _groundPending = new Float32Array(0); _uploadGround(); return; }
  _groundPending = _buildMarks(points); _uploadGround();
}
// The observer "ground zero" marker — a glowing GL dot (x-ray two-pass) so it
// matches the arc/caster/shadow markers instead of a flat MapLibre circle.
export function setObserverMarker(pt) {
  if (!pt) { _obsCount = 0; _obsPending = new Float32Array(0); _uploadObs(); return; }
  _obsPending = _buildMarks([{ lon: pt.lon, lat: pt.lat, altM: 0, sizePx: pt.sizePx || 16, color: pt.color || [1, 1, 1] }]);
  _obsCount = 1; _uploadObs();
}
function _buildMarks(points) {
  const a = new Float32Array(points.length * 7);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]; const [x, y, z] = _merc(p.lon, p.lat, p.altM); const c = p.color || [1, 1, 1];
    a[i*7]=x; a[i*7+1]=y; a[i*7+2]=z; a[i*7+3]=p.sizePx || 12; a[i*7+4]=c[0]; a[i*7+5]=c[1]; a[i*7+6]=c[2];
  }
  return a;
}
export function setSegments(segs) {
  const n = segs ? segs.length : 0;
  _segCount = n * 6;
  _segPending = n ? _buildLineQuads(segs) : new Float32Array(0);
  _uploadSeg();
}
export function setArcColor(rgb01) {
  if (!rgb01) return;
  _color = rgb01;
  if (_dropA && _dropB) { _dropPending = _buildLineQuads([{ a: _dropA, b: _dropB, color: _color }]); _uploadDrop(); }
}
export function setArcVisible(v) { _visible = !!v; _triggerRepaint(); }

function _upload(buf, pending) { if (_gl && buf && pending) { _gl.bindBuffer(_gl.ARRAY_BUFFER, buf); _gl.bufferData(_gl.ARRAY_BUFFER, pending, _gl.DYNAMIC_DRAW); } _triggerRepaint(); }
function _uploadArc()   { _upload(_arcBuf, _arcPending); }
function _uploadLive()  { _upload(_liveBuf, _livePending); }
function _uploadDrop()  { _upload(_dropBuf, _dropPending); }
function _uploadMark()  { _upload(_markBuf, _markPending); }
function _uploadSeg()   { _upload(_segBuf, _segPending); }
function _uploadGround(){ _upload(_groundBuf, _groundPending); }
function _uploadObs()   { _upload(_obsBuf, _obsPending); }

// ── The MapLibre custom layer ────────────────────────────────────────────────
export const arcLayer = {
  id: LAYER_ID,
  type: 'custom',
  renderingMode: '3d',

  onAdd(map, gl) {
    _map = map; _gl = gl;
    try {
      _dotProgram = _link(gl, DOT_VERT, DOT_FRAG);
      _cdotProgram = _link(gl, CDOT_VERT, CDOT_FRAG);
      _lineProgram = _link(gl, LINE_VERT, LINE_FRAG);
      _arcBuf = gl.createBuffer(); _liveBuf = gl.createBuffer(); _dropBuf = gl.createBuffer();
      _markBuf = gl.createBuffer(); _segBuf = gl.createBuffer(); _groundBuf = gl.createBuffer(); _obsBuf = gl.createBuffer();
      _uploadArc(); _uploadLive(); _uploadDrop(); _uploadMark(); _uploadSeg(); _uploadGround(); _uploadObs();
    } catch (e) { console.warn('arc-gl onAdd failed', e); }
  },

  onRemove() {
    const gl = _gl; if (!gl) return;
    try {
      for (const p of [_dotProgram, _cdotProgram, _lineProgram]) if (p) gl.deleteProgram(p);
      for (const b of [_arcBuf, _liveBuf, _dropBuf, _markBuf, _segBuf, _groundBuf, _obsBuf]) if (b) gl.deleteBuffer(b);
    } catch {}
    _dotProgram = _cdotProgram = _lineProgram = null;
    _arcBuf = _liveBuf = _dropBuf = _markBuf = _segBuf = _groundBuf = _obsBuf = _gl = null;
  },

  render(gl, matrix) {
    _lastMatrix = matrix;
    if (!_visible || !_dotProgram) return;

    const z = _map ? _map.getZoom() : 14;
    _zoomScale = Math.min(1.7, Math.max(0.45, Math.pow(2, (z - 14) * 0.5)));
    const vp = [gl.drawingBufferWidth, gl.drawingBufferHeight];

    // Reference clip-w at the map centre — the per-dot perspective scale divides
    // each point's w by this, so points closer than centre grow and farther shrink.
    let wRef = 1;
    if (_map && maplibregl.MercatorCoordinate) {
      const c = _map.getCenter();
      const cm = maplibregl.MercatorCoordinate.fromLngLat([c.lng, c.lat], 0);
      const w = matrix[3]*cm.x + matrix[7]*cm.y + matrix[11]*cm.z + matrix[15];
      if (w > 0) wRef = w;
    }

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    // ADDITIVE blending: the overlay glows/blooms luminously over the dark
    // buildings (neon look) instead of reading as flat alpha overlays.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

    // ---- Thick lines (drop + shadow segments): x-ray two-pass ----
    // Pass 1 depth-tested (hidden behind buildings) + pass 2 depth-off faint
    // (ghost through buildings) — same treatment as the ground lines, so the
    // pole/sky line dim through buildings instead of vanishing or z-fighting.
    // ghostA > 0 → x-ray (a faint depth-off pass shows the line THROUGH buildings).
    // ghostA = 0 → HARD occlusion: the line is only visible where it has clear
    // line of sight (used by the shadow-arc, so its climb reads with correct depth).
    const drawLines = (buf, count, width, bias, ghostA = 0.30) => {
      if (count <= 0) return;
      const L = _lineProgram._loc;
      gl.useProgram(_lineProgram);
      gl.uniformMatrix4fv(L.u_matrix, false, matrix);
      gl.uniform2fv(L.u_viewport, vp);
      gl.uniform1f(L.u_dpr, _dpr);
      gl.uniform1f(L.u_bias, bias);
      gl.uniform1f(L.u_time, (performance.now() / 1000) * 0.45);  // comet speed (slowed)
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(L.a_pos);   gl.vertexAttribPointer(L.a_pos, 3, gl.FLOAT, false, 44, 0);
      gl.enableVertexAttribArray(L.a_other); gl.vertexAttribPointer(L.a_other, 3, gl.FLOAT, false, 44, 12);
      gl.enableVertexAttribArray(L.a_side);  gl.vertexAttribPointer(L.a_side, 1, gl.FLOAT, false, 44, 24);
      gl.enableVertexAttribArray(L.a_color); gl.vertexAttribPointer(L.a_color, 3, gl.FLOAT, false, 44, 28);
      if (L.a_flow >= 0) { gl.enableVertexAttribArray(L.a_flow); gl.vertexAttribPointer(L.a_flow, 1, gl.FLOAT, false, 44, 40); }
      // Soft additive glow halo (depth-tested), then a SOLID core drawn with normal
      // alpha blending so it reads as one clean opaque line — not the stringy bright
      // additive thread + doubled ghost it used to be.
      gl.enable(gl.DEPTH_TEST);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.uniform1f(L.u_width, width * 2.6); gl.uniform1f(L.u_alpha, 0.14); gl.drawArrays(gl.TRIANGLES, 0, count);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(L.u_width, width);       gl.uniform1f(L.u_alpha, 1.0);  gl.drawArrays(gl.TRIANGLES, 0, count);
      // X-ray ghost (seen through buildings): a single faint additive pass.
      if (ghostA > 0) {
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.disable(gl.DEPTH_TEST);
        gl.uniform1f(L.u_width, width * 1.3); gl.uniform1f(L.u_alpha, ghostA * 0.5); gl.drawArrays(gl.TRIANGLES, 0, count);
        gl.enable(gl.DEPTH_TEST);
      }
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);   // restore additive for the dot passes
    };
    if (_lineProgram) {
      // Zoom-adaptive beam depth bias. The bias is a constant NDC-z shift, but NDC depth is
      // nonlinear: a value big enough to beat the grazing z-fight when zoomed IN maps to a
      // huge REAL-depth pull when zoomed OUT (far geometry clusters near the far plane),
      // which yanked the beams in front of buildings and killed occlusion (the v99 symptom).
      // So ramp it with zoom — small near the z14 floor (occlusion holds when zoomed out),
      // up to the flicker-killing value when zoomed in (z20). Tune the endpoints here.
      const beamBias = 0.0009 + 0.0021 * Math.min(1, Math.max(0, (z - 14) / 6));
      drawLines(_segBuf, _segCount, SEG_WIDTH, beamBias);
      drawLines(_dropBuf, _dropCount, DROP_WIDTH, beamBias);
    }

    // ---- Arc dots (uniform colour) ----
    const D = _dotProgram._loc;
    gl.useProgram(_dotProgram);
    gl.uniformMatrix4fv(D.u_matrix, false, matrix);
    gl.uniform1f(D.u_dpr, _dpr);
    gl.uniform1f(D.u_zoomScale, _zoomScale);
    gl.uniform1f(D.u_wRef, wRef);
    gl.uniform3fv(D.u_color, _color);
    gl.uniform1f(D.u_bias, 0.0004);
    gl.uniform1f(D.u_pulse, 0.45);   // arc beads: a little corona each
    const drawDots = (buf, count, alpha) => {
      if (count <= 0) return;
      gl.uniform1f(D.u_alpha, alpha);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(D.a_pos);  gl.vertexAttribPointer(D.a_pos, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(D.a_size); gl.vertexAttribPointer(D.a_size, 1, gl.FLOAT, false, 16, 12);
      gl.drawArrays(gl.POINTS, 0, count);
    };
    drawDots(_arcBuf, _arcCount, 0.95);

    // ---- Shadow markers + observer dot (per-vertex colour) ----
    if (_cdotProgram && (_markCount > 0 || _groundCount > 0 || _obsCount > 0)) {
      const M = _cdotProgram._loc;
      gl.useProgram(_cdotProgram);
      gl.uniformMatrix4fv(M.u_matrix, false, matrix);
      gl.uniform1f(M.u_dpr, _dpr);
      gl.uniform1f(M.u_zoomScale, _zoomScale);
      gl.uniform1f(M.u_wRef, wRef);
      gl.uniform1f(M.u_bias, 0.0009);
      // Both marker sets use the x-ray two-pass (occluded full + depth-off ghost)
      // so the caster/shadow-end dim through buildings instead of vanishing or
      // z-fighting when they sit inside one.
      const drawMarksXray = (buf, count, ghostA) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(M.a_pos);   gl.vertexAttribPointer(M.a_pos, 3, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(M.a_size);  gl.vertexAttribPointer(M.a_size, 1, gl.FLOAT, false, 28, 12);
        gl.enableVertexAttribArray(M.a_color); gl.vertexAttribPointer(M.a_color, 3, gl.FLOAT, false, 28, 16);
        gl.enable(gl.DEPTH_TEST);  gl.uniform1f(M.u_alpha, 1.0);    gl.drawArrays(gl.POINTS, 0, count);
        gl.disable(gl.DEPTH_TEST); gl.uniform1f(M.u_alpha, ghostA); gl.drawArrays(gl.POINTS, 0, count);
        gl.enable(gl.DEPTH_TEST);
      };
      if (_markCount > 0)   drawMarksXray(_markBuf, _markCount, 0.32);
      if (_groundCount > 0) drawMarksXray(_groundBuf, _groundCount, 0.34);
      if (_obsCount > 0)    drawMarksXray(_obsBuf, _obsCount, 0.4);
    }

    // ---- Live body dot (last, brightest) ----
    if (_liveCount === 1) {
      gl.useProgram(_dotProgram);
      gl.uniform1f(D.u_bias, 0.0006);
      gl.uniform1f(D.u_pulse, 1.0);   // live body: corona halo + hotter core
      drawDots(_liveBuf, 1, 1.0);
      gl.uniform1f(D.u_pulse, 0.0);
    }

    gl.depthMask(true);
  },
};

export function isArcLayerAdded(map) { return !!(map && map.getLayer && map.getLayer(LAYER_ID)); }
export function getArcMatrix() { return _lastMatrix; }
export { LAYER_ID as ARC_LAYER_ID };
