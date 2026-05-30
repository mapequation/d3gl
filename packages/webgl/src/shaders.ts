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
in vec2 a_position;
in float a_drawableId;
out vec4 v_color;
flat out float v_id;
void main() {
  int id = int(a_drawableId + 0.5);
  v_id = a_drawableId;
  ivec2 cs = textureSize(u_colorTable, 0);
  v_color = texelFetch(u_colorTable, ivec2(id % cs.x, id / cs.x), 0);
  ivec2 fsz = textureSize(u_flags, 0);
  float vis = texelFetch(u_flags, ivec2(id % fsz.x, id / fsz.x), 0).r;
  if (vis <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside clip space -> culled
    return;
  }
  vec3 p = u_transform * vec3(a_position, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

export const FILL_FS = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }`;

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
