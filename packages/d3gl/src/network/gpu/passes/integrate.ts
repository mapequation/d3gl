import type { Device, Texture, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";

/**
 * Full-screen triangle vertex shader. Emits a clip-space triangle that covers
 * the entire viewport so each fragment corresponds to exactly one texel.
 */
const VS = /* glsl */ `\
#version 300 es
in vec2 a_clip;
void main() { gl_Position = vec4(a_clip, 0.0, 1.0); }
`;

/**
 * Integrate pass fragment shader.
 *
 * Each fragment maps to one node (id = c.y * u_width + c.x). Reads the current
 * position, velocity, and accumulated force, applies integration
 * (v' = clamp((v + f·α)·damping, ±maxStep); p' = p + v'), and writes the new
 * position and velocity via MRT to locations 0 and 1 respectively.
 *
 * With all force strengths set to 0 the force texture is all-zeros, so v and p
 * are unchanged — the zero-force invariant the test relies on.
 */
const FS = /* glsl */ `\
#version 300 es
precision highp float;
uniform sampler2D u_pos;
uniform sampler2D u_vel;
uniform sampler2D u_force;
uniform int u_count;
uniform int u_width;
uniform float u_alpha;
uniform float u_damping;
uniform float u_maxStep;
layout(location = 0) out vec2 o_pos;
layout(location = 1) out vec2 o_vel;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int id = c.y * u_width + c.x;
  if (id >= u_count) { o_pos = vec2(0.0); o_vel = vec2(0.0); return; }
  vec2 p = texelFetch(u_pos,   c, 0).xy;
  vec2 v = texelFetch(u_vel,   c, 0).xy;
  vec2 f = texelFetch(u_force, c, 0).xy;
  vec2 s = clamp((v + f * u_alpha) * u_damping, vec2(-u_maxStep), vec2(u_maxStep));
  o_vel = s;
  o_pos = p + s;
}
`;

/** Uniforms consumed by the integrate pass. */
export interface IntegrateUniforms {
  count: number;
  width: number;
  alpha: number;
  damping: number;
  maxStep: number;
}

/**
 * GPU integrate pass. Holds the full-screen triangle model; the caller is
 * responsible for creating the MRT framebuffer and swapping ping-pongs.
 *
 * Uniforms are stored in a mutable object and read by Model on every draw
 * (luma.gl v9 pattern: pass `uniforms: sharedObj` at construction, mutate in-place).
 * Samplers are updated via `model.setBindings(...)`.
 */
export class IntegratePass {
  private readonly model: Model;
  /** Mutable uniforms dict — mutated before each draw so Model picks them up. */
  private readonly uniforms: Record<string, number>;

  constructor(device: Device) {
    // Full-screen triangle: three vertices cover the [-1,1] clip square.
    const clipBuf = device.createBuffer({
      data: new Float32Array([-1, -1, 3, -1, -1, 3]),
    });

    this.uniforms = {
      u_count: 0,
      u_width: 1,
      u_alpha: 0,
      u_damping: 0.9,
      u_maxStep: 1e9,
    };

    this.model = new Model(device, {
      vs: VS,
      fs: FS,
      topology: "triangle-list",
      vertexCount: 3,
      attributes: { a_clip: clipBuf },
      bufferLayout: [{ name: "a_clip", format: "float32x2" }],
      uniforms: this.uniforms,
    });
  }

  /** Draw one integrate step into an already-open render pass. */
  run(
    pass: RenderPass,
    posTex: Texture,
    velTex: Texture,
    forceTex: Texture,
    u: IntegrateUniforms,
  ): void {
    // Mutate the shared uniforms object in-place — Model reads this.props.uniforms
    // on every draw() call (same pattern as renderer.ts / globe.ts).
    this.uniforms["u_count"] = u.count;
    this.uniforms["u_width"] = u.width;
    this.uniforms["u_alpha"] = u.alpha;
    this.uniforms["u_damping"] = u.damping;
    this.uniforms["u_maxStep"] = u.maxStep;

    // Update sampler bindings for this tick's read textures.
    this.model.setBindings({ u_pos: posTex, u_vel: velTex, u_force: forceTex });

    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
  }
}
