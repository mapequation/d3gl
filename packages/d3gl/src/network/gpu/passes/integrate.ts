import type { Device, Texture, RenderPass } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL } from "../textures.js";
import { fullScreenProgram, layoutModel, NO_BLEND, type PassUniforms } from "./fullscreen.js";
import type { LayoutProgram } from "../programs.js";
import { STOP_LATCH_GLSL } from "./stop-latch.js";

/**
 * Integrate pass fragment shader.
 *
 * Each fragment maps to one node (id = c.y * u_width + c.x). Reads the current
 * position, velocity, and accumulated force, applies integration
 * (v' = (v + f·α)·damping·stab, |v'| clamped to maxStep; p' = p + v' — α already carries the
 * cooling heat, #124), and writes
 * the new position and velocity via MRT to locations 0 and 1 respectively.
 * `stab` is the per-node 1/(1+K̃) spring-stiffness stabilizer (#203) and the step
 * clamp is ISOTROPIC (vector magnitude, mirroring CPU force.ts) — a component-wise
 * clamp would send every runaway step along ±45°, piling nodes into the corners of
 * an axis-aligned square.
 *
 * With all force strengths set to 0 the force texture is all-zeros, so v and p
 * are unchanged — the zero-force invariant the test relies on.
 *
 * Pinned nodes (#183 GPU drag reheat) mirror force.ts `setPinned`: a per-node flag
 * texture (`u_pinned`, 0/1) marks the held set. A pinned node is **skipped by
 * integration** — its position is owned externally (the drag session writes the cursor
 * position into `u_pos` each move) and its velocity is zeroed — but it still contributed
 * to the repulsion/attraction/centering passes above as a fixed obstacle / spring anchor.
 *
 * The convergence stop (#376): the stop latch (`u_stop`, one texel written by this tick's prep) freezes
 * the integrate — every position and velocity passes through unchanged — once it has latched a stop in
 * the current schedule (`u_epoch`), or for good once the reductions came back non-finite. So ticks the
 * transport encodes before it learns of the stop leave the stop tick's layout, as the CPU loop would by
 * not ticking at all. A stop of an older schedule (the latch texel's epoch ≠ `u_epoch`) does not freeze:
 * a drag that started a new schedule mid-tick integrates at once.
 */
const FS = /* glsl */ `\
#version 300 es
precision highp float;
uniform sampler2D u_pos;
uniform sampler2D u_vel;
uniform sampler2D u_force;
uniform sampler2D u_pinned;
uniform sampler2D u_stab; // per-node 1/(1+K̃) spring-stiffness stabilizer (#203)
uniform highp sampler2D u_stop; // the stop latch (prevStep, stopTick, epoch, flags) (#376)
uniform int u_count;
uniform int u_width;
uniform float u_alpha;
uniform float u_damping;
uniform float u_maxStep;
uniform float u_epoch; // the current schedule (#376)
layout(location = 0) out vec2 o_pos;
layout(location = 1) out vec2 o_vel;
${SLOT_TEXEL_GLSL}
${STOP_LATCH_GLSL}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int id = texelSlot(c, u_width);
  if (id >= u_count) { o_pos = vec2(0.0); o_vel = vec2(0.0); return; }
  vec2 p = texelFetch(u_pos,   c, 0).xy;
  vec2 v = texelFetch(u_vel,   c, 0).xy;
  // Stopped (#376): the layout converged in this schedule, or went non-finite — pass everything through.
  vec4 stop = texelFetch(u_stop, ivec2(0), 0);
  uint flags = uint(stop.w);
  if ((flags & STOP_NONFINITE) != 0u || ((flags & STOP_STOPPED) != 0u && stop.z == u_epoch)) {
    o_pos = p; o_vel = v; return;
  }
  // Held node (#183): keep it exactly where the drag put it, drop its velocity so it
  // doesn't lurch on release. It still repelled + anchored springs via the force passes.
  if (texelFetch(u_pinned, c, 0).r > 0.5) { o_pos = p; o_vel = vec2(0.0); return; }
  vec2 f = texelFetch(u_force, c, 0).xy;
  // Per-node semi-implicit spring stabilizer (#203): scaling the velocity update by 1/(1+K̃)
  // keeps a hub's aggregate spring stiffness unconditionally stable (mirrors CPU force.ts).
  float st = texelFetch(u_stab, c, 0).r;
  vec2 s = (v + f * u_alpha) * u_damping * st;
  // Isotropic step clamp (#203): scale the vector, never per-axis (see file header).
  float len = length(s);
  if (len > u_maxStep) s *= u_maxStep / len;
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
  /** The current schedule's epoch: a stop latched in it freezes the integrate (#376). */
  epoch: number;
}

/** The integrate pass's program (#385). */
export function integrateProgram(): LayoutProgram {
  return fullScreenProgram(FS);
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
  private readonly uniforms: PassUniforms;

  constructor(device: Device) {
    this.uniforms = {
      u_count: 0,
      u_width: 1,
      u_alpha: 0,
      u_damping: 0.9,
      u_maxStep: 1e9, // placeholder default — always overwritten in run() with the layout's step cap
      u_epoch: 0,
    };

    // Each output texel is written exactly once (MRT pos + vel), so no blend.
    this.model = layoutModel(device, integrateProgram(), this.uniforms, NO_BLEND);
  }

  /** Draw one integrate step into an already-open render pass. */
  run(
    pass: RenderPass,
    posTex: Texture,
    velTex: Texture,
    forceTex: Texture,
    pinnedTex: Texture,
    stabTex: Texture,
    stopTex: Texture,
    u: IntegrateUniforms,
  ): void {
    // Mutate the shared uniforms object in-place — Model reads this.props.uniforms
    // on every draw() call (same pattern as renderer.ts / globe.ts).
    this.uniforms["u_count"] = u.count;
    this.uniforms["u_width"] = u.width;
    this.uniforms["u_alpha"] = u.alpha;
    this.uniforms["u_damping"] = u.damping;
    this.uniforms["u_maxStep"] = u.maxStep;
    this.uniforms["u_epoch"] = u.epoch;

    // Update sampler bindings for this tick's read textures. `u_pinned` is the per-node
    // held-flag texture (all-zero when nothing is pinned → normal integration everywhere); `u_stop` the
    // stop latch's current texel.
    this.model.setBindings({ u_pos: posTex, u_vel: velTex, u_force: forceTex, u_pinned: pinnedTex, u_stab: stabTex, u_stop: stopTex });

    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
  }
}
