// TODO(n8 follow-up): extract shared full-screen-triangle pass helper into gpu/passes/_shared.ts
// (full-screen-triangle VS + clip buffer + mutable-uniforms Record + ADDITIVE_BLEND params — 6 passes duplicate this).

import type { Device, Texture, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";

/**
 * Full-screen triangle vertex shader — shared with IntegratePass.
 * Each fragment corresponds to one texel (one node).
 */
const VS = /* glsl */ `\
#version 300 es
in vec2 a_clip;
void main() { gl_Position = vec4(a_clip, 0.0, 1.0); }
`;

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

ivec2 offCoord(int i) {
  return ivec2(i % u_off_width, i / u_off_width);
}
ivec2 nbrCoord(uint p) {
  return ivec2(int(p) % u_nbr_width, int(p) / u_nbr_width);
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int id = c.y * u_width + c.x;
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
    ivec2 jc = ivec2(int(j) % u_width, int(j) / u_width);
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
  private readonly uniforms: Record<string, number>;

  constructor(device: Device) {
    const clipBuf = device.createBuffer({
      data: new Float32Array([-1, -1, 3, -1, -1, 3]),
    });

    this.uniforms = {
      u_count: 0,
      u_width: 1,
      u_off_width: 1,
      u_nbr_width: 1,
      u_attraction: 0,
    };

    this.model = new Model(device, {
      vs: VS,
      fs: FS,
      topology: "triangle-list",
      vertexCount: 3,
      attributes: { a_clip: clipBuf },
      bufferLayout: [{ name: "a_clip", format: "float32x2" }],
      uniforms: this.uniforms,
      parameters: {
        // Additive blend: dst += src.  Accumulates contributions from multiple
        // force passes without overwriting.  Requires EXT_float_blend on WebGL2
        // for float render targets; luma.gl enables it automatically via
        // WebGLDeviceFeatures if the extension is present.
        blend: true,
        blendColorSrcFactor: "one",
        blendColorDstFactor: "one",
        blendAlphaSrcFactor: "one",
        blendAlphaDstFactor: "one",
        blendColorOperation: "add",
        blendAlphaOperation: "add",
      },
    });
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
