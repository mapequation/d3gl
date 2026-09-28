import type { Device, Framebuffer, SamplerProps, Texture } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL, atlasWidth } from "../textures.js";
import { SEGMENT_OF_GLSL, segmentDefines, type SegmentTable } from "../segment-table.js";
import { beginPass, fullScreenModel, NO_BLEND, type PassUniforms } from "./fullscreen.js";

// ─────────────────────────────────────────────────────────────────────────────
// The nested layout's composition + pack pass (#355, spec §11.1).
// ─────────────────────────────────────────────────────────────────────────────
//
// After the batched solve, every slot holds its node's position in its parent's unit disc. The CPU maps
// each module's children into the module's world disc once the module is placed:
//
//   m_p     = Σ rad² · x / Σ rad²                  over p's children (the segment)
//   extent  = max |x − m_p| + rad                  over p's children
//   scale_p = 0.92 · R_p / extent_p                (extent 0 or NaN → 1, as the CPU's `extent || 1`)
//   C_c     = C_p + (x_c − m_p) · scale_p,  R_c = rad_c · scale_p
//
// and a lone child (a FROZEN segment) sits at its parent's centre with 0.9 of its radius. m_p and extent_p
// come from two range reductions over the segments (the solver's nested reduce map); this pass does the
// rest. Each output texel walks its node's chain of parents up to the root's segment (at most the tree's
// depth D, read through `segNested.y`, the owner slot) and composes back down — one gather pass over the
// output, O(D) fetches per node, instead of D passes over every slot (same arithmetic, in the same
// order as the CPU's top-down placement).
//
// The output is the readback's staging texture (`rgba32float`), in node order:
//   texels [0, P)       P = ⌈leaves / 2⌉: leaves 2t and 2t + 1 as (x0, y0, x1, y1) — the positions array
//   texels [P, P + M)   M = modules (tree ids leafCount … size − 1, the root included): (cx, cy, r, 0)
// The module discs feed the boundary rings (#329) and a warm start's placement (#328).

const NEAREST: SamplerProps = { minFilter: "nearest", magFilter: "nearest" };

function composeFs(depth: number): string {
  return /* glsl */ `\
#version 300 es
${segmentDefines(false)}
#define MAX_DEPTH ${Math.max(1, depth)}
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp isampler2D;
uniform highp sampler2D u_pos;
uniform highp sampler2D u_rad;
uniform highp sampler2D u_segSum;    // (Σ rad² x, Σ rad² y, Σ rad², k) per segment
uniform highp sampler2D u_segExtent; // (max |x − m| + rad, …) per segment
uniform highp sampler2D u_segNested; // (collision cell side, owner slot, 0, 0) per segment
uniform highp usampler2D u_segInfo;
uniform highp isampler2D u_nodeSlot; // slot per tree node, −1 for the root
uniform int u_width;                 // slot atlas width
uniform int u_nodeWidth;             // tree-node atlas width
uniform int u_outWidth;              // staging atlas width
uniform int u_leaves;
uniform int u_pairs;                 // ⌈leaves / 2⌉
uniform int u_modules;
uniform vec2 u_rootCentre;
uniform float u_rootRadius;
uniform float u_fill;                // 0.92
uniform float u_onlyChild;           // 0.9
layout(location = 0) out vec4 o_out;
${SLOT_TEXEL_GLSL}
${SEGMENT_OF_GLSL}

// A tree node's world disc (centre, radius).
vec3 worldDisc(int node) {
  int slot = texelFetch(u_nodeSlot, slotTexel(node, u_nodeWidth), 0).r;
  if (slot < 0) return vec3(u_rootCentre, u_rootRadius);
  int chain[MAX_DEPTH];
  int n = 0;
  int s = slot;
  for (int k = 0; k < MAX_DEPTH; k++) {
    if (s < 0) break;
    chain[k] = s;
    n = k + 1;
    s = int(texelFetch(u_segNested, segmentTexelOf(slotTexel(s, u_width)), 0).y);
  }
  vec2 C = u_rootCentre;
  float R = u_rootRadius;
  for (int k = MAX_DEPTH - 1; k >= 0; k--) {
    if (k >= n) continue;
    int c = chain[k];
    ivec2 t = slotTexel(c, u_width);
    ivec2 st = segmentTexelOf(t);
    uvec4 info = texelFetch(u_segInfo, st, 0);
    if ((((info.w >> 8) & SEGMENT_FROZEN) != 0u)) { R *= u_onlyChild; continue; }
    vec4 sum = texelFetch(u_segSum, st, 0);
    vec2 m = sum.z > 0.0 ? sum.xy / sum.z : vec2(0.0);
    float extent = texelFetch(u_segExtent, st, 0).x;
    float scale = u_fill * R / (extent > 0.0 ? extent : 1.0);
    C = C + (texelFetch(u_pos, t, 0).xy - m) * scale;
    R = texelFetch(u_rad, t, 0).r * scale;
  }
  return vec3(C, R);
}

void main() {
  int t = texelSlot(ivec2(gl_FragCoord.xy), u_outWidth);
  if (t < u_pairs) {
    int a = 2 * t;
    vec2 pa = worldDisc(a).xy;
    vec2 pb = a + 1 < u_leaves ? worldDisc(a + 1).xy : vec2(0.0);
    o_out = vec4(pa, pb);
  } else if (t < u_pairs + u_modules) {
    o_out = vec4(worldDisc(u_leaves + (t - u_pairs)), 0.0);
  } else {
    o_out = vec4(0.0);
  }
}
`;
}

/** What the composition reads. */
export interface ComposeInput {
  pos: Texture;
  radius: Texture;
  slotSeg: Texture;
  width: number;
  /** The segment table: `info`, and `stats` holding the weighted-centroid sums of the current positions. */
  segments: SegmentTable;
  /** Per segment, x = its children's extent about their centroid. */
  segExtent: Texture;
  segNested: Texture;
  /** The root disc. */
  rootX: number;
  rootY: number;
  rootRadius: number;
}

/**
 * The composition + pack pass and its staging texture (created once): world positions of every leaf
 * and world discs of every module, in node order (see the file header).
 */
export class NestedComposePass {
  /** Staging atlas size and framebuffer — what the readback copies. */
  readonly width: number;
  readonly height: number;
  readonly framebuffer: Framebuffer;
  /** Floats of module discs after the leaf pairs: 4 per module. */
  readonly extraFloats: number;
  private readonly device: Device;
  private readonly texture: Texture;
  private readonly nodeSlot: Texture;
  private readonly model: Model;
  private readonly uniforms: PassUniforms;

  /**
   * @param nodeSlot slot of every tree node (−1 for the root), length `treeSize`.
   * @param depth the tree's composition depth (the longest chain of segments).
   */
  constructor(device: Device, nodeSlot: Int32Array, leafCount: number, depth: number, fill: number, onlyChild: number) {
    this.device = device;
    const treeSize = nodeSlot.length;
    const modules = treeSize - leafCount;
    const pairs = Math.ceil(leafCount / 2);
    const texels = Math.max(1, pairs + modules);
    this.width = atlasWidth(texels);
    this.height = Math.ceil(texels / this.width);
    this.extraFloats = 4 * modules;
    this.texture = device.createTexture({ width: this.width, height: this.height, format: "rgba32float", mipLevels: 1, sampler: NEAREST });
    this.framebuffer = device.createFramebuffer({ width: this.width, height: this.height, colorAttachments: [this.texture] });
    const nodeWidth = atlasWidth(treeSize);
    const nodeRows = Math.ceil(treeSize / nodeWidth);
    const slots = new Int32Array(nodeWidth * nodeRows).fill(-1);
    slots.set(nodeSlot);
    this.nodeSlot = device.createTexture({ width: nodeWidth, height: nodeRows, format: "r32sint", data: slots, mipLevels: 1, sampler: NEAREST });
    this.uniforms = {
      u_width: 1,
      u_tableWidth: 1,
      u_nodeWidth: nodeWidth,
      u_outWidth: this.width,
      u_leaves: leafCount,
      u_pairs: pairs,
      u_modules: modules,
      u_rootCentre: new Float32Array(2),
      u_rootRadius: 1,
      u_fill: fill,
      u_onlyChild: onlyChild,
    };
    this.model = fullScreenModel(device, composeFs(depth), this.uniforms, NO_BLEND);
  }

  /** Compose every leaf's and module's world position into the staging texture (every texel written). */
  run(input: ComposeInput): void {
    const u = this.uniforms;
    u["u_width"] = input.width;
    u["u_tableWidth"] = input.segments.width;
    u["u_rootRadius"] = input.rootRadius;
    const centre = u["u_rootCentre"];
    if (centre instanceof Float32Array) {
      centre[0] = input.rootX;
      centre[1] = input.rootY;
    }
    this.model.setBindings({
      u_pos: input.pos,
      u_rad: input.radius,
      u_segSum: input.segments.stats,
      u_segExtent: input.segExtent,
      u_segNested: input.segNested,
      u_segInfo: input.segments.info,
      u_nodeSlot: this.nodeSlot,
      u_slotSeg: input.slotSeg,
    });
    const pass = beginPass(this.device, { framebuffer: this.framebuffer, clear: false });
    this.model.draw(pass);
    pass.end();
  }

  destroy(): void {
    this.model.destroy();
    this.framebuffer.destroy();
    this.texture.destroy();
    this.nodeSlot.destroy();
  }
}
