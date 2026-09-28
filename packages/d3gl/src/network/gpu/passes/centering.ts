import type { Device, Texture, RenderPass } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL } from "../textures.js";
import { SEGMENT_OF_GLSL, segmentDefines } from "../segment-table.js";
import { ADDITIVE_BLEND, fullScreenModel, type PassUniforms } from "./fullscreen.js";

// ─────────────────────────────────────────────────────────────────────────────
// CenteringPass
// ─────────────────────────────────────────────────────────────────────────────
//
// Full-screen triangle pass over nodes. Each node reads its segment's statistics from the segment
// table — `stats = (Σx, Σy, Σ|v|, count)`, written this tick by the range query of
// {@link SegmentedReduce} — and its segment's centering strength from `param.y`, and writes
//   o_force = centering * (Σpos / max(count, 1) − pos_i)
// into the force texture with additive blend (accumulating alongside repulsion + attraction).
// Padded texels are discarded (no loops here, so `discard` is safe — see AGENTS.md #350).
//
// The flat layout has one segment, so the segment id is a compile-time constant (SINGLE_SEGMENT) and
// every node reads texel (0, 0) of the 1×1 table textures. With more segments each node reads its
// segment id from `u_slotSeg` and pulls toward its OWN segment's centroid.

// NOTE: `centroid` is a GLSL ES 3.00 reserved keyword — do not use as a variable
// name. Use `cx` (centroid x/y pair) or another non-keyword identifier.
function centerFs(singleSegment: boolean): string {
  return /* glsl */ `\
#version 300 es
${segmentDefines(singleSegment)}
precision highp float;
// Not optional: a fragment shader's defaults are lowp sampler2D and mediump int, and u_segStats
// carries raw sums (|Σx| up to N·max|x|, ~4e9 at 325k) while slot ids and u_count exceed mediump's 2^15.
precision highp int;
precision highp sampler2D;

uniform highp sampler2D u_pos;
uniform highp sampler2D u_segStats;  // (Σx, Σy, Σ|v|, count) per segment
uniform highp sampler2D u_segParam;  // (repulsion, centering, softening, alpha0) per segment
uniform int   u_count;
uniform int   u_width;
layout(location = 0) out vec2 o_force;
${SLOT_TEXEL_GLSL}
${SEGMENT_OF_GLSL}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int id = texelSlot(c, u_width);
  if (id >= u_count) { discard; }

  ivec2 st = segmentTexelOf(c);
  vec2 pos_i = texelFetch(u_pos, c, 0).xy;
  vec4 stats = texelFetch(u_segStats, st, 0);
  float centering = texelFetch(u_segParam, st, 0).y;
  // cx = the segment's centroid ('centroid' is a GLSL reserved keyword — avoid it). max(count, 1):
  // an empty segment yields a zero centroid, never NaN.
  vec2 cx = stats.xy / max(stats.w, 1.0);

  o_force = centering * (cx - pos_i);
}
`;
}

/** Uniforms consumed by the centering force pass. */
export interface CenteringUniforms {
  count: number;
  width: number;
}

/** The segment-table textures the centering pass reads. */
export interface CenteringSegments {
  /** `(Σx, Σy, Σ|v|, count)` per segment — this tick's range-query output. */
  stats: Texture;
  /** `(repulsion, centering, softening, alpha0)` per segment. */
  param: Texture;
  /** Segment-table atlas width. */
  width: number;
}

/**
 * Full-screen triangle centering force pass. Reads the segment table's `stats` (produced this tick
 * by the range query) and centering strength, and writes `centering * (centroid − pos_i)` into the
 * force texture with additive blend. Runs INSIDE the force-accumulation render pass, after the
 * range query's own pass has been encoded.
 */
export class CenteringPass {
  private readonly model: Model;
  private readonly uniforms: PassUniforms;
  private readonly singleSegment: boolean;

  /** @param singleSegment S = 1 (the flat layout): the segment id is the constant 0, no `slotSeg`. */
  constructor(device: Device, singleSegment: boolean) {
    this.singleSegment = singleSegment;
    this.uniforms = {
      u_count: 0,
      u_width: 1,
      u_tableWidth: 1,
    };
    // Additive blend: accumulate alongside repulsion + attraction.
    this.model = fullScreenModel(device, centerFs(singleSegment), this.uniforms, ADDITIVE_BLEND);
  }

  /**
   * Draw centering forces into an already-open force-accumulation render pass. `slotSeg` (the segment
   * id per slot) is required with more than one segment and ignored with one.
   */
  run(pass: RenderPass, posTex: Texture, segments: CenteringSegments, u: CenteringUniforms, slotSeg: Texture | null): void {
    this.uniforms["u_count"] = u.count;
    this.uniforms["u_width"] = u.width;
    this.uniforms["u_tableWidth"] = segments.width;
    if (this.singleSegment) {
      this.model.setBindings({ u_pos: posTex, u_segStats: segments.stats, u_segParam: segments.param });
    } else {
      if (!slotSeg) throw new Error("CenteringPass: a many-segment layout needs the slot → segment texture");
      this.model.setBindings({ u_pos: posTex, u_segStats: segments.stats, u_segParam: segments.param, u_slotSeg: slotSeg });
    }
    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
  }
}
