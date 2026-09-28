import type { Device, Texture, RenderPass } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL } from "../textures.js";
import { fullScreenModel, NO_BLEND, type PassUniforms } from "./fullscreen.js";

/**
 * Prolongation gather pass (N8.2 module-aware multilevel seed).
 *
 * Seeds a finer level's position texture from its parent level's positions in ONE GPU pass —
 * O(level size), fully parallel, NO CPU loop over the level (the hard constraint of #180). A
 * full-screen triangle covers the finer level's atlas; each fragment is one finer node (a "child"
 * at some tree slot). It reads that child's **parent slot** (a precomputed r32uint texture, one
 * texel per child), `texelFetch`es the parent's position from the coarser level's position texture,
 * and adds the child's precomputed **golden-angle offset** (an rg32float texture) so siblings that
 * share a parent separate into a phyllotaxis disc around it instead of landing coincident.
 *
 * The parent-slot map and the offset vectors are precomputed once on the CPU (O(tree size), part of
 * the depth/slot precompute in {@link ./../gpu-multilevel-seed.js}), so the only per-level work is
 * this gather. Writes `o_pos` once per texel (no blend).
 */
const FS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp usampler2D;

uniform sampler2D  u_parent_pos;   // coarser level positions (rg32float atlas)
uniform usampler2D u_parent_slot;  // per child → its parent's slot in the coarser atlas (r32uint)
uniform sampler2D  u_offset;       // per child → golden-angle offset (rg32float)
uniform int u_count;               // number of real children at this level
uniform int u_width;               // this (child) level's atlas width
uniform int u_parent_width;        // coarser level's atlas width
layout(location = 0) out vec2 o_pos;
${SLOT_TEXEL_GLSL}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int id = texelSlot(c, u_width);
  if (id >= u_count) { o_pos = vec2(0.0); return; }
  uint ps = texelFetch(u_parent_slot, c, 0).r;
  ivec2 pc = slotTexel(int(ps), u_parent_width);
  vec2 pp = texelFetch(u_parent_pos, pc, 0).xy;
  vec2 off = texelFetch(u_offset, c, 0).xy;
  o_pos = pp + off;
}
`;

/** Uniforms + bindings for one prolongation gather. */
export interface ProlongateInput {
  parentPosTex: Texture;
  parentSlotTex: Texture;
  offsetTex: Texture;
  /** Real children count at this level. */
  count: number;
  /** This (child) level's atlas width. */
  width: number;
  /** Coarser (parent) level's atlas width. */
  parentWidth: number;
}

/**
 * GPU prolongation pass — one instance reused across every level of the multilevel seed (the model
 * is atlas-size-agnostic: it reads `gl_FragCoord` and takes width/count as uniforms). The caller
 * opens a render pass on the finer level's position FBO and calls {@link run}.
 */
export class ProlongatePass {
  private readonly model: Model;
  private readonly uniforms: PassUniforms;

  constructor(device: Device) {
    this.uniforms = { u_count: 0, u_width: 1, u_parent_width: 1 };
    // Write each texel exactly once — no blend.
    this.model = fullScreenModel(device, FS, this.uniforms, NO_BLEND);
  }

  /** Gather child seed positions into an already-open render pass (the finer level's position FBO). */
  run(pass: RenderPass, u: ProlongateInput): void {
    this.uniforms["u_count"] = u.count;
    this.uniforms["u_width"] = u.width;
    this.uniforms["u_parent_width"] = u.parentWidth;
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
