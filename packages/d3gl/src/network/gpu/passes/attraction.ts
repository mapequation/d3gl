// TODO(n8 follow-up): extract shared full-screen-triangle pass helper into gpu/passes/_shared.ts
// (full-screen-triangle VS + clip buffer + mutable-uniforms Record + ADDITIVE_BLEND params — 6 passes duplicate this).

import type { Buffer, Device, Texture, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { HUB_CHUNK, SPRING_CHUNK } from "../hub-chunks.js";

/**
 * Full-screen triangle vertex shader — shared with IntegratePass.
 * Each fragment corresponds to one texel (one node, or one hub chunk).
 */
const VS = /* glsl */ `\
#version 300 es
in vec2 a_clip;
void main() { gl_Position = vec4(a_clip, 0.0, 1.0); }
`;

/**
 * Which spring variant a program is compiled for — fixed per layout, so no per-fragment branch on it.
 *
 * TODO(#353): one solver across multilevel levels (`setLevel`, spec §6.4) changes the CSR, the hub table
 * and the weights per level, so both flags must then become uniform branches (spec §5.4) or be compiled
 * on for the capacity solver — a hub-free first level would otherwise compile without the hub branch.
 */
export interface SpringVariant {
  /**
   * Some row is longer than {@link SPRING_CHUNK}: compile the hub branch (row skip + partial gather).
   * Off, the shader has no hub code and no hub samplers, so a graph without hubs pays nothing.
   */
  hubs: boolean;
  /** Per-entry spring weights (`LayoutGraph.springWeight`): multiply each term by its weight. */
  weighted: boolean;
}

/** `#version` line plus the variant's defines — the one place a variant reaches GLSL. */
function header(variant: SpringVariant): string {
  return (
    `#version 300 es\n#define SPRING_CHUNK ${SPRING_CHUNK}u\n#define HUB_CHUNK ${HUB_CHUNK}u\n` +
    (variant.hubs ? "#define HUB_CHUNKS\n" : "") +
    (variant.weighted ? "#define WEIGHTED_SPRINGS\n" : "")
  );
}

/**
 * GLSL shared by the row gather and the chunk pass: the uniforms and samplers that address the CSR and
 * the positions, and `springTerm(p, pi)` — CSR entry `p`'s spring term `w · (pos[j] − pos[i])`. Both
 * passes sum the same terms in the same (CSR) order, so a hub's chunked sum and a short row's direct sum
 * are the same computation split at different places.
 */
const CSR_GLSL = /* glsl */ `\
precision highp float;
precision highp int;
precision highp usampler2D;

uniform sampler2D  u_pos;
uniform usampler2D u_neighbors;
#ifdef WEIGHTED_SPRINGS
uniform sampler2D  u_weights; // parallel to u_neighbors, same atlas width
#endif
uniform int u_width;
uniform int u_nbr_width;

ivec2 nbrCoord(uint p) {
  return ivec2(int(p) % u_nbr_width, int(p) / u_nbr_width);
}
vec2 posOf(uint j) {
  return texelFetch(u_pos, ivec2(int(j) % u_width, int(j) / u_width), 0).xy;
}
vec2 springTerm(uint p, vec2 pi) {
  ivec2 nc = nbrCoord(p);
  vec2 d = posOf(texelFetch(u_neighbors, nc, 0).r) - pi;
#ifdef WEIGHTED_SPRINGS
  return texelFetch(u_weights, nc, 0).r * d;
#else
  return d;
#endif
}
`;

/**
 * Attraction (spring) gather pass.
 *
 * Each fragment maps to node id = c.y * u_width + c.x. It reads the node's neighbour range from the
 * CSR offset texture, sums the spring terms `(pos[j] − pos[i])` (times the entry's weight on a
 * weighted layout) over all neighbours j, and writes `u_attraction · Σ` into o_force.
 *
 * The CSR is symmetric/undirected (buildCSR inserts both directions), so this gather reproduces
 * force.ts's attraction loop: each incident edge contributes once to each endpoint.
 *
 * Rows longer than {@link SPRING_CHUNK} entries (hubs, #350) skip the row loop: {@link HubChunkPass}
 * has already summed them chunk by chunk into `u_partials`, and the fragment adds its row's partials,
 * which it finds by binary search on the chunk table's entry start (chunk k of a row starts at the
 * row's offset + k·{@link HUB_CHUNK}, so its `ceil(degree / HUB_CHUNK)` partials are consecutive). No
 * fragment loops over more than C neighbours, and no entry is dropped — the old 4096-iteration cap lost
 * 13,507 half-edges on web-NotreDame's 5 largest hubs and broke action-reaction.
 *
 * Padded texels (id >= u_count) write 0 and return — a no-op under the additive blend. Not `discard`:
 * it does not end the invocation on every driver (ANGLE on Metal kept running), and the rest of this
 * shader reads `offsets[id + 1]`, which is past the offsets atlas on the last padded texel (an undefined
 * fetch) and bounds the row loop. `return` does end it, so no loop here ever sees a padded texel.
 */
const ROW_FS = /* glsl */ `\
${CSR_GLSL}
uniform usampler2D u_offsets;
uniform int   u_count;
uniform int   u_off_width;
uniform float u_attraction;
#ifdef HUB_CHUNKS
uniform usampler2D u_chunks;   // rgba32ui (row, entry start, entry end, 0), ascending entry start
uniform sampler2D  u_partials; // rg32f, one partial sum per chunk
uniform int u_chunk_count;
uniform int u_chunk_width;
ivec2 chunkCoord(int k) {
  return ivec2(k % u_chunk_width, k / u_chunk_width);
}
#endif
layout(location = 0) out vec2 o_force;

ivec2 offCoord(int i) {
  return ivec2(i % u_off_width, i / u_off_width);
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int id = c.y * u_width + c.x;
  if (id >= u_count) { o_force = vec2(0.0); return; }

  uint start = texelFetch(u_offsets, offCoord(id),     0).r;
  uint end   = texelFetch(u_offsets, offCoord(id + 1), 0).r;
  vec2 f = vec2(0.0);

#ifdef HUB_CHUNKS
  // A sum, not "end - start > C", so a bound can never wrap on uints. Past the last node the offsets
  // texture holds padding (0): when padded texels only discarded, "end - start" wrapped to ~2^32 there
  // and ANGLE on Metal, which kept executing the discarded texel, ran a 16M-iteration partial loop (280 ms
  // a draw instead of 0.7 ms). Padded texels now return above; the sum keeps the bound safe regardless.
  if (end > start + SPRING_CHUNK) {
    // Hub row: lower bound of its first chunk by entry start, then its consecutive partials.
    int lo = 0;
    int hi = u_chunk_count;
    while (lo < hi) {
      int mid = (lo + hi) >> 1;
      if (texelFetch(u_chunks, chunkCoord(mid), 0).g < start) { lo = mid + 1; } else { hi = mid; }
    }
    int n = int((end - start + HUB_CHUNK - 1u) / HUB_CHUNK);
    for (int k = 0; k < n; k++) {
      f += texelFetch(u_partials, chunkCoord(lo + k), 0).xy;
    }
    o_force = u_attraction * f;
    return;
  }
#endif

  vec2 pi = texelFetch(u_pos, c, 0).xy;
  for (uint p = start; p < end; p++) {
    f += springTerm(p, pi);
  }
  o_force = u_attraction * f;
}
`;

/**
 * Hub chunk pass (#350): one fragment per chunk (≤ {@link HUB_CHUNK} entries) of a row longer than
 * {@link SPRING_CHUNK}, summing that chunk's spring terms into its `hubPartials` texel with no blend.
 * Its own render pass, encoded before the force pass (the row gather reads its output). Every texel is
 * written — padding gets 0 — so the target needs no clear.
 */
const CHUNK_FS = /* glsl */ `\
${CSR_GLSL}
uniform usampler2D u_chunks;
uniform int u_chunk_count;
uniform int u_chunk_width;
layout(location = 0) out vec2 o_partial;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int k = c.y * u_chunk_width + c.x;
  if (k >= u_chunk_count) { o_partial = vec2(0.0); return; }
  uvec4 chunk = texelFetch(u_chunks, c, 0);
  vec2 pi = posOf(chunk.r);
  vec2 f = vec2(0.0);
  for (uint p = chunk.g; p < chunk.b; p++) {
    f += springTerm(p, pi);
  }
  o_partial = f;
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

/** The CSR textures both spring passes read. `weights` is bound only on a weighted variant. */
export interface CsrTextures {
  offsets: Texture;
  neighbors: Texture;
  weights: Texture | null;
}

/** The hub chunk table and its partial sums, bound only on a hub variant. */
export interface HubChunkTextures {
  chunks: Texture;
  partials: Texture;
  /** Number of chunks K. */
  count: number;
  /** Atlas width of both chunk textures. */
  width: number;
}

/**
 * A full-screen triangle Model and its clip-space vertex buffer; `blend` selects the force passes'
 * additive (ONE, ONE) blend. The caller destroys both: luma's `Model.destroy()` leaves user-supplied
 * attribute buffers alone.
 */
function fullScreenModel(
  device: Device,
  fs: string,
  uniforms: Record<string, number>,
  blend: boolean,
): { model: Model; clip: Buffer } {
  const clip = device.createBuffer({
    data: new Float32Array([-1, -1, 3, -1, -1, 3]),
  });
  const model = new Model(device, {
    vs: VS,
    fs,
    topology: "triangle-list",
    vertexCount: 3,
    attributes: { a_clip: clip },
    bufferLayout: [{ name: "a_clip", format: "float32x2" }],
    uniforms,
    parameters: blend
      ? {
        // Additive blend: dst += src. Accumulates contributions from multiple force passes without
        // overwriting. Requires EXT_float_blend on WebGL2 for float render targets; luma.gl enables it
        // automatically via WebGLDeviceFeatures if the extension is present.
        blend: true,
        blendColorSrcFactor: "one",
        blendColorDstFactor: "one",
        blendAlphaSrcFactor: "one",
        blendAlphaDstFactor: "one",
        blendColorOperation: "add",
        blendAlphaOperation: "add",
      }
      : {},
  });
  return { model, clip };
}

/**
 * GPU attraction (spring) gather pass. Draws a full-screen triangle; each fragment computes one node's
 * spring-force contribution over its CSR neighbours (or its hub partials) and writes it into the force
 * texture.
 *
 * Rendered with additive blending (ONE, ONE) so multiple force passes can accumulate into the same
 * force texture (clear-then-add pattern).
 *
 * Uniforms follow the mutable-object pattern from IntegratePass: the `uniforms` Record is mutated
 * in-place before each draw so Model picks up the latest values.
 */
export class AttractionPass {
  private readonly model: Model;
  private readonly clip: Buffer;
  private readonly uniforms: Record<string, number>;
  private readonly variant: SpringVariant;

  constructor(device: Device, variant: SpringVariant) {
    this.variant = variant;
    this.uniforms = {
      u_count: 0,
      u_width: 1,
      u_off_width: 1,
      u_nbr_width: 1,
      u_attraction: 0,
      ...(variant.hubs ? { u_chunk_count: 0, u_chunk_width: 1 } : {}),
    };
    const { model, clip } = fullScreenModel(device, header(variant) + ROW_FS, this.uniforms, true);
    this.model = model;
    this.clip = clip;
  }

  /**
   * Draw one attraction gather step into an already-open render pass. `hubs` must be given exactly when
   * the pass was compiled with `variant.hubs`, after {@link HubChunkPass.run} wrote its partials.
   */
  run(
    pass: RenderPass,
    posTex: Texture,
    csr: CsrTextures,
    hubs: HubChunkTextures | null,
    u: AttractionUniforms,
  ): void {
    this.uniforms["u_count"] = u.count;
    this.uniforms["u_width"] = u.width;
    this.uniforms["u_off_width"] = u.offWidth;
    this.uniforms["u_nbr_width"] = u.nbrWidth;
    this.uniforms["u_attraction"] = u.attraction;

    const bindings: Record<string, Texture> = {
      u_pos: posTex,
      u_offsets: csr.offsets,
      u_neighbors: csr.neighbors,
    };
    if (this.variant.weighted && csr.weights) bindings["u_weights"] = csr.weights;
    if (this.variant.hubs && hubs) {
      this.uniforms["u_chunk_count"] = hubs.count;
      this.uniforms["u_chunk_width"] = hubs.width;
      bindings["u_chunks"] = hubs.chunks;
      bindings["u_partials"] = hubs.partials;
    }
    this.model.setBindings(bindings);

    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
    this.clip.destroy();
  }
}

/** Uniforms consumed by the hub chunk pass. */
export interface HubChunkUniforms {
  /** Position atlas width. */
  width: number;
  /** Neighbour (and weight) atlas width. */
  nbrWidth: number;
}

/**
 * GPU hub chunk pass (#350): sums each chunk of a hub row into one `hubPartials` texel. Drawn into its
 * own render pass on the partials framebuffer (no blend, every texel written), which must complete
 * before the force pass's {@link AttractionPass} gathers the partials.
 */
export class HubChunkPass {
  private readonly model: Model;
  private readonly clip: Buffer;
  private readonly uniforms: Record<string, number>;
  private readonly weighted: boolean;

  constructor(device: Device, variant: Pick<SpringVariant, "weighted">) {
    this.weighted = variant.weighted;
    this.uniforms = { u_width: 1, u_nbr_width: 1, u_chunk_count: 0, u_chunk_width: 1 };
    const { model, clip } = fullScreenModel(
      device,
      header({ hubs: true, weighted: variant.weighted }) + CHUNK_FS,
      this.uniforms,
      false,
    );
    this.model = model;
    this.clip = clip;
  }

  /** Draw the chunk sums into an already-open render pass on the partials framebuffer. */
  run(pass: RenderPass, posTex: Texture, csr: CsrTextures, hubs: HubChunkTextures, u: HubChunkUniforms): void {
    this.uniforms["u_width"] = u.width;
    this.uniforms["u_nbr_width"] = u.nbrWidth;
    this.uniforms["u_chunk_count"] = hubs.count;
    this.uniforms["u_chunk_width"] = hubs.width;
    const bindings: Record<string, Texture> = {
      u_pos: posTex,
      u_neighbors: csr.neighbors,
      u_chunks: hubs.chunks,
    };
    if (this.weighted && csr.weights) bindings["u_weights"] = csr.weights;
    this.model.setBindings(bindings);
    this.model.draw(pass);
  }

  destroy(): void {
    this.model.destroy();
    this.clip.destroy();
  }
}
