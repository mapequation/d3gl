import type { Device, Texture, RenderPass } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL } from "../textures.js";
import { ADDITIVE_BLEND, fullScreenModel, type PassUniforms } from "./fullscreen.js";

/**
 * Attraction (spring) gather pass.
 *
 * Each fragment maps to node id = c.y * u_width + c.x.  It reads the node's
 * neighbor range from the CSR offset texture, sums (pos[j] − pos[i]) over all
 * neighbors j, and writes u_attraction * Σ(pos[j]−pos[i]) into o_force.
 *
 * The CSR is symmetric/undirected (buildCSR inserts both directions), so this
 * gather reproduces force.ts's attraction loop exactly: each incident edge
 * contributes once to each endpoint.
 *
 * Safety cap: the inner loop is capped at start + 4096 iterations to guard
 * against degenerate graphs with enormous degree.  Real graphs rarely exceed
 * a few thousand neighbors per node; the cap prevents a GPU hang.
 *
 * Padded texels (id >= u_count) are discarded — with additive blending enabled
 * this is essential: a discard avoids adding garbage to padded force texels.
 */
const FS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp usampler2D;

uniform sampler2D  u_pos;
uniform usampler2D u_offsets;
uniform usampler2D u_neighbors;
uniform int   u_count;
uniform int   u_width;
uniform int   u_off_width;
uniform int   u_nbr_width;
uniform float u_attraction;
layout(location = 0) out vec2 o_force;

${SLOT_TEXEL_GLSL}
ivec2 offCoord(int i) {
  return ivec2(i % u_off_width, i / u_off_width);
}
ivec2 nbrCoord(uint p) {
  return ivec2(int(p) % u_nbr_width, int(p) / u_nbr_width);
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int id = texelSlot(c, u_width);
  if (id >= u_count) { discard; }

  uint start = texelFetch(u_offsets, offCoord(id),     0).r;
  uint end   = texelFetch(u_offsets, offCoord(id + 1), 0).r;
  vec2 pi = texelFetch(u_pos, c, 0).xy;
  vec2 f = vec2(0.0);

  // Safety cap: max 4096 neighbors per node.
  uint cap = start + 4096u;
  uint lim = end < cap ? end : cap;
  for (uint p = start; p < lim; p++) {
    uint j = texelFetch(u_neighbors, nbrCoord(p), 0).r;
    ivec2 jc = slotTexel(int(j), u_width);
    vec2 pj = texelFetch(u_pos, jc, 0).xy;
    f += (pj - pi);
  }

  o_force = u_attraction * f;
}
`;

/** Uniforms consumed by the attraction pass. */
export interface AttractionUniforms {
  count: number;
  width: number;
  offWidth: number;
  nbrWidth: number;
  attraction: number;
}

/**
 * GPU attraction (spring) gather pass. Draws a full-screen triangle; each
 * fragment computes one node's spring-force contribution over its CSR neighbors
 * and writes it into the force texture.
 *
 * Rendered with additive blending (ONE, ONE) so multiple force passes can
 * accumulate into the same force texture (clear-then-add pattern, Tasks 2–4).
 *
 * Uniforms follow the mutable-object pattern from IntegratePass: the
 * `uniforms` Record is mutated in-place before each draw so Model picks
 * up the latest values.
 */
export class AttractionPass {
  private readonly model: Model;
  private readonly uniforms: PassUniforms;

  constructor(device: Device) {
    this.uniforms = {
      u_count: 0,
      u_width: 1,
      u_off_width: 1,
      u_nbr_width: 1,
      u_attraction: 0,
    };

    // Additive blend: dst += src, so the force passes accumulate into one texture.
    this.model = fullScreenModel(device, FS, this.uniforms, ADDITIVE_BLEND);
  }

  /** Draw one attraction gather step into an already-open render pass. */
  run(
    pass: RenderPass,
    posTex: Texture,
    offsetsTex: Texture,
    neighborsTex: Texture,
    u: AttractionUniforms,
  ): void {
    this.uniforms["u_count"] = u.count;
    this.uniforms["u_width"] = u.width;
    this.uniforms["u_off_width"] = u.offWidth;
    this.uniforms["u_nbr_width"] = u.nbrWidth;
    this.uniforms["u_attraction"] = u.attraction;

    this.model.setBindings({
      u_pos: posTex,
      u_offsets: offsetsTex,
      u_neighbors: neighborsTex,
    });

    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
  }
}
