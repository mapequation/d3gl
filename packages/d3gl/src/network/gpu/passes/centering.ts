import type { Device, Texture, Framebuffer, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";

// ─────────────────────────────────────────────────────────────────────────────
// CentroidReducePass
// ─────────────────────────────────────────────────────────────────────────────
//
// Scatter-reduces all node positions into a single 1×1 rg32float texel via
// additive blending. Draws exactly `count` POINT primitives; each uses
// gl_VertexID to look up its own position, outputs gl_Position = (0,0,0,1)
// (so every point lands in the same pixel), and writes the position as a
// fragment color. Additive blend accumulates the sum of all positions into
// the single 1×1 target. Padded texels beyond nodeCount are never emitted
// because the draw call issues only `count` vertices.
//
// TODO(N8.5 budget): if 1px-blend centroid reduction is a bottleneck at 1M
// nodes, switch to a log-depth mip halving reduction.

const REDUCE_VS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp sampler2D;
uniform highp sampler2D u_pos;
uniform int u_width;

flat out vec2 v_pos;

void main() {
  int id = gl_VertexID;
  ivec2 c = ivec2(id % u_width, id / u_width);
  v_pos = texelFetch(u_pos, c, 0).xy;
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

// NOTE: output must be vec4 even for rg32float target; some WebGL2 drivers
// require the FS output type to match the attachment's channel count. We write
// (x, y, 0, 0) and only the RG channels are blended into the rg32float target.
// The `flat` qualifier is mandatory for integer types but also avoids any
// interpolation artefacts on point primitives.
const REDUCE_FS = /* glsl */ `\
#version 300 es
precision highp float;

flat in highp vec2 v_pos;
out vec4 o_sum;

void main() {
  o_sum = vec4(v_pos, 0.0, 1.0);
}
`;

/** Uniforms consumed by the centroid reduce pass. */
export interface CentroidReduceUniforms {
  /** Number of real nodes (not padded). */
  count: number;
  /** Atlas width of the positions texture. */
  width: number;
}

/**
 * Scatter-reduces all node positions into a 1×1 rg32float sum texture via
 * additive blending.  The caller must clear the 1×1 target to zero before
 * calling run(), then divide by nodeCount in the CenteringPass to get the
 * centroid.
 *
 * Draw topology is "point-list"; vertexCount = nodeCount so padded texels
 * are never sampled.
 */
export class CentroidReducePass {
  private readonly model: Model;
  private readonly uniforms: Record<string, number>;

  constructor(device: Device) {
    this.uniforms = {
      u_width: 1,
    };

    this.model = new Model(device, {
      vs: REDUCE_VS,
      fs: REDUCE_FS,
      topology: "point-list",
      vertexCount: 1,   // overridden in run() via uniforms + actual count
      uniforms: this.uniforms,
      parameters: {
        // Additive blend: accumulate all position vectors into one texel.
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

  /**
   * Draw `count` points into an already-open render pass backed by the 1×1
   * sum FBO (which the caller must have cleared to zero). After this call the
   * single 1×1 texel holds Σ(pos[i]).
   */
  run(pass: RenderPass, posTex: Texture, u: CentroidReduceUniforms): void {
    this.uniforms["u_width"] = u.width;
    this.model.setBindings({ u_pos: posTex });
    // Mutate vertexCount so Model draws exactly count points.
    this.model.setVertexCount(u.count);
    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CenteringPass
// ─────────────────────────────────────────────────────────────────────────────
//
// Full-screen triangle pass over nodes. For each node reads the 1×1 sum
// texel, divides by nodeCount to get the centroid, and writes
//   o_force = centering * (centroid − pos_i)
// into the force texture with additive blend (accumulates alongside
// repulsion + attraction). Padded texels are discarded.

const CENTER_VS = /* glsl */ `\
#version 300 es
in vec2 a_clip;
void main() { gl_Position = vec4(a_clip, 0.0, 1.0); }
`;

// NOTE: `centroid` is a GLSL ES 3.00 reserved keyword — do not use as a variable
// name. Use `cx` (centroid x/y pair) or another non-keyword identifier.
const CENTER_FS = /* glsl */ `\
#version 300 es
precision highp float;

uniform sampler2D u_pos;
uniform sampler2D u_sum;   // 1×1 rg32float holding Σ pos
uniform int   u_count;
uniform int   u_width;
uniform float u_centering;
layout(location = 0) out vec2 o_force;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int id = c.y * u_width + c.x;
  if (id >= u_count) { discard; }

  vec2 pos_i = texelFetch(u_pos, c, 0).xy;
  vec2 sumPos = texelFetch(u_sum, ivec2(0, 0), 0).xy;
  // cx = centroid position. ('centroid' is a GLSL reserved keyword — avoid it.)
  vec2 cx = sumPos / float(u_count);

  o_force = u_centering * (cx - pos_i);
}
`;

/** Uniforms consumed by the centering force pass. */
export interface CenteringUniforms {
  count: number;
  width: number;
  centering: number;
}

/**
 * Full-screen triangle centering force pass.  Reads the 1×1 sum texture
 * produced by {@link CentroidReducePass}, computes the centroid, and writes
 *   centering * (centroid − pos_i)
 * into the force texture with additive blend.
 *
 * This pass must be run AFTER CentroidReducePass (which populates the 1×1
 * sum texture) and INSIDE the same force-accumulation render pass (additive
 * blend into forceTex).
 *
 * However: the centroid reduce uses a 1×1 target (the sum FBO) while this
 * pass uses the full-size force FBO.  They are different render passes with
 * different framebuffers, so the centroid reduce runs first (separate pass,
 * separate FBO), then the force render pass is (re-)opened and this centering
 * pass draws into it.
 */
export class CenteringPass {
  private readonly model: Model;
  private readonly uniforms: Record<string, number>;

  constructor(device: Device) {
    const clipBuf = device.createBuffer({
      data: new Float32Array([-1, -1, 3, -1, -1, 3]),
    });

    this.uniforms = {
      u_count: 0,
      u_width: 1,
      u_centering: 0,
    };

    this.model = new Model(device, {
      vs: CENTER_VS,
      fs: CENTER_FS,
      topology: "triangle-list",
      vertexCount: 3,
      attributes: { a_clip: clipBuf },
      bufferLayout: [{ name: "a_clip", format: "float32x2" }],
      uniforms: this.uniforms,
      parameters: {
        // Additive blend: accumulate alongside repulsion + attraction.
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

  /** Draw centering forces into an already-open force-accumulation render pass. */
  run(
    pass: RenderPass,
    posTex: Texture,
    sumTex: Texture,
    u: CenteringUniforms,
  ): void {
    this.uniforms["u_count"] = u.count;
    this.uniforms["u_width"] = u.width;
    this.uniforms["u_centering"] = u.centering;
    this.model.setBindings({ u_pos: posTex, u_sum: sumTex });
    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
  }
}

/** Pre-create the 1×1 rg32float sum texture and its dedicated FBO. */
export function makeSumTarget(device: Device): {
  sumTex: Texture;
  sumFbo: Framebuffer;
} {
  const sumTex = device.createTexture({
    width: 1,
    height: 1,
    format: "rg32float",
    mipLevels: 1,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
  const sumFbo = device.createFramebuffer({
    width: 1,
    height: 1,
    colorAttachments: [sumTex],
  });
  return { sumTex, sumFbo };
}
