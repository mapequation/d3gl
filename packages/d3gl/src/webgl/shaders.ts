/**
 * GLSL 300 es shaders. The vertex shader applies the view transform and looks up
 * the per-drawable color from a palette texture indexed by drawableId via
 * texelFetch + textureSize (recolor = texture update, no geometry change). A
 * parallel R8 flags texture culls hidden drawables (visible flag in bit 0).
 */
export const FILL_VS = `#version 300 es
precision highp float;
uniform mat3 u_transform;
uniform highp sampler2D u_colorTable;
uniform highp sampler2D u_flags;
uniform float u_screen;     // 1.0 = screen sizeMode (constant px), 0.0 = world
uniform vec2 u_viewport;    // device px, for screen sizeMode
in vec2 a_position;
in vec2 a_anchor;
in float a_drawableId;
out vec4 v_color;
flat out float v_id;
void main() {
  int id = int(a_drawableId + 0.5);
  v_id = a_drawableId;
  ivec2 cs = textureSize(u_colorTable, 0);
  v_color = texelFetch(u_colorTable, ivec2(id % cs.x, id / cs.x), 0);
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
  v_uv = vec2(a_lonLat.x / 360.0 + 0.5, 0.5 - a_lonLat.y / 180.0);
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
