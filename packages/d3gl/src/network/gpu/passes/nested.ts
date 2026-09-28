import type { Device, RenderPass, Texture } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL } from "../textures.js";
import { SEGMENT_OF_GLSL, segmentDefines } from "../segment-table.js";
import { fullScreenModel, NO_BLEND, type PassUniforms } from "./fullscreen.js";

// ─────────────────────────────────────────────────────────────────────────────
// The nested layout's per-slot integration passes (#355, spec §11.1).
// ─────────────────────────────────────────────────────────────────────────────
//
// The CPU nested solve (nested-layout.ts solveModule) runs, per tick and module:
//
//   v += repulsion(alpha)          (organise phase only)
//   v -= x · GRAVITY · alpha       (toward the local origin)
//   v += link corrections read at the predictor x + v, split by size, times alpha · w · 0.5
//   v *= 1 − DECAY;  x += v
//   collide (compact phase only; position-based)
//
// The batched GPU solve runs every module at once, and in two passes around the spring gather:
//
// - PREDICT writes v* = v + alpha · Σrepulsion − x · GRAVITY · alpha — the velocity the CPU springs see
//   (the repulsion sum was accumulated into the force texture by the repulsion pass, with the segment's
//   strength, so alpha is applied here);
// - the spring gather (attraction.ts, nested variant) sums every slot's link corrections at x + v*, and
// - INTEGRATE writes v' = (v* + 0.5 · alpha · Σsprings) · (1 − DECAY) and x' = x + v' by MRT.
//
// The one difference from the CPU is Jacobi vs Gauss-Seidel: the CPU applies its links one after
// another (each reads the velocities the previous ones changed); here every link reads the same v*
// (spec §11.1, Q6: covered by the documented tolerance). No step clamp and no velocity stabilizer: the CPU
// nested solve has neither. Summed at once, a hub's springs can overshoot where the CPU's cannot, so a slot
// past the Jacobi bound has its spring terms relaxed (`NestedSolverTopology.springScale`, folded into its
// CSR row weights: nothing here reads it).
//
// Each segment's alpha follows its own schedule from `segParam.w` (alpha0: 1 cold, WARM_ALPHA warm,
// #328). The CPU decays alpha by a float64 recurrence per module; the solver replays it on the CPU for
// both starts and passes the two current values as uniforms, so the shader only picks one.

/** GLSL: the current alpha of a segment, from its `segParam` texel. Needs `u_alphaCold` / `u_alphaWarm`. */
const ALPHA_GLSL = /* glsl */ `\
uniform float u_alphaCold; // this tick's alpha of a segment that started at 1
uniform float u_alphaWarm; // …and of one that started warm (alpha0 < 1)
float alphaOf(vec4 param) { return param.w == 1.0 ? u_alphaCold : u_alphaWarm; }
`;

const PREDICT_FS = /* glsl */ `\
#version 300 es
${segmentDefines(false)}
precision highp float;
precision highp int;
precision highp usampler2D;
uniform highp sampler2D u_pos;
uniform highp sampler2D u_vel;
uniform highp sampler2D u_force;    // Σ repulsion (the segment's strength applied), organise phase
uniform highp sampler2D u_segParam; // (repulsion, gravity, softening, alpha0) per segment
uniform int u_count;
uniform int u_width;
uniform float u_repel;              // 1 in the organise phase: add the repulsion sum
${ALPHA_GLSL}
layout(location = 0) out vec2 o_vstar;
${SLOT_TEXEL_GLSL}
${SEGMENT_OF_GLSL}
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  if (texelSlot(fc, u_width) >= u_count) { o_vstar = vec2(0.0); return; }
  vec4 param = texelFetch(u_segParam, segmentTexelOf(fc), 0);
  float alpha = alphaOf(param);
  vec2 x = texelFetch(u_pos, fc, 0).xy;
  vec2 v = texelFetch(u_vel, fc, 0).xy;
  if (u_repel > 0.5) v += alpha * texelFetch(u_force, fc, 0).xy;
  o_vstar = v - x * param.y * alpha;
}
`;

const INTEGRATE_FS = /* glsl */ `\
#version 300 es
${segmentDefines(false)}
precision highp float;
precision highp int;
precision highp usampler2D;
uniform highp sampler2D u_pos;
uniform highp sampler2D u_vstar;
uniform highp sampler2D u_springs;  // Σ link corrections without 0.5 · alpha
uniform highp sampler2D u_segParam;
uniform int u_count;
uniform int u_width;
uniform float u_keep;               // 1 − DECAY
${ALPHA_GLSL}
layout(location = 0) out vec2 o_pos;
layout(location = 1) out vec2 o_vel;
${SLOT_TEXEL_GLSL}
${SEGMENT_OF_GLSL}
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  if (texelSlot(fc, u_width) >= u_count) { o_pos = vec2(0.0); o_vel = vec2(0.0); return; }
  float alpha = alphaOf(texelFetch(u_segParam, segmentTexelOf(fc), 0));
  vec2 v = (texelFetch(u_vstar, fc, 0).xy + texelFetch(u_springs, fc, 0).xy * (0.5 * alpha)) * u_keep;
  o_vel = v;
  o_pos = texelFetch(u_pos, fc, 0).xy + v;
}
`;

/** Inputs every nested per-slot pass shares. */
export interface NestedSlotInputs {
  /** Real slots and the slot atlas width. */
  count: number;
  width: number;
  /** Segment id per slot (`r32uint`, slot atlas) and the segment table's `param` texture and width. */
  slotSeg: Texture;
  segParam: Texture;
  tableWidth: number;
  /** This tick's alpha of a cold-started and of a warm-started segment. */
  alphaCold: number;
  alphaWarm: number;
}

/** Set the shared uniforms and bindings of a nested per-slot pass. */
function shared(u: PassUniforms, b: Record<string, Texture>, input: NestedSlotInputs): void {
  u["u_count"] = input.count;
  u["u_width"] = input.width;
  u["u_tableWidth"] = input.tableWidth;
  u["u_alphaCold"] = input.alphaCold;
  u["u_alphaWarm"] = input.alphaWarm;
  b["u_slotSeg"] = input.slotSeg;
  b["u_segParam"] = input.segParam;
}

/** The PREDICT pass: v* per slot, drawn into an open pass on the v* framebuffer (no blend). */
export class NestedPredictPass {
  private readonly model: Model;
  private readonly uniforms: PassUniforms;

  constructor(device: Device) {
    this.uniforms = { u_count: 0, u_width: 1, u_tableWidth: 1, u_repel: 0, u_alphaCold: 0, u_alphaWarm: 0 };
    this.model = fullScreenModel(device, PREDICT_FS, this.uniforms, NO_BLEND);
  }

  /** `force` holds the repulsion sum when `repel` (the organise phase); it is not read otherwise. */
  run(pass: RenderPass, pos: Texture, vel: Texture, force: Texture, repel: boolean, input: NestedSlotInputs): void {
    const bindings: Record<string, Texture> = { u_pos: pos, u_vel: vel, u_force: force };
    shared(this.uniforms, bindings, input);
    this.uniforms["u_repel"] = repel ? 1 : 0;
    this.model.setBindings(bindings);
    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
  }
}

/** The INTEGRATE pass: x' and v' per slot by MRT, drawn into an open pass on the `[pos, vel]` write pair. */
export class NestedIntegratePass {
  private readonly model: Model;
  private readonly uniforms: PassUniforms;

  constructor(device: Device, keep: number) {
    this.uniforms = { u_count: 0, u_width: 1, u_tableWidth: 1, u_keep: keep, u_alphaCold: 0, u_alphaWarm: 0 };
    this.model = fullScreenModel(device, INTEGRATE_FS, this.uniforms, NO_BLEND);
  }

  run(pass: RenderPass, pos: Texture, vstar: Texture, springs: Texture, input: NestedSlotInputs): void {
    const bindings: Record<string, Texture> = { u_pos: pos, u_vstar: vstar, u_springs: springs };
    shared(this.uniforms, bindings, input);
    this.model.setBindings(bindings);
    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
  }
}
