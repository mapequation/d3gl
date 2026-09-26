import type { Device, Texture, RenderPass } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL } from "../textures.js";
import { ADDITIVE_BLEND, fullScreenModel, type PassUniforms } from "./fullscreen.js";

/**
 * All-pairs O(n²) repulsion pass — correctness baseline (Task 3).
 *
 * Each fragment maps to node id = c.y * u_width + c.x. It loops over all
 * other nodes j, accumulates the softened repulsion force
 *   f = u_repulsion / (|pi - pj|² + SOFTENING)
 * in the direction (pi − pj), and writes the sum into o_force.
 *
 * Matches quadtree.ts's leaf/direct branch exactly:
 *   SOFTENING = 1e-2
 *   dx = xi - xj; dy = yi - yj
 *   d2 = dx*dx + dy*dy
 *   f = repulsion / (d2 + SOFTENING)
 *   ax += f*dx; ay += f*dy
 *
 * Padded texels (id >= u_count) are discarded — with additive blending this
 * prevents garbage writes to the padded force texels.
 *
 * Safety cap: the loop runs up to u_count which is bounded by the n passed at
 * construction. GLSL ES 3.00 allows dynamic uniform-based loop bounds.
 */
const FS = /* glsl */ `\
#version 300 es
precision highp float;

uniform sampler2D u_pos;
uniform int   u_count;
uniform int   u_width;
uniform float u_repulsion;
layout(location = 0) out vec2 o_force;
${SLOT_TEXEL_GLSL}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int id = texelSlot(c, u_width);
  if (id >= u_count) { discard; }

  vec2 pi = texelFetch(u_pos, c, 0).xy;
  vec2 acc = vec2(0.0);

  for (int j = 0; j < u_count; j++) {
    if (j == id) continue;
    vec2 pj = texelFetch(u_pos, slotTexel(j, u_width), 0).xy;
    vec2 d = pi - pj;
    float d2 = dot(d, d);
    float f = u_repulsion / (d2 + 1e-2);
    acc += f * d;
  }

  o_force = acc;
}
`;

/** Uniforms consumed by the all-pairs repulsion pass. */
export interface RepulsionAllPairsUniforms {
  count: number;
  width: number;
  repulsion: number;
}

/**
 * GPU all-pairs O(n²) repulsion pass. Draws a full-screen triangle; each
 * fragment sums the softened repulsion from every other node and writes it
 * into the force texture.
 *
 * This is the correctness baseline for Task 3. Task 5 replaces it with the
 * Barnes-Hut pyramid for O(n log n) repulsion. Cap N small in tests — this
 * pass is O(n²) per tick.
 *
 * Rendered with additive blending (ONE, ONE) so it accumulates into the same
 * force texture alongside AttractionPass (clear-then-add pattern).
 *
 * Uniforms follow the mutable-object pattern from IntegratePass/AttractionPass:
 * the `uniforms` Record is mutated in-place before each draw.
 */
export class RepulsionAllPairsPass {
  private readonly model: Model;
  private readonly uniforms: PassUniforms;

  constructor(device: Device) {
    this.uniforms = {
      u_count: 0,
      u_width: 1,
      u_repulsion: 0,
    };

    // Additive blend: dst += src, accumulating alongside the other force passes.
    this.model = fullScreenModel(device, FS, this.uniforms, ADDITIVE_BLEND);
  }

  /** Draw one all-pairs repulsion step into an already-open render pass. */
  run(pass: RenderPass, posTex: Texture, u: RepulsionAllPairsUniforms): void {
    this.uniforms["u_count"] = u.count;
    this.uniforms["u_width"] = u.width;
    this.uniforms["u_repulsion"] = u.repulsion;

    this.model.setBindings({ u_pos: posTex });
    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
  }
}
