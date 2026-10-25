/**
 * GLSL 300 es shaders. The vertex shader applies the view transform and looks up
 * the per-drawable color from a palette texture indexed by drawableId via
 * texelFetch + textureSize (recolor = texture update, no geometry change). A
 * parallel R8 flags texture culls hidden drawables (visible flag in bit 0).
 */

// Shader-driven selection/hover highlight for the instanced lanes (#162). Injected into each instanced
// vertex shader: per-instance `a_group` (node id / link source id) + `a_selected` (0/1), and uniforms
// that turn a hover/selection restyle into a uniform change — no geometry rebuild, no buffer re-upload,
// so it scales to a full (LOD-off) draw. A highlighted instance (selected, or its group == the hovered
// group) is tinted toward `u_recolorRGB` preserving luminance (weight cue kept) when `u_recolor` is on
// (link layers); a non-highlighted instance fades its alpha by `u_dimOpacity` when `u_dimActive`. An
// instance whose index is in `u_hoverInstances` counts as hovered too (#476): an open module hovered by its
// boundary ring keeps its drawn members — one contiguous run of the frontier — undimmed.
const HL_UNIFORMS = `
uniform float u_hoverGroup;   // hovered group id (-1 = none)
uniform vec2 u_hoverInstances; // [lo, hi): instances highlighted with the hover by index (#476: an open module's drawn members)
uniform float u_dimActive;    // 1 = fade non-highlighted instances
uniform float u_dimOpacity;   // alpha multiplier for the faded instances
uniform float u_recolor;      // 1 = tint highlighted instances toward u_recolorRGB (link layers), 0 = keep (nodes)
uniform vec3 u_recolorRGB;    // highlight tint (0..1)
in float a_group;             // per-instance highlight group id (node id / link source id)
in float a_group2;            // link's OTHER endpoint (target) for undirected hover; -1 = unused
in float a_selected;          // per-instance selected flag (0/1)`;

const HL_APPLY = `
  float hlInstance = float(gl_InstanceID);
  bool hl = a_selected > 0.5 || (u_hoverGroup >= 0.0 && (abs(a_group - u_hoverGroup) < 0.5 || abs(a_group2 - u_hoverGroup) < 0.5))
    || (hlInstance >= u_hoverInstances.x && hlInstance < u_hoverInstances.y);
  if (hl) {
    if (u_recolor > 0.5) {
      float lum = dot(v_color.rgb, vec3(0.299, 0.587, 0.114));
      v_color.rgb = u_recolorRGB * clamp(lum * 1.5 + 0.2, 0.0, 1.0);
    }
  } else if (u_dimActive > 0.5) {
    v_color.a *= u_dimOpacity;
  }`;

export const FILL_VS = `#version 300 es
precision highp float;
uniform mat3 u_transform;
uniform highp sampler2D u_colorTable;   // per-drawable FILL color, indexed by drawableId
uniform highp sampler2D u_strokeTable;  // per-drawable STROKE color, indexed by drawableId
uniform highp sampler2D u_flags;
uniform float u_screen;     // 1.0 = screen sizeMode (constant px), 0.0 = world
uniform vec2 u_viewport;    // device px, for screen sizeMode
in vec2 a_position;
in vec2 a_anchor;
in float a_drawableId;
in float a_isStroke;        // 0 = fill vertex (sample u_colorTable), 1 = stroke vertex (u_strokeTable)
out vec4 v_color;
flat out float v_id;
void main() {
  int id = int(a_drawableId + 0.5);
  v_id = a_drawableId;
  // Fill and stroke geometry of a drawable share this shader (interleaved per drawable
  // in one draw, so painter's order is preserved); a_isStroke picks the color table.
  // Samplers are opaque (no sampler l-values in GLSL ES), so fetch both and select.
  ivec2 cs = textureSize(u_colorTable, 0);
  vec4 fillColor = texelFetch(u_colorTable, ivec2(id % cs.x, id / cs.x), 0);
  ivec2 ss = textureSize(u_strokeTable, 0);
  vec4 strokeColor = texelFetch(u_strokeTable, ivec2(id % ss.x, id / ss.x), 0);
  v_color = (a_isStroke > 0.5) ? strokeColor : fillColor;
  ivec2 fsz = textureSize(u_flags, 0);
  // r8 byte -> integer; visibility is bit 0 (matches ../core/index.js flag semantics).
  int flags = int(texelFetch(u_flags, ivec2(id % fsz.x, id / fsz.x), 0).r * 255.0 + 0.5);
  if ((flags & 1) == 0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside clip space -> culled
    return;
  }
  // World: project the vertex directly. Screen: project the anchor, then add the
  // (vertex - anchor) offset at a constant pixel size (clip = 2px / viewport).
  vec2 pos;
  if (u_screen > 0.5) {
    vec3 ca = u_transform * vec3(a_anchor, 1.0);
    pos = ca.xy + (a_position - a_anchor) * vec2(2.0 / u_viewport.x, -2.0 / u_viewport.y);
  } else {
    pos = (u_transform * vec3(a_position, 1.0)).xy;
  }
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

export const FILL_FS = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }`;

export const POINT_VS = `#version 300 es
precision highp float;
uniform mat3 u_transform;
uniform highp sampler2D u_colorTable;
uniform highp sampler2D u_flags;
uniform float u_pointScreen;
uniform vec2 u_viewport;
in vec2 a_center;
in vec2 a_corner;
in float a_radius;
in float a_pointId;
out vec4 v_color;
out vec2 v_local;
void main() {
  int id = int(a_pointId + 0.5);
  ivec2 cs = textureSize(u_colorTable, 0);
  v_color = texelFetch(u_colorTable, ivec2(id % cs.x, id / cs.x), 0);
  ivec2 fsz = textureSize(u_flags, 0);
  int flags = int(texelFetch(u_flags, ivec2(id % fsz.x, id / fsz.x), 0).r * 255.0 + 0.5);
  if ((flags & 1) == 0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  v_local = a_corner;
  vec3 c = u_transform * vec3(a_center, 1.0);
  vec2 off = (u_pointScreen > 0.5)
    ? a_corner * a_radius * vec2(2.0 / u_viewport.x, -2.0 / u_viewport.y)
    : (u_transform * vec3(a_center + a_corner * a_radius, 1.0)).xy - c.xy;
  gl_Position = vec4(c.xy + off, 0.0, 1.0);
}`;

export const POINT_FS = `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_local;
out vec4 fragColor;
void main() { if (dot(v_local, v_local) > 1.0) discard; fragColor = v_color; }`;

export const PICK_FS = `#version 300 es
precision highp float;
flat in float v_id;
out vec4 fragColor;
void main() {
  int id = int(v_id + 0.5) + 1; // +1 so background (0,0,0) decodes to -1
  fragColor = vec4(
    float(id & 255) / 255.0,
    float((id >> 8) & 255) / 255.0,
    float((id >> 16) & 255) / 255.0,
    1.0);
}`;

// GLOBE_VS / GLOBE_FS — render a UV-sphere sampling an equirectangular map texture.
// Uniforms: u_rotation (mat3, applied to surface direction), u_scale (px radius),
// u_center (px), u_viewport (px). Attribute a_lonLat (degrees).
export const GLOBE_VS = `#version 300 es
precision highp float;
in vec2 a_lonLat;
uniform mat3 u_rotation;
uniform float u_scale;
uniform vec2 u_center;
uniform vec2 u_viewport;
out vec2 v_uv;
out float v_front;
void main() {
  float lon = radians(a_lonLat.x);
  float lat = radians(a_lonLat.y);
  vec3 dir = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  vec3 r = u_rotation * dir;
  v_front = r.z;
  vec2 px = u_center + vec2(r.x, -r.y) * u_scale;
  vec2 clip = vec2(px.x / u_viewport.x * 2.0 - 1.0, 1.0 - px.y / u_viewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = vec2(a_lonLat.x / 360.0 + 0.5, 0.5 + a_lonLat.y / 180.0);
}`;

export const GLOBE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_front;
uniform sampler2D u_map;
out vec4 fragColor;
void main() {
  if (v_front <= 0.0) discard;
  fragColor = texture(u_map, v_uv);
}`;

// PT_POINT_VS — pass-through variant of POINT_VS. Identical quad-corner geometry but
// reads color directly from the a_color vertex attribute instead of a texture lookup,
// so no u_colorTable / u_flags are needed. Pairs with the existing POINT_FS.
export const PT_POINT_VS = `#version 300 es
precision highp float;
uniform mat3 u_transform;
uniform float u_pointScreen;
uniform vec2 u_viewport;
in vec2 a_center;
in vec2 a_corner;
in float a_radius;
in vec4 a_color;
out vec4 v_color;
out vec2 v_local;
void main() {
  v_color = a_color;
  v_local = a_corner;
  vec3 c = u_transform * vec3(a_center, 1.0);
  vec2 off = (u_pointScreen > 0.5)
    ? a_corner * a_radius * vec2(2.0 / u_viewport.x, -2.0 / u_viewport.y)
    : (u_transform * vec3(a_center + a_corner * a_radius, 1.0)).xy - c.xy;
  gl_Position = vec4(c.xy + off, 0.0, 1.0);
}`;

// INSTANCED_CIRCLE_VS — true GPU-instanced circles for the network lane (#100). A shared
// unit-quad template (a_corner, per-vertex) is offset by per-instance centre/radius and
// coloured from a per-instance attribute (no texture lookup). Pairs with POINT_FS, which
// discards fragments outside the unit disc. Mirrors PT_POINT_VS's world/screen sizeMode.
export const INSTANCED_CIRCLE_VS = `#version 300 es
precision highp float;
uniform mat3 u_transform;
uniform float u_screen;     // 1.0 = screen sizeMode (constant px), 0.0 = world
uniform vec2 u_viewport;    // device px, for screen sizeMode
layout(location = 0) in vec2 a_corner; // per-vertex unit-quad corner in [-1, 1]; location 0 stays buffer-backed (OffsetColumn, instanced.ts)
in vec2 a_center;           // per-instance world centre
in vec2 a_offset;           // per-instance offset from the centre in size units (#509); the constant (0, 0) without one
in float a_radius;          // per-instance radius
in vec4 a_color;            // per-instance RGBA (unorm8x4 -> 0..1)
uniform float u_borderPx;   // 1.0 = a_border is a ring width in screen px (#495), 0.0 = a fraction of the radius
in float a_border;          // per-instance ring thickness as a fraction of radius (0 = no ring)
in vec4 a_borderColor;      // per-instance ring RGBA (unorm8x4 -> 0..1)${HL_UNIFORMS}
out vec4 v_color;
out vec2 v_local;
out float v_border;
out vec4 v_borderColor;
void main() {
  v_color = a_color;${HL_APPLY}
  v_local = a_corner;
  // A px ring on a world disc: the disc's radius in px is a_radius · k, with k = ½ · viewport · |transform₀₀|.
  float radiusPx = (u_screen > 0.5) ? a_radius : a_radius * 0.5 * u_viewport.x * abs(u_transform[0][0]);
  v_border = (u_borderPx > 0.5) ? min(1.0, a_border / max(radiusPx, 1e-6)) : a_border;
  v_borderColor = a_borderColor;
  if (!hl && u_dimActive > 0.5) v_borderColor.a *= u_dimOpacity; // dim the flow-border ring with its node (#162)
  // The offset is in size units (#509): px after the projection in screen mode, world units before it.
  bool screen = u_screen > 0.5;
  vec2 centre = screen ? a_center : a_center + a_offset;
  vec3 c = u_transform * vec3(centre, 1.0);
  vec2 off = screen
    ? (a_corner * a_radius + a_offset) * vec2(2.0 / u_viewport.x, -2.0 / u_viewport.y)
    : (u_transform * vec3(centre + a_corner * a_radius, 1.0)).xy - c.xy;
  gl_Position = vec4(c.xy + off, 0.0, 1.0);
}`;

// INSTANCED_CIRCLE_FS — flow-border circle (#104 N6): a filled disc with an optional outer ring.
// `v_border` is the ring thickness as a fraction of the radius; fragments in the outer annulus
// (r > 1 - border) take the border colour, the rest the fill. border = 0 ⇒ a plain filled disc
// (so every existing circle layer renders exactly as before). Kept separate from the shared POINT_FS
// (which PT_POINT_VS also uses) since it reads the extra ring varyings.
export const INSTANCED_CIRCLE_FS = `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_local;
in float v_border;
in vec4 v_borderColor;
out vec4 fragColor;
void main() {
  float r = length(v_local);
  if (r > 1.0) discard;
  fragColor = (v_border > 0.0 && r > 1.0 - v_border) ? v_borderColor : v_color;
}`;

// INSTANCED_PIE_VS — GPU-instanced pie wedges for the physical view of a state network (#171). Reuses
// the circle's quad positioning (per-instance centre/radius, world/screen sizeMode) and carries the
// wedge's angular range [startFrac, endFrac] in [0,1] to the fragment shader. One instance per wedge.
export const INSTANCED_PIE_VS = `#version 300 es
precision highp float;
uniform mat3 u_transform;
uniform float u_screen;     // 1.0 = screen sizeMode (constant px), 0.0 = world
uniform vec2 u_viewport;    // device px, for screen sizeMode
in vec2 a_corner;           // per-vertex unit-quad corner in [-1, 1]
in vec2 a_center;           // per-instance world centre (shared by a pie's wedges)
in float a_radius;          // per-instance radius
in vec2 a_angles;           // per-instance [startFrac, endFrac] in [0,1]
in vec4 a_color;            // per-instance RGBA (unorm8x4 -> 0..1)
in float a_border;          // per-instance outer band as a fraction of the radius (#507); 0 = none${HL_UNIFORMS}
out vec4 v_color;
out vec2 v_local;
out vec2 v_angles;
out float v_border;
void main() {
  v_color = a_color;${HL_APPLY}
  v_local = a_corner;
  v_angles = a_angles;
  v_border = a_border;
  vec3 c = u_transform * vec3(a_center, 1.0);
  vec2 off = (u_screen > 0.5)
    ? a_corner * a_radius * vec2(2.0 / u_viewport.x, -2.0 / u_viewport.y)
    : (u_transform * vec3(a_center + a_corner * a_radius, 1.0)).xy - c.xy;
  gl_Position = vec4(c.xy + off, 0.0, 1.0);
}`;

// INSTANCED_PIE_FS — a filled disc clipped to one angular wedge. Discards outside the unit disc (like
// the circle) and outside the wedge's [startFrac, endFrac] angular slice. The angle fraction is
// atan2(y,x) normalised to [0,1) — the SAME convention the Canvas/SVG wedge-arc emitter uses (in world
// coords, before the shared world→screen transform), so the three backends partition the pie identically.
export const INSTANCED_PIE_FS = `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_local;
in vec2 v_angles;
in float v_border;
uniform float u_borderDarken; // RGB factor of the outer band (#507)
out vec4 fragColor;
void main() {
  float r = length(v_local);
  if (r > 1.0) discard;
  float frac = atan(v_local.y, v_local.x) * 0.15915494309; // /(2π) -> [-0.5, 0.5]
  if (frac < 0.0) frac += 1.0;                              // -> [0, 1)
  if (frac < v_angles.x || frac >= v_angles.y) discard;     // outside this wedge
  // The wedge's outer band (the node's flow border, #507) in its own colour, darker — the circle's ring test.
  fragColor = (v_border > 0.0 && r > 1.0 - v_border) ? vec4(v_color.rgb * u_borderDarken, v_color.a) : v_color;
}`;

// INSTANCED_LINE_VS — GPU-instanced "path-strip" lines for the network lane (#100, bent #104 N6c).
// The per-vertex template a_corner = (t, side): t in [0,1] walks the path (M samples), side in
// {-1,1} picks the edge. Per-instance source/target/width/color/bend. The path is a quadratic
// bezier whose control point is the chord midpoint offset perpendicular by `a_bend` (a fraction of
// the chord length); `a_bend = 0` ⇒ the control sits on the chord ⇒ a straight line (so straight
// links draw exactly as before, at M=2). The strip offsets each sample by the *tangent's*
// perpendicular, so a continuous strip gets its joins for free. Pairs with FILL_FS.
function lineVS(curve: string): string {
  return `#version 300 es
precision highp float;
uniform mat3 u_transform;
uniform float u_screen;     // 1.0 = constant-px width, 0.0 = world width (scales with zoom)
uniform vec2 u_viewport;    // device px, for screen mode
layout(location = 0) in vec2 a_corner; // per-vertex (t in [0,1], side in {-1,1}); location 0 stays buffer-backed (OffsetColumn, instanced.ts)
in vec2 a_source;           // per-instance world source
in vec2 a_target;           // per-instance world target
in vec2 a_sourceOffset;     // per-instance offsets of the two ends in size units (#509); the constant (0, 0) without them
in vec2 a_targetOffset;
in float a_width;           // per-instance line width
in vec4 a_color;            // per-instance RGBA (unorm8x4 -> 0..1)
in float a_bend;            // per-instance control offset ⟂ to the chord, as a fraction of |chord| (0 = straight)${HL_UNIFORMS}
uniform float u_pickBase;   // added to the instance's pick id (#447): two pickable link layers decode apart
out vec4 v_color;
flat out float v_id;        // instance index for GPU-readback picking (#141); ignored by FILL_FS, read by PICK_FS
vec2 worldToPx(vec2 w) {
  vec2 clip = (u_transform * vec3(w, 1.0)).xy;
  return vec2((clip.x + 1.0) * 0.5 * u_viewport.x, (1.0 - clip.y) * 0.5 * u_viewport.y);
}
void main() {
  v_color = a_color;${HL_APPLY}
  v_id = float(gl_InstanceID) + u_pickBase;
  float t = a_corner.x;
  float side = a_corner.y;
  float hw = a_width * 0.5;
  bool screen = u_screen > 0.5;
  // Screen mode works in px (#509): both ends projected, then offset by their px offsets. The bend is a fraction
  // of the chord, so the bezier on the projected ends is the projection of the world bezier (a similarity).
  vec2 src = screen ? worldToPx(a_source) + a_sourceOffset : a_source + a_sourceOffset;
  vec2 tgt = screen ? worldToPx(a_target) + a_targetOffset : a_target + a_targetOffset;
${curve}
  if (screen) {
    // Constant-pixel width: offset the px centreline point along the tangent's perpendicular, then px -> clip.
    vec2 dir = normalize(tang);
    vec2 pos = p + vec2(-dir.y, dir.x) * side * hw;
    gl_Position = vec4(pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - pos.y / u_viewport.y * 2.0, 0.0, 1.0);
  } else {
    // World width: offset the centreline point in world space along the tangent's perpendicular.
    vec2 dir = normalize(tang);
    vec2 perp = vec2(-dir.y, dir.x);
    gl_Position = vec4((u_transform * vec3(p + perp * side * hw, 1.0)).xy, 0.0, 1.0);
  }
}`;
}
const QUADRATIC_LINE_GLSL = `
  vec2 d = tgt - src;
  vec2 ctrl = 0.5 * (src + tgt) + vec2(-d.y, d.x) * a_bend; // ⟂(chord) · bend
  float u = 1.0 - t;
  vec2 p = u * u * src + 2.0 * u * t * ctrl + t * t * tgt;  // B(t)
  vec2 tang = 2.0 * u * (ctrl - src) + 2.0 * t * (tgt - ctrl); // B'(t)`;
export const INSTANCED_LINE_VS = lineVS(QUADRATIC_LINE_GLSL);

// INSTANCED_HEAD_LINE_VS — the `arrows` primitive: a whole arrow, shaft + head, as one instance (#542): one strip.
// The twin of `core/arrowhead.ts` `arrowOutline`: the tip sits `a_radius` back from the target along the
// curve's end tangent; the head is `2·u_arrowSize` long and `a_width/2 + 2·sqrt(a_width)` wide each side
// (the half-arrow barb rule, `barbOverhang`); the shaft is the settled cubic (`legCubic`) src → base, whose end
// tangent is the head's axis, so it runs into the head along it, its last pair on the base with the head's normal. The template (`headLineTemplate`) is the line's `(t, side)`
// samples, then (2, 1) left barb, (2, -1) right barb, (3, 0) tip: the two triangles that join the shaft's
// last pair to the barbs are collinear (all on the base edge, zero area), so one strip draws shaft + head
// with no overlap and a translucent arrow blends once. Units follow sizeMode like the line (px or world).
const HEAD_LINE_DECL = `
uniform float u_arrowSize;  // head length = 2·u_arrowSize (#542)
in float a_radius;          // per-instance target radius: the tip sits this far back from the target`;
const HEAD_LINE_BODY = `  float t = a_corner.x;
  float side = a_corner.y;
  float hw = a_width * 0.5;
  bool screen = u_screen > 0.5;
  vec2 src = screen ? worldToPx(a_source) + a_sourceOffset : a_source + a_sourceOffset;
  vec2 tgt = screen ? worldToPx(a_target) + a_targetOffset : a_target + a_targetOffset;
  vec2 d = tgt - src;
  float len = 2.0 * u_arrowSize;                            // headLength
  float back = a_radius + len;                              // ρ
  // fadedBend (core/arrowhead.ts): a short link's bend fades towards the floor where an opposite pair's heads
  // just clear, x = min(0.99, 1.2·H/ρ), floor = ½·x/√(1 − x²), over smoothstep(2ρ, 4ρ, D).
  float dl = length(d);
  float bend = a_bend;
  float k = 1.0;                                            // √(1 + 4b²), b the faded bend
  if (a_bend != 0.0) {
    if (back > 0.0) {
      float ab = abs(a_bend);
      float hx = min(0.99, 1.2 * (hw + 2.0 * sqrt(a_width)) / back);
      float floorBend = min(ab, 0.5 * hx / sqrt(1.0 - hx * hx));
      float fade = smoothstep(2.0 * back, 4.0 * back, dl);
      bend = sign(a_bend) * (ab - (ab - floorBend) * (1.0 - fade));
    }
    k = sqrt(1.0 + 4.0 * bend * bend);
  }
  // The legs (core/arrowhead.ts writeShaft): out of each centre towards the quadratic's control mid + ⟂d·bend.
  vec2 bp = 2.0 * bend * vec2(-d.y, d.x);
  // |±d + 2b·⟂d| = |d|·√(1 + 4b²) exactly (⟂d is perpendicular to d with its length): no third root.
  float ll = dl * k;
  // Coincident ends (a self-link's edge, or two nodes at one point): no direction, so no arrow, as the TS twin
  // (writeShaft returns 0). Every vertex collapses onto src: a zero-area strip, never a NaN vertex.
  if (!(ll > 0.0)) {
    gl_Position = screen
      ? vec4(src.x / u_viewport.x * 2.0 - 1.0, 1.0 - src.y / u_viewport.y * 2.0, 0.0, 1.0)
      : vec4((u_transform * vec3(src, 1.0)).xy, 0.0, 1.0);
    return;
  }
  vec2 u1 = (bp - d) / ll;                                  // out of the target: the head's axis is −u1
  vec2 un = vec2(u1.y, -u1.x);                              // ⟂(−u1): the head's normal
  vec2 tip = tgt + u1 * a_radius;
  vec2 base = tgt + u1 * back;                              // E1, the head's base centre
  vec2 pos;
  if (t > 2.5) {
    pos = tip;
  } else if (t > 1.5) {
    pos = base + un * side * (hw + 2.0 * sqrt(a_width));    // headHalfWidth: the barbs
  } else if (t >= 1.0) {
    pos = base + un * side * hw;                            // the shaft's end, on the base
  } else {
    // legCubic: E0 = src, E0 + ℓ·u0, E1 + ℓ·u1, E1 = base, ℓ = |E1 − E0|·√(1 + 4b²)/3; when the base lies
    // back past the control (a very short link) the shaft collapses to the straight src → base.
    vec2 c = base - src;
    float chord = length(c);
    vec2 v = chord > 0.0 ? c / chord : -u1;
    bool settled = back < 0.5 * ll;
    vec2 l0 = settled ? (d + bp) / ll : v;
    vec2 l1 = settled ? u1 : -v;
    float leg = settled ? chord * k / 3.0 : chord / 3.0;
    vec2 p1 = src + leg * l0;
    vec2 p2 = base + leg * l1;
    float u = 1.0 - t;
    vec2 p = u * u * u * src + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * base;
    vec2 g = u * u * (p1 - src) + 2.0 * u * t * (p2 - p1) + t * t * (base - p2); // B'(t)/3
    float gl = length(g);
    vec2 n = gl > 0.0 ? vec2(-g.y, g.x) / gl : un;
    pos = p + n * side * hw;
  }
  gl_Position = screen
    ? vec4(pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - pos.y / u_viewport.y * 2.0, 0.0, 1.0)
    : vec4((u_transform * vec3(pos, 1.0)).xy, 0.0, 1.0);
}`;

function headLineVS(vs: string): string {
  const at = vs.indexOf("  float t = a_corner.x;");
  if (at < 0 || !vs.includes("\nin float a_bend;")) throw new Error("headLineVS: unexpected line shader");
  return vs.slice(0, at).replace("\nin float a_bend;", `${HEAD_LINE_DECL}\nin float a_bend;`) + HEAD_LINE_BODY;
}

export const INSTANCED_HEAD_LINE_VS = headLineVS(INSTANCED_LINE_VS);

// INSTANCED_LOOP_VS — the self-link loop (#505, #542), one instance of the loop lane (`InstancedLoops`): the GLSL
// twin of `core/loop-drop.ts` (`traceLoop`, `traceLoopArrowOutline`, `traceLoopHalfArrowOutline`), every variant one strip.
// A `loops` layer (`InstancedLoopsData`): `a_center` its node centre, and its two rim ends are that centre plus
// `a_startOffset` / `a_endOffset` (size units, any #509 node offset in both); from their difference D, n = cot α·⟂(D)/2 gives S − c = n − D/2 = r·u0 and
// T − c = n + D/2 = r·u1. The centre curve is c → E0, the cubic E0, E0 + ℓ·u0, E1 + ℓ·u1, E1 (E_k = c + (r + h)·u_k,
// ℓ = L·r: `u_loopLeg` is the layer's `legLength`, L in node radii), then the variant's end. h = max(2·arrowSize, 10·∛w)
// in every variant (`loopPieceLength`), so the path never changes with the head, which lies on the end piece: its
// tip on the rim, T = c + r·u1, its base B = c + (r + hl)·u1, hl its length (2·arrowSize = u_loopHead, or the half
// head's 10·∛w). The template (`loopTemplate`): (−1, ±1) the pair at c with the straight leg's normal ⟂(u0);
// (t ∈ [0, 1], ±1) the cubic; then the end — undirected (4, ±1) the pair back at c; arrow (5, ±1) the shaft's pair
// at B, (2, 1) left barb, (2, −1) right barb, (3, 0) tip (as `headLineTemplate`); half-arrow (3, 0) tip, (5, 1) the
// outer edge at B, (2, 1) barb (off the last pair, the band down to B and the one-sided head). Each edge sits `off`
// along ⟂(travel), the loop's outside: ±w/2 (line), 0 / +w (half-arrow).
const LOOP_DECL = `
uniform float u_loopHead;   // 2·arrowSize: the arrowhead's length; the straight pieces are max(this, 10·∛w) (#542)
uniform float u_loopCot;    // cot α: recovers the loop's centre from its two rim ends
uniform float u_loopHalf;   // 1 = the half-arrow band (edges 0 / +w, one-sided head), 0 = the line (±w/2)
uniform float u_loopLeg;    // L: the cubic's arms in node radii (the layer's legLength)`;
const LOOP_BODY = `  float t = a_corner.x;
  float side = a_corner.y;
  bool screen = u_screen > 0.5;
  bool halfArrow = u_loopHalf > 0.5;
  vec2 cp = screen ? worldToPx(a_center) : a_center;
  vec2 src = cp + a_startOffset;
  vec2 tgt = cp + a_endOffset;
  vec2 hd = 0.5 * (a_endOffset - a_startOffset);           // D/2, exact: both ends share the centre
  vec2 nd = vec2(-hd.y, hd.x) * u_loopCot;
  vec2 a0 = nd - hd;                                        // S − c = r·u0
  float r = length(a0);
  float ir = r > 0.0 ? 1.0 / r : 0.0;                       // coincident ends: every point collapses onto c
  vec2 u0 = a0 * ir;
  vec2 u1 = (nd + hd) * ir;
  vec2 c = 0.5 * (src - a0 + tgt - (nd + hd));              // = S − r·u0 = T − r·u1
  float off = halfArrow ? (side + 1.0) * 0.5 * a_width : side * 0.5 * a_width;
  float halfHead = 10.0 * pow(a_width, 1.0 / 3.0);         // the half-arrow's head length
  float h = max(u_loopHead, halfHead);                      // the straight pieces, the same in every variant
  vec2 e1 = c + (r + h) * u1;                               // E1, the end piece's far end
  vec2 un = vec2(u1.y, -u1.x);                              // ⟂(−u1): the end's normal
  vec2 pos;
  if (t > 4.5) {
    pos = c + (r + (halfArrow ? halfHead : u_loopHead)) * u1 + un * off; // an edge at the head's base B
  } else if (t > 3.5) {
    pos = c + un * off;                                     // the undirected loop's end, back at c
  } else if (t > 2.5) {
    pos = c + r * u1;                                       // the tip, on the rim
  } else if (t > 1.5) {
    vec2 b = c + (r + (halfArrow ? halfHead : u_loopHead)) * u1;
    pos = b + un * (off + side * 2.0 * sqrt(a_width));      // a barb at B: barbOverhang past its edge
  } else if (t < -0.5) {
    pos = c + vec2(-u0.y, u0.x) * off;                      // the start, at c
  } else {
    vec2 e0 = c + (r + h) * u0;
    float leg = u_loopLeg * r;
    vec2 p1 = e0 + leg * u0;
    vec2 p2 = e1 + leg * u1;
    float u = 1.0 - t;
    vec2 p = u * u * u * e0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * e1;
    vec2 g = u * u * (p1 - e0) + 2.0 * u * t * (p2 - p1) + t * t * (e1 - p2); // B'(t)/3
    float gl = length(g);
    vec2 n = gl > 0.0 ? vec2(-g.y, g.x) / gl : un;
    pos = p + n * off;
  }
  gl_Position = screen
    ? vec4(pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - pos.y / u_viewport.y * 2.0, 0.0, 1.0)
    : vec4((u_transform * vec3(pos, 1.0)).xy, 0.0, 1.0);
}`;

export const INSTANCED_LOOP_VS = `#version 300 es
precision highp float;
uniform mat3 u_transform;
uniform float u_screen;     // 1.0 = constant-px width, 0.0 = world width (scales with zoom)
uniform vec2 u_viewport;    // device px, for screen mode
layout(location = 0) in vec2 a_corner; // per-vertex (t, side), see loopTemplate; location 0 stays buffer-backed (OffsetColumn, instanced.ts)
in vec2 a_center;           // per-instance world centre of the loop's node
in vec2 a_startOffset;      // per-instance rim ends as offsets from the centre, in size units (#509)
in vec2 a_endOffset;
in float a_width;           // per-instance line width
in vec4 a_color;            // per-instance RGBA (unorm8x4 -> 0..1)${HL_UNIFORMS}
uniform float u_pickBase;   // added to the instance's pick id (#447)${LOOP_DECL}
out vec4 v_color;
flat out float v_id;        // instance index for GPU-readback picking (#141); ignored by FILL_FS, read by PICK_FS
vec2 worldToPx(vec2 w) {
  vec2 clip = (u_transform * vec3(w, 1.0)).xy;
  return vec2((clip.x + 1.0) * 0.5 * u_viewport.x, (1.0 - clip.y) * 0.5 * u_viewport.y);
}
void main() {
  v_color = a_color;${HL_APPLY}
  v_id = float(gl_InstanceID) + u_pickBase;
${LOOP_BODY}`;

// INSTANCED_HALF_ARROW_VS — the "map of networks" directed-link glyph (#104 N6): one filled shape
// per link that pinches to the source centre, bows around a shared centre curve, and ends in a barbed
// arrowhead whose tip lands on the *target node's boundary*. A reciprocal A→B / B→A pair shares the
// centre curve (the direction-based `positiveCurvature` rule fixes the side) and fills opposite halves
// of it, so the two arrows nest. This is the same math as network/half-link.ts (the SVG/Canvas source
// of truth, golden-tested vs the reference), mirrored here so the WebGL lane stays fully instanced.
// Per-vertex a_kind = (code, t): code selects a named anchor (0 x0, 1 x02, 2 x03, 3 x04, 4 x11,
// 5 x12, 6 x13, 7 x14) or evaluates the inner (8) / outer (9) edge bezier at parameter t; the template
// (see instanced.ts) lists the foot, body strip and head as a triangle list. Pairs with FILL_FS.
// `a_bend` is the perpendicular offset as a fraction of the centre chord (sign = bow direction, #296) —
// scaled by `l` in the working space, so the bow keeps its shape relative to the link at any zoom.
//
// sizeMode: in **world** mode the shape is built in world units, then projected — so widths/tips
// scale with zoom. In **screen** mode the two node centres are first projected to screen pixels and the
// *same* math runs in pixel space — so the link decorations (width, tip, node radii) stay a
// constant pixel size while the endpoints still move with zoom. The geometry math is scale-free, so
// only the input/output space differs: screen mode adds two world→px projections up front and a px→clip
// convert at the end (a uniform branch — the world path is untouched).
function halfArrowVS(geometry: string, inner: string, outer: string): string {
  return `#version 300 es
precision highp float;
uniform mat3 u_transform;
uniform float u_screen;   // 1.0 = screen sizeMode (constant px), 0.0 = world
uniform vec2 u_viewport;  // device px, for screen sizeMode
layout(location = 0) in vec2 a_kind; // per-vertex (code, t); location 0 stays buffer-backed (OffsetColumn, instanced.ts)
in vec2 a_p0;         // per-instance source centre
in vec2 a_p1;         // per-instance target centre
in vec2 a_sourceOffset; // per-instance offsets of the two ends in size units (#509); the constant (0, 0) without them
in vec2 a_targetOffset;
in vec2 a_radii;      // per-instance (r0, r1)
in vec2 a_widths;     // per-instance (width, oppositeWidth)
in float a_bend;      // per-instance bend, a fraction of the chord (sign picks the bow side)
in vec4 a_color;      // per-instance RGBA (unorm8x4 -> 0..1)${HL_UNIFORMS}
uniform float u_pickBase;   // added to the instance's pick id (#447): two pickable link layers decode apart
out vec4 v_color;
flat out float v_id;  // instance index for GPU-readback picking (#141); ignored by FILL_FS, read by PICK_FS
vec2 bez(vec2 p0, vec2 c, vec2 p2, float t) {
  float u = 1.0 - t;
  return u * u * p0 + 2.0 * u * t * c + t * t * p2;
}
vec2 worldToPx(vec2 w) {
  vec2 clip = (u_transform * vec3(w, 1.0)).xy;
  return vec2((clip.x + 1.0) * 0.5 * u_viewport.x, (1.0 - clip.y) * 0.5 * u_viewport.y);
}
void main() {
  v_color = a_color;${HL_APPLY}
  v_id = float(gl_InstanceID) + u_pickBase;
  float code = a_kind.x;
  float t = a_kind.y;
  bool screen = u_screen > 0.5;
  // Screen mode: project both node centres to px and build the shape in px (radii/widths are px).
  vec2 p0 = screen ? worldToPx(a_p0) + a_sourceOffset : a_p0 + a_sourceOffset;
  vec2 p1 = screen ? worldToPx(a_p1) + a_targetOffset : a_p1 + a_targetOffset;
  // World-sized nodes under px-sized links (#494): the radii at this zoom, in px.
  float r0 = a_radii.x;
  float r1 = a_radii.y;
  float width = a_widths.x;
  float oppositeWidth = a_widths.y;

${geometry}

  vec2 pos;
  if (code < 0.5) pos = p0;
  else if (code < 1.5) pos = x02;
  else if (code < 2.5) pos = x03;
  else if (code < 3.5) pos = x04;
  else if (code < 4.5) pos = x11;
  else if (code < 5.5) pos = x12;
  else if (code < 6.5) pos = x13;
  else if (code < 7.5) pos = x14;
  else if (code < 8.5) pos = ${inner};
  else pos = ${outer};

  // World: project the world-space point. Screen: pos is already px, so convert px to clip.
  vec2 clip = screen ? vec2(pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - pos.y / u_viewport.y * 2.0) : (u_transform * vec3(pos, 1.0)).xy;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;
}
const QUADRATIC_HALF_ARROW_GLSL = `
  vec2 d = p1 - p0;
  float l = length(d);
  float lBetween = l - r0 - r1;
  vec2 dir = d / l;
  vec2 right = vec2(-dir.y, dir.x);

  float tipLength = min(lBetween / 3.0, 10.0 * pow(width, 1.0 / 3.0));
  float tipWidth = 2.0 * sqrt(width);
  float oppositeTipLength = min(lBetween / 3.0, 10.0 * pow(oppositeWidth, 1.0 / 3.0));

  float bendMagnitude = abs(a_bend) * l;
  float outerBendAddition = pow(bendMagnitude / 10.0, 0.4);
  bool positiveCurvature = dir.x > 0.0 || (dir.x == 0.0 && dir.y < 0.0);
  float curvatureSign = positiveCurvature ? 1.0 : -1.0;
  float bendSign = a_bend > 0.0 ? 1.0 : -1.0;
  float signedBend = curvatureSign * bendSign * bendMagnitude;

  vec2 c02tmp = p0 + (r0 + oppositeTipLength) * dir;
  vec2 c12tmp = p1 - (r1 + tipLength) * dir;
  vec2 mid = 0.5 * (c02tmp + c12tmp);
  vec2 cp1 = mid + signedBend * right;
  vec2 cp2 = mid + (signedBend + width + outerBendAddition) * right;

  vec2 d1 = cp1 - p0;
  vec2 dir0 = d1 / length(d1);
  vec2 right0 = vec2(-dir0.y, dir0.x);
  vec2 x02 = p0 + (r0 + oppositeTipLength) * dir0;
  vec2 x03 = x02 + width * right0;
  vec2 x04 = p0 + width * right0;

  vec2 d2 = cp1 - p1;
  vec2 dir1 = d2 / length(d2);
  vec2 x11 = p1 + r1 * dir1;
  vec2 x12 = x11 + tipLength * dir1;
  vec2 left1 = vec2(dir1.y, -dir1.x);
  vec2 x13 = x12 + width * left1;
  vec2 x14 = x13 + tipWidth * left1;`;
export const INSTANCED_HALF_ARROW_VS = halfArrowVS(QUADRATIC_HALF_ARROW_GLSL, "bez(x02, cp1, x12, t)", "bez(x03, cp2, x13, t)");

// PT_MESH_VS — pass-through fill/stroke meshes. Both fill triangles and expanded-stroke
// triangles are just colored geometry, so they share this shader: project the world-space
// vertex through u_transform (world mode — stroke width scales with zoom, matching Canvas)
// and pass the per-vertex baked color straight through. Pairs with FILL_FS (fragColor=v_color).
export const PT_MESH_VS = `#version 300 es
precision highp float;
uniform mat3 u_transform;
in vec2 a_position;
in vec4 a_color;
out vec4 v_color;
void main() {
  v_color = a_color;
  gl_Position = vec4((u_transform * vec3(a_position, 1.0)).xy, 0.0, 1.0);
}`;

// BLIT_VS / BLIT_FS — composite a texture (the pass-through accumulation FBO) to the
// screen as a full-screen textured quad. u_blit is a mat3 transform applied in clip
// space, used during snapshot-pan to offset the accumulated layer without re-rendering.
export const BLIT_VS = `#version 300 es
precision highp float;
uniform mat3 u_blit;
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  vec3 p = u_blit * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

export const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 fragColor;
void main() { fragColor = texture(u_tex, v_uv); }`;

// ── Indexed link draws (#447) ──────────────────────────────────────────────────────────────────────────────
// The same three link shaders, reading every per-instance input from per-EDGE tables resident as textures
// (edge e at texel (e % width, e / width)), indexed by the one per-instance attribute `a_edge`. A draw lists
// only the edges it shows (4 B each per frame) while the tables upload once per style / position change. The
// pick id is the edge id. Built from the attribute versions, so the geometry code is shared, not copied.

const EDGE_FETCH = `
in float a_edge;            // per-instance edge id (#447)
in float a_fade;            // per-instance alpha multiplier (the cross-fade band)
vec4 edgeFetch(highp sampler2D t) {
  int id = int(a_edge + 0.5);
  ivec2 sz = textureSize(t, 0);
  return texelFetch(t, ivec2(id % sz.x, id / sz.x), 0);
}`;

/** `vs` with the attribute inputs in `fields` turned into globals that `fetch` fills from the edge tables. */
function indexedVS(vs: string, fields: string[], samplers: string[], fetch: string): string {
  let out = vs;
  for (const f of fields) {
    const re = new RegExp(`\\nin (float|vec2|vec4) ${f};[^\\n]*`);
    if (!re.test(out)) throw new Error(`indexedVS: no attribute ${f}`);
    out = out.replace(re, (_m, type: string) => `\n${type} ${f};`);
  }
  const decl = samplers.map((u) => `\nuniform highp sampler2D ${u};`).join("") + EDGE_FETCH;
  out = out.replace("void main() {", `${decl}\nvoid fetchEdge() {${fetch}\n}\nvoid main() {\n  fetchEdge();`);
  out = out.replace("v_id = float(gl_InstanceID) + u_pickBase;", "v_id = a_edge + u_pickBase;");
  return out;
}

const HL_FIELDS = ["a_group", "a_group2", "a_selected"];
const SELECTED_FETCH = `
  a_color = edgeFetch(u_edgeColor);
  a_color.a *= a_fade;
  a_selected = edgeFetch(u_edgeSelected).r > 0.0 ? 1.0 : 0.0;`;

/** Lines by edge (the ends stay per-instance attributes); style0 (width, bend, group, group2); colour; selected. */
const LINE_FETCH = `
  vec4 s = edgeFetch(u_edgeStyle0);
  a_width = s.x;
  a_bend = s.y;
  a_group = s.z;
  a_group2 = s.w;${SELECTED_FETCH}`;
const LINE_FIELDS = ["a_width", "a_color", "a_bend", ...HL_FIELDS];
const LINE_SAMPLERS = ["u_edgeStyle0", "u_edgeColor", "u_edgeSelected"];
export const INDEXED_LINE_VS = indexedVS(INSTANCED_LINE_VS, LINE_FIELDS, LINE_SAMPLERS, LINE_FETCH);

/** Whole arrows by edge (#542): the line's tables plus an r32float target-radius table. */
export const INDEXED_HEAD_LINE_VS = indexedVS(
  INSTANCED_HEAD_LINE_VS,
  [...LINE_FIELDS, "a_radius"],
  [...LINE_SAMPLERS, "u_edgeRadius"],
  `${LINE_FETCH}
  a_radius = edgeFetch(u_edgeRadius).r;`,
);

/** Half-arrows by edge: style0 (r0, r1, width, oppositeWidth); style1 (bend, group, group2); colour; selected. */
export const INDEXED_HALF_ARROW_VS = indexedVS(
  INSTANCED_HALF_ARROW_VS,
  ["a_radii", "a_widths", "a_bend", "a_color", ...HL_FIELDS],
  ["u_edgeStyle0", "u_edgeStyle1", "u_edgeColor", "u_edgeSelected"],
  `
  vec4 s = edgeFetch(u_edgeStyle0);
  a_radii = s.xy;
  a_widths = s.zw;
  vec4 t = edgeFetch(u_edgeStyle1);
  a_bend = t.x;
  a_group = t.y;
  a_group2 = t.z;${SELECTED_FETCH}`,
);
