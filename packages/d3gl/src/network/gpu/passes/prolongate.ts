import type { Device, Texture, RenderPass } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL } from "../textures.js";
import { fullScreenProgram, layoutModel, NO_BLEND, type PassUniforms } from "./fullscreen.js";
import type { LayoutProgram } from "../programs.js";

/**
 * Prolongation gather pass (the multilevel seed, #180 / #353).
 *
 * Seeds a finer level's positions from the level above in ONE GPU pass — O(level size), fully parallel,
 * no CPU loop over the level. A full-screen triangle covers the solver's slot atlas; each fragment is one
 * slot of the finer level. It reads that slot's **parent slot** (an `r32uint` texel), fetches the parent's
 * position from the level above, and adds the slot's precomputed **phyllotaxis offset**, so siblings that
 * share a parent spread into a disc around it instead of landing coincident. Both levels live in the one
 * solver's atlas (same width), so a parent slot maps to its texel with the same function.
 *
 * It renders by MRT into the solver's write side: the position (location 0) and a **zero velocity**
 * (location 1). After the ping-pong swap that zero is the velocity the level's first tick reads, so no slot
 * inherits the velocity of the unrelated slot that held its index on the level above (spec §6.4). Padded
 * texels write zeros. No blend: every texel is written once.
 */
const FS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform sampler2D  u_parent_pos;   // the level above's positions (the solver's read side)
uniform usampler2D u_parent_slot;  // per slot → its parent's slot (r32uint, slot atlas)
uniform sampler2D  u_offset;       // per slot → its offset from the parent (rg32float, slot atlas)
uniform int u_count;               // slots of this level
uniform int u_width;               // slot atlas width
layout(location = 0) out vec2 o_pos;
layout(location = 1) out vec2 o_vel;
${SLOT_TEXEL_GLSL}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int id = texelSlot(c, u_width);
  o_vel = vec2(0.0);
  if (id >= u_count) { o_pos = vec2(0.0); return; }
  uint ps = texelFetch(u_parent_slot, c, 0).r;
  vec2 pp = texelFetch(u_parent_pos, slotTexel(int(ps), u_width), 0).xy;
  o_pos = pp + texelFetch(u_offset, c, 0).xy;
}
`;

/** Uniforms + bindings for one prolongation gather. */
export interface ProlongateInput {
  /** The level above's positions. */
  parentPosTex: Texture;
  /** Per slot: its parent's slot. */
  parentSlotTex: Texture;
  /** Per slot: its offset from the parent. */
  offsetTex: Texture;
  /** Slots of this level. */
  count: number;
  /** Slot atlas width (shared by every texture above). */
  width: number;
}

/** The prolongation's program (#385). */
export function prolongateProgram(): LayoutProgram {
  return fullScreenProgram(FS);
}

/**
 * GPU prolongation pass — one instance reused for every level of the multilevel seed (its model reads
 * `gl_FragCoord` and takes the width and count as uniforms). The caller opens a render pass on the solver's
 * MRT `[position, velocity]` write framebuffer and calls {@link run}.
 */
export class ProlongatePass {
  private readonly model: Model;
  private readonly uniforms: PassUniforms;

  constructor(device: Device) {
    this.uniforms = { u_count: 0, u_width: 1 };
    this.model = layoutModel(device, prolongateProgram(), this.uniforms, NO_BLEND);
  }

  /** Gather the level's seed positions (and zero velocities) into an already-open MRT render pass. */
  run(pass: RenderPass, u: ProlongateInput): void {
    this.uniforms["u_count"] = u.count;
    this.uniforms["u_width"] = u.width;
    this.model.setBindings({
      u_parent_pos: u.parentPosTex,
      u_parent_slot: u.parentSlotTex,
      u_offset: u.offsetTex,
    });
    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
  }
}
