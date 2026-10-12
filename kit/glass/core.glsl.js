// core.glsl.js — the one glass shader. Hosts differ only in where u_tex comes from.
//
// Technique and failure modes: (internal path)
//
// Every element is a rounded box. Two kinds (u_meta[i].y):
//   0  pane    a sheet of glass
//   1  button  its own piece of glass, flush-mounted in a hole in a pane
// Panes and buttons are measured as SEPARATE distance fields (dP, dB), so a button
// never merges into its pane the way two panes do. Inside a pane a pixel is one of:
//   button   dB < 0            its own lens and tint; the pane's frost shows through
//   seam     0 < dB < gap      the dark hairline between the two edges
//   bevel    gap < dB < +ring  the pane's own edge, dipping into the hole
//   face     everything else   the plain pane
// The button draws the seam and the bevel as well as itself. That is Blair's idea of
// 26 July 2026: "it looks like you have two edges butting up against each other, but
// they're actually both part of the button."
//
// Colour is absorption (see tint.js): light is multiplied by exp(-a * density * path),
// and the path is longer where the surface is steep, so a tint is pale on the face
// and deep at the rim. See stain() for the body-colour term that keeps a tint
// visible over a dark map.

export function shaderSource(maxElements) {
  const N = maxElements;
  const vert = `
attribute vec2 a_ndc;
void main() { gl_Position = vec4(a_ndc, 0.0, 1.0); }`;

  const frag = `
precision highp float;
uniform sampler2D u_tex;
uniform vec2  u_res;                 // drawing-buffer px
uniform int   u_count;
uniform vec4  u_rect[${N}];          // cx, cy (GL bottom-left px), halfW, halfH
uniform vec4  u_meta[${N}];          // corner radius, kind, frost, press
uniform vec3  u_absorb[${N}];        // per-channel absorption; 0 = clear
uniform float u_spread, u_curve, u_amp;
uniform float u_blurK, u_base;
uniform float u_rim, u_spec, u_fres, u_shadow;
uniform float u_gap, u_ring, u_seam, u_seat;
uniform float u_density, u_rimSat, u_body;

float sdBox(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
// Exact gradient of sdBox: the direction "away from the nearest edge".
vec2 gradBox(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + r;
  vec2 s = vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
  if (q.x > 0.0 && q.y > 0.0) return s * normalize(q);
  return q.x > q.y ? vec2(s.x, 0.0) : vec2(0.0, s.y);
}

vec3 samp(vec2 t){ return texture2D(u_tex, t).rgb; }

// What you see through the glass at suv: the legacy light frost, then optical blur.
vec3 view(vec2 suv, float frost, float t, float blurPx){
  vec3 c = samp(suv);
  if (frost > 0.5) {
    float fr = frost / 100.0, rad = fr * 7.0 / u_res.x;
    vec3 acc = c; float tot = 1.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853982;
      vec2 o = vec2(cos(a), sin(a));
      acc += samp(suv + o * rad * 0.55);
      acc += samp(suv + o * rad);
      tot += 2.0;
    }
    c = mix(c, acc / tot, fr * (0.55 + 0.45 * t));
  }
  if (blurPx > 0.01) {
    vec2 rad2 = vec2(blurPx) / u_res;
    vec3 acc = c; float tot = 1.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853982;
      vec2 o = vec2(cos(a), sin(a));
      acc += samp(suv + o * rad2 * 0.55);
      acc += samp(suv + o * rad2);
      tot += 2.0;
    }
    c = mix(c, acc / tot, clamp(blurPx * 0.5, 0.0, 1.0));
  }
  return c;
}

// Stained glass. Absorption alone is black over a dark map (there is no light behind
// it to colour), so tinted glass also has a BODY colour: the light a real piece of
// coloured glass scatters back when lit from the front. Clear glass has none. Done
// in linear light so that density 1 over white comes out as the named colour.
vec3 stain(vec3 c, vec3 a, float path){
  if (dot(a, vec3(1.0)) < 1e-4) return c;
  vec3 lin = pow(max(c, 0.0), vec3(2.2));
  vec3 face = exp(-a * u_density);
  lin = lin * exp(-a * u_density * path)
      + face * u_body * (1.0 - min(face.r, min(face.g, face.b)));
  return pow(lin, vec3(1.0 / 2.2));
}

float profile(float t){ return pow(max(1.0 - t * t, 0.0), u_curve); }
// Zero on the flat face (t = 1) whatever the curve, and capped: below curve 1 the raw
// expression blows up there and smears the whole pane.
float profileGrad(float t){
  if (t >= 1.0) return 0.0;
  return min(2.0 * u_curve * t * pow(max(1.0 - t * t, 1e-4), u_curve - 1.0), 4.0);
}

// Specular and Fresnel on their own narrow rim profile, so the highlight stays on
// the edge however wide the lens is (the white-line bug, ui-lab/LOG.md 2026-07-29).
vec3 lighting(vec2 n, float inset, float spread){
  float rimT = clamp(inset / max(spread * u_rim, 6.0), 0.0, 1.0);
  vec3 N = normalize(vec3(n * pow(1.0 - rimT, 2.2) * 1.6, 1.0));
  vec3 L = normalize(vec3(0.55, 0.75, 0.95));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(N, H), 0.0), 42.0);
  float fres = pow(max(1.0 - N.z, 0.0), 2.4);
  return vec3(0.9, 0.96, 1.0) * spec * u_spec + vec3(0.62, 0.72, 0.92) * fres * u_fres;
}

void main(){
  vec2 px = gl_FragCoord.xy;
  vec2 uv = px / u_res;
  float aa = 1.2;

  // Nearest pane and nearest button, in one pass over the elements.
  float dP = 1e9, dB = 1e9;
  vec4 rP = vec4(0.0), mP = vec4(0.0), rB = vec4(0.0), mB = vec4(0.0);
  vec3 aP = vec3(0.0), aB = vec3(0.0);
  for (int i = 0; i < ${N}; i++) {
    if (i >= u_count) break;
    vec4 r = u_rect[i]; vec4 m = u_meta[i];
    float d = sdBox(px - r.xy, r.zw, m.x);
    if (m.y < 0.5) { if (d < dP) { dP = d; rP = r; mP = m; aP = u_absorb[i]; } }
    else           { if (d < dB) { dB = d; rB = r; mB = m; aB = u_absorb[i]; } }
  }

  if (dP > 22.0) discard;                              // nothing to draw out here
  if (dP > aa) {                                       // soft contact shadow on the map
    gl_FragColor = vec4(0.0, 0.0, 0.0, (1.0 - smoothstep(2.0, 22.0, dP)) * u_shadow);
    return;
  }

  vec2 nP = gradBox(px - rP.xy, rP.zw, mP.x);
  vec2 nB = dB < 1e8 ? gradBox(px - rB.xy, rB.zw, mB.x) : vec2(0.0);
  float press = mB.w;
  float hole = u_gap + u_ring;

  // ---- the pane's side: plain face, or its bevel into a button's hole
  vec3 col = vec3(0.0);
  if (dB > -aa) {
    float sp = max(min(u_spread, min(rP.z, rP.w) * 0.85), 1.0);
    float t = clamp(-dP / sp, 0.0, 1.0);
    float s = profile(t);
    vec2 n = nP; float inset = -dP; float lightSpread = sp;
    if (dB < hole && u_ring > 0.5) {
      float tr = clamp((dB - u_gap) / u_ring, 0.0, 1.0);
      float sr = profile(tr) * u_seat;
      if (sr > s) { s = sr; t = tr; n = -nB; inset = max(dB - u_gap, 0.0); lightSpread = u_ring; }
    }
    vec2 disp = n * s * u_amp / u_res;
    col = view(uv - disp, mP.z, t, u_blurK * profileGrad(t) + u_base);
    col = stain(col, aP, 1.0 + u_rimSat * s);
    col += lighting(n, inset, lightSpread);

    // the seam: a dark hairline of unrefracted map between the two edges
    if (u_gap > 0.25 && dB < u_gap + aa) {
      vec3 seam = samp(uv) * clamp(1.0 - u_seam * (1.0 + press), 0.0, 1.0);
      col = mix(col, seam, 1.0 - smoothstep(u_gap - aa, u_gap + aa, dB));
    }
  }

  // ---- the button: its own lens and tint, the pane's frost showing through it
  if (dB < aa) {
    float sp = max(min(u_spread, min(rB.z, rB.w) * 0.85), 1.0);
    float t = clamp(-dB / sp, 0.0, 1.0);
    float s = profile(t);
    vec2 disp = nB * s * u_amp * (1.0 - 0.45 * press) / u_res;
    vec3 b = view(uv - disp, mP.z, t, u_blurK * profileGrad(t) + u_base);
    b = stain(b, aB, 1.0 + u_rimSat * s);
    b *= 1.0 - 0.08 * press;
    b += lighting(nB, -dB, sp) * (1.0 - 0.35 * press);
    col = mix(col, b, 1.0 - smoothstep(-aa, aa, dB));
  }

  gl_FragColor = vec4(col, 1.0 - smoothstep(-aa, aa, dP));
}`;
  return { vert, frag };
}
