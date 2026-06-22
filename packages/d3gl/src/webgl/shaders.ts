/**
 * GLSL 300 es shaders. The vertex shader applies the view transform and looks up
 * the per-drawable color from a palette texture indexed by drawableId via
 * texelFetch + textureSize (recolor = texture update, no geometry change). A
 * parallel R8 flags texture culls hidden drawables (visible flag in bit 0).
 */
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
in vec2 a_corner;           // per-vertex unit-quad corner in [-1, 1]
in vec2 a_center;           // per-instance world centre
in float a_radius;          // per-instance radius
in vec4 a_color;            // per-instance RGBA (unorm8x4 -> 0..1)
in float a_border;          // per-instance ring thickness as a fraction of radius (0 = no ring)
in vec4 a_borderColor;      // per-instance ring RGBA (unorm8x4 -> 0..1)
out vec4 v_color;
out vec2 v_local;
out float v_border;
out vec4 v_borderColor;
void main() {
  v_color = a_color;
  v_local = a_corner;
  v_border = a_border;
  v_borderColor = a_borderColor;
  vec3 c = u_transform * vec3(a_center, 1.0);
  vec2 off = (u_screen > 0.5)
    ? a_corner * a_radius * vec2(2.0 / u_viewport.x, -2.0 / u_viewport.y)
    : (u_transform * vec3(a_center + a_corner * a_radius, 1.0)).xy - c.xy;
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

// INSTANCED_LINE_VS — GPU-instanced "path-strip" lines for the network lane (#100, bent #104 N6c).
// The per-vertex template a_corner = (t, side): t in [0,1] walks the path (M samples), side in
// {-1,1} picks the edge. Per-instance source/target/width/color/bend. The path is a quadratic
// bezier whose control point is the chord midpoint offset perpendicular by `a_bend` (a fraction of
// the chord length); `a_bend = 0` ⇒ the control sits on the chord ⇒ a straight line (so straight
// links draw exactly as before, at M=2). The strip offsets each sample by the *tangent's*
// perpendicular, so a continuous strip gets its joins for free. Pairs with FILL_FS.
export const INSTANCED_LINE_VS = `#version 300 es
precision highp float;
uniform mat3 u_transform;
uniform float u_screen;     // 1.0 = constant-px width, 0.0 = world width (scales with zoom)
uniform vec2 u_viewport;    // device px, for screen mode
in vec2 a_corner;           // per-vertex (t in [0,1], side in {-1,1})
in vec2 a_source;           // per-instance world source
in vec2 a_target;           // per-instance world target
in float a_width;           // per-instance line width
in vec4 a_color;            // per-instance RGBA (unorm8x4 -> 0..1)
in float a_bend;            // per-instance control offset ⟂ to the chord, as a fraction of |chord| (0 = straight)
out vec4 v_color;
void main() {
  v_color = a_color;
  float t = a_corner.x;
  float side = a_corner.y;
  float hw = a_width * 0.5;
  vec2 d = a_target - a_source;
  vec2 ctrl = 0.5 * (a_source + a_target) + vec2(-d.y, d.x) * a_bend; // ⟂(chord) · bend
  float u = 1.0 - t;
  vec2 p = u * u * a_source + 2.0 * u * t * ctrl + t * t * a_target;  // B(t)
  vec2 tang = 2.0 * u * (ctrl - a_source) + 2.0 * t * (a_target - ctrl); // B'(t)
  vec2 cp = (u_transform * vec3(p, 1.0)).xy;          // centreline point in clip
  vec2 off;
  if (u_screen > 0.5) {
    // Constant-pixel width: tangent's perpendicular derived in screen px, converted back to clip.
    vec2 ctan = (u_transform * vec3(p + tang, 1.0)).xy;
    vec2 dir = normalize((ctan - cp) * u_viewport);   // clip delta -> px direction
    vec2 perp = vec2(-dir.y, dir.x);
    off = perp * side * hw * (2.0 / u_viewport);      // px -> clip
  } else {
    // World width: offset the centreline point in world space along the tangent's perpendicular.
    vec2 dir = normalize(tang);
    vec2 perp = vec2(-dir.y, dir.x);
    off = (u_transform * vec3(p + perp * side * hw, 1.0)).xy - cp;
  }
  gl_Position = vec4(cp + off, 0.0, 1.0);
}`;

// INSTANCED_ARROW_VS — instanced triangle arrowheads for directed links (#100; bent + half #104 N6c).
// One triangle per instance: per-vertex a_tri = (back, across), tip (0,0); the symmetric template
// has base (2,-1)/(2,1), the half template (2,0)/(2,1) (one-sided, for bent map links so reciprocal
// arrows don't collide). The tip sits at a_target, oriented along the bezier's *end* tangent (so it
// aligns with a bent link), scaled by a_size (world units). a_bend = 0 ⇒ oriented along the chord,
// as before. Pairs with FILL_FS. World-sized for now.
export const INSTANCED_ARROW_VS = `#version 300 es
precision highp float;
uniform mat3 u_transform;
in vec2 a_tri;        // per-vertex (back, across)
in vec2 a_source;     // per-instance world source (orientation)
in vec2 a_target;     // per-instance world tip
in float a_size;      // per-instance arrow size (world units)
in float a_bend;      // per-instance bend, matching the link's, so the head aligns with its end tangent
in vec4 a_color;
out vec4 v_color;
void main() {
  v_color = a_color;
  vec2 d = a_target - a_source;
  // Quadratic-bezier end tangent (t=1): 2·(P1 − C), C = midpoint + ⟂(chord)·bend.
  vec2 endTan = 0.5 * d - vec2(-d.y, d.x) * a_bend;
  vec2 dir = normalize(endTan);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 world = a_target - dir * (a_tri.x * a_size) + perp * (a_tri.y * a_size);
  gl_Position = vec4((u_transform * vec3(world, 1.0)).xy, 0.0, 1.0);
}`;

// INSTANCED_HALF_ARROW_VS — the "map of networks" directed-link glyph (#104 N6): one filled shape
// per link that pinches to the source centre, bows around a shared centre curve, and ends in a barbed
// arrowhead whose tip lands on the *target node's boundary*. A reciprocal A→B / B→A pair shares the
// centre curve (the direction-based `positiveCurvature` rule fixes the side) and fills opposite halves
// of it, so the two arrows nest. This is the same math as network/half-link.ts (the SVG/Canvas source
// of truth, golden-tested vs the reference), mirrored here so the WebGL lane stays fully instanced.
// Per-vertex a_kind = (code, t): code selects a named anchor (0 x0, 1 x02, 2 x03, 3 x04, 4 x11,
// 5 x12, 6 x13, 7 x14) or evaluates the inner (8) / outer (9) edge bezier at parameter t; the template
// (see instanced.ts) lists the foot, body strip and head as a triangle list. World-sized. Pairs with
// FILL_FS. `a_bend` is the absolute perpendicular offset in world units (sign = bow direction).
export const INSTANCED_HALF_ARROW_VS = `#version 300 es
precision highp float;
uniform mat3 u_transform;
in vec2 a_kind;       // per-vertex (code, t)
in vec2 a_p0;         // per-instance source centre
in vec2 a_p1;         // per-instance target centre
in vec2 a_radii;      // per-instance (r0, r1)
in vec2 a_widths;     // per-instance (width, oppositeWidth)
in float a_bend;      // per-instance bend (world units; sign picks the bow side)
in vec4 a_color;      // per-instance RGBA (unorm8x4 -> 0..1)
out vec4 v_color;
vec2 bez(vec2 p0, vec2 c, vec2 p2, float t) {
  float u = 1.0 - t;
  return u * u * p0 + 2.0 * u * t * c + t * t * p2;
}
void main() {
  v_color = a_color;
  float code = a_kind.x;
  float t = a_kind.y;
  vec2 p0 = a_p0;
  vec2 p1 = a_p1;
  float r0 = a_radii.x;
  float r1 = a_radii.y;
  float width = a_widths.x;
  float oppositeWidth = a_widths.y;

  vec2 d = p1 - p0;
  float l = length(d);
  float lBetween = l - r0 - r1;
  vec2 dir = d / l;
  vec2 right = vec2(-dir.y, dir.x);

  float tipLength = min(lBetween / 3.0, 10.0 * pow(width, 1.0 / 3.0));
  float tipWidth = 2.0 * sqrt(width);
  float oppositeTipLength = min(lBetween / 3.0, 10.0 * pow(oppositeWidth, 1.0 / 3.0));

  float bendMagnitude = abs(a_bend);
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
  vec2 x14 = x13 + tipWidth * left1;

  vec2 pos;
  if (code < 0.5) pos = p0;
  else if (code < 1.5) pos = x02;
  else if (code < 2.5) pos = x03;
  else if (code < 3.5) pos = x04;
  else if (code < 4.5) pos = x11;
  else if (code < 5.5) pos = x12;
  else if (code < 6.5) pos = x13;
  else if (code < 7.5) pos = x14;
  else if (code < 8.5) pos = bez(x02, cp1, x12, t);
  else pos = bez(x03, cp2, x13, t);

  gl_Position = vec4((u_transform * vec3(pos, 1.0)).xy, 0.0, 1.0);
}`;

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
