import type { Device, Framebuffer, SamplerProps, Texture } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { REDUCE_MAX_LEVELS, reduceLayout, type ReduceLayout } from "../segments.js";
import { SLOT_TEXEL_GLSL } from "../textures.js";
import { beginPass, fullScreenProgram, layoutModel, NO_BLEND, type PassUniforms } from "./fullscreen.js";
import type { LayoutProgram } from "../programs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Contention-free segmented reductions (spec §6.1).
// ─────────────────────────────────────────────────────────────────────────────
//
// Replaces the 1-px point scatters that summed every node into one texel with ADD/MAX blending
// (17-19 ms each at 325k: the blend serialises on that texel). Two parts, both gather-only — no
// blending, so no float-blend contention and a fixed, deterministic add order:
//
// 1. Tree build. A 16-ary tree over slot order: level 1 has ⌈N/16⌉ texels and texel j covers slots
//    16j…16j+15; level ℓ texel j covers [16^ℓ·j, 16^ℓ·(j+1)). One full-screen pass per level; the
//    fragment for texel j does 16 texelFetches from level ℓ−1 and adds them PAIRWISE (a 4-deep add
//    tree, not 15 sequential adds). Two chains are written in the same passes by MRT:
//      sum  (Σx, Σy, Σ|v|, count), identity 0
//      box  (maxX, maxY, −minX, −minY), identity −1e30
//    Level 1 applies the map: slot s → (x, y, |v|, 1) and (x, y, −x, −y); slots ≥ count → identity.
// 2. Range query. One fragment per range covers [start, start + count) with aligned blocks — the
//    canonical cover of `segments.ts` — at most 15 + 15 fetches per level. It writes the table's
//    `stats` and `box` by MRT. Level-0 terms apply the map directly.
//
// Levels are 1D arrays packed into rows: odd levels in texture A, even levels in texture B (per
// chain), so a level pass never samples the texture it renders into. A level pass writes only its
// own rows (viewport, no clear) — the other levels in that texture stay untouched.

/**
 * Shared GLSL: the identities and the pairwise 16-way combine. The box identity sits below any
 * plausible coordinate, so max() picks real data.
 */
const COMBINE_GLSL = /* glsl */ `\
const vec4 BOX_IDENTITY = vec4(-1e30);

// Pairwise sum of 16 terms: a fixed 4-deep add tree (add depth 4, not 15).
vec4 sum16(vec4 v[16]) {
  vec4 a0 = v[0] + v[1];   vec4 a1 = v[2] + v[3];   vec4 a2 = v[4] + v[5];   vec4 a3 = v[6] + v[7];
  vec4 a4 = v[8] + v[9];   vec4 a5 = v[10] + v[11]; vec4 a6 = v[12] + v[13]; vec4 a7 = v[14] + v[15];
  vec4 b0 = a0 + a1; vec4 b1 = a2 + a3; vec4 b2 = a4 + a5; vec4 b3 = a6 + a7;
  return (b0 + b1) + (b2 + b3);
}

// Componentwise max of 16 terms (exact, so the order is immaterial).
vec4 max16(vec4 v[16]) {
  vec4 a0 = max(v[0], v[1]);   vec4 a1 = max(v[2], v[3]);   vec4 a2 = max(v[4], v[5]);   vec4 a3 = max(v[6], v[7]);
  vec4 a4 = max(v[8], v[9]);   vec4 a5 = max(v[10], v[11]); vec4 a6 = max(v[12], v[13]); vec4 a7 = max(v[14], v[15]);
  return max(max(max(a0, a1), max(a2, a3)), max(max(a4, a5), max(a6, a7)));
}
`;

/**
 * The level-0 map of a reduction: GLSL that declares any extra uniforms it reads and defines
 * `void mapSlot(int s, out vec4 sum, out vec4 box)` — slot `s`'s term of the sum chain and of the max
 * ("box") chain. It is spliced after `u_pos`, `u_vel`, `u_count`, `u_posWidth`, `slotTexel` and the
 * identities `BOX_IDENTITY` (sum identity 0), and must map slots at or beyond `u_count` (padding) to the
 * identities. Its extra textures are bound through {@link SegmentedReduce.run}'s `bindings`, its extra
 * uniforms through `uniforms` (declare their initial values here).
 */
export interface ReduceMap {
  readonly glsl: string;
  readonly uniforms?: PassUniforms;
}

/**
 * The flat layout's map: slot s → sum term (x, y, |v|, 1) and box term (x, y, −x, −y) — the segment
 * table's stats (the centroid, the mean step) and box.
 */
export const FLAT_REDUCE_MAP: ReduceMap = {
  glsl: /* glsl */ `\
void mapSlot(int s, out vec4 sum, out vec4 box) {
  if (s >= u_count) { sum = vec4(0.0); box = BOX_IDENTITY; return; }
  ivec2 t = slotTexel(s, u_posWidth);
  vec2 p = texelFetch(u_pos, t, 0).xy;
  vec2 v = texelFetch(u_vel, t, 0).xy;
  sum = vec4(p, length(v), 1.0);
  box = vec4(p, -p);
}
`,
};

/**
 * The map of a solver that runs a multilevel seed (#353): the flat map, except that a mass-weighted seed
 * level (`u_massive`) maps slot s to (m·x, m·y, |v|, m) with its mass m from `u_mass`, so the sum chain's
 * `Σ(m·p) / Σm` is the level's mass-weighted centroid, as on the CPU. The graph's own level skips the fetch
 * (m = 1, and 1·x = x exactly), so its sums are the flat map's. On a seed level the `w` channel is therefore
 * `Σm`, not the slot count: the mean step `Σ|v| / count` of a seed level needs the level's slot count (see
 * `SegmentTable.stats`). Bind `u_mass` on every run (a stand-in where `u_massive` is 0: never sampled).
 */
export const MULTILEVEL_REDUCE_MAP: ReduceMap = {
  glsl: /* glsl */ `\
uniform int u_massive;
uniform highp sampler2D u_mass;
void mapSlot(int s, out vec4 sum, out vec4 box) {
  if (s >= u_count) { sum = vec4(0.0); box = BOX_IDENTITY; return; }
  ivec2 t = slotTexel(s, u_posWidth);
  vec2 p = texelFetch(u_pos, t, 0).xy;
  vec2 v = texelFetch(u_vel, t, 0).xy;
  float m = u_massive != 0 ? texelFetch(u_mass, t, 0).r : 1.0;
  sum = vec4(m * p, length(v), m);
  box = vec4(p, -p);
}
`,
  uniforms: { u_massive: 0 },
};

/** Tree level 1: map 16 slots, combine pairwise. */
function level1Fs(map: ReduceMap): string {
  return /* glsl */ `\
#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform highp sampler2D u_pos;
uniform highp sampler2D u_vel;
uniform int u_count;     // real slots: [0, u_count)
uniform int u_posWidth;  // slot atlas width
uniform int u_width;     // tree row width
uniform int u_rowOffset; // this level's first row in its texture
uniform int u_size;      // texels in this level
layout(location = 0) out vec4 o_sum;
layout(location = 1) out vec4 o_box;
${SLOT_TEXEL_GLSL}
${COMBINE_GLSL}
${map.glsl}
void main() {
  int j = texelSlot(ivec2(gl_FragCoord.xy) - ivec2(0, u_rowOffset), u_width);
  if (j >= u_size) { o_sum = vec4(0.0); o_box = BOX_IDENTITY; return; }
  vec4 s[16];
  vec4 b[16];
  for (int k = 0; k < 16; k++) mapSlot(j * 16 + k, s[k], b[k]);
  o_sum = sum16(s);
  o_box = max16(b);
}
`;
}

/** Tree level ℓ ≥ 2: combine 16 texels of level ℓ−1 pairwise. */
const LEVEL_FS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_srcSum;
uniform highp sampler2D u_srcBox;
uniform int u_width;        // tree row width (both textures)
uniform int u_rowOffset;    // this level's first row
uniform int u_size;         // texels in this level
uniform int u_srcRowOffset; // level ℓ−1's first row in its texture
uniform int u_srcSize;      // texels in level ℓ−1
layout(location = 0) out vec4 o_sum;
layout(location = 1) out vec4 o_box;
${SLOT_TEXEL_GLSL}
${COMBINE_GLSL}
void main() {
  int j = texelSlot(ivec2(gl_FragCoord.xy) - ivec2(0, u_rowOffset), u_width);
  if (j >= u_size) { o_sum = vec4(0.0); o_box = BOX_IDENTITY; return; }
  vec4 s[16];
  vec4 b[16];
  for (int k = 0; k < 16; k++) {
    int i = j * 16 + k;
    if (i < u_srcSize) {
      ivec2 t = slotTexel(i, u_width) + ivec2(0, u_srcRowOffset);
      s[k] = texelFetch(u_srcSum, t, 0);
      b[k] = texelFetch(u_srcBox, t, 0);
    } else {
      s[k] = vec4(0.0);
      b[k] = BOX_IDENTITY;
    }
  }
  o_sum = sum16(s);
  o_box = max16(b);
}
`;

/** Range query: one fragment per range, canonical cover, MRT into the range target. */
function queryFs(map: ReduceMap): string {
  const rowUniforms: string[] = [];
  const rowCases: string[] = [];
  for (let l = 1; l <= REDUCE_MAX_LEVELS; l++) {
    rowUniforms.push(`uniform int u_row${l};`);
    rowCases.push(`  if (lvl == ${l}) return u_row${l};`);
  }
  return /* glsl */ `\
#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform highp sampler2D u_pos;
uniform highp sampler2D u_vel;
uniform highp sampler2D u_sumA;   // odd tree levels
uniform highp sampler2D u_boxA;
uniform highp sampler2D u_sumB;   // even tree levels
uniform highp sampler2D u_boxB;
uniform highp usampler2D u_info;  // (start, count, …) per range
uniform int u_count;              // real slots
uniform int u_posWidth;           // slot atlas width
uniform int u_width;              // tree row width
uniform int u_tableWidth;         // segment-table atlas width
uniform int u_ranges;             // number of ranges (S)
${rowUniforms.join("\n")}
layout(location = 0) out vec4 o_sum;
layout(location = 1) out vec4 o_box;
${SLOT_TEXEL_GLSL}
${COMBINE_GLSL}
${map.glsl}
const int MAX_LEVELS = ${REDUCE_MAX_LEVELS};

// First row of tree level lvl (1…MAX_LEVELS) inside its texture.
int levelRow(int lvl) {
${rowCases.join("\n")}
  return 0;
}

// One cover term: a slot (level 0, mapped) or a tree texel.
void term(int lvl, int i, out vec4 sum, out vec4 box) {
  if (lvl == 0) { mapSlot(i, sum, box); return; }
  ivec2 t = slotTexel(i, u_width) + ivec2(0, levelRow(lvl));
  if ((lvl & 1) == 1) { sum = texelFetch(u_sumA, t, 0); box = texelFetch(u_boxA, t, 0); }
  else                { sum = texelFetch(u_sumB, t, 0); box = texelFetch(u_boxB, t, 0); }
}

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec4 accSum = vec4(0.0);
  vec4 accBox = BOX_IDENTITY;
  if (texelSlot(fc, u_tableWidth) < u_ranges) {
    uvec4 info = texelFetch(u_info, fc, 0);
    int a = int(info.x);
    int b = a + int(info.y);
    vec4 s;
    vec4 x;
    // The canonical cover (segments.ts canonicalCover), in its add order.
    for (int lvl = 0; lvl <= MAX_LEVELS && a < b; lvl++) {
      for (int k = 0; k < 15 && a < b && (a & 15) != 0; k++) {   // unaligned head, ascending
        term(lvl, a, s, x); accSum += s; accBox = max(accBox, x); a++;
      }
      for (int k = 0; k < 15 && a < b && (b & 15) != 0; k++) {   // unaligned tail, descending
        b--; term(lvl, b, s, x); accSum += s; accBox = max(accBox, x);
      }
      a >>= 4;
      b >>= 4;
    }
  }
  o_sum = accSum;
  o_box = accBox;
}
`;
}

/** Slot inputs of a reduction: the per-slot position and velocity textures. */
export interface ReduceInput {
  /** Positions (`rg32float`, slot atlas). */
  pos: Texture;
  /** Velocities — the clamped step of the last tick (`rg32float`, slot atlas); only for a map that reads them. */
  vel?: Texture;
  /** Slot atlas width of `pos` and `vel`. */
  posWidth: number;
  /**
   * Real slots: `[0, count)`; the rest are padding. At most the reduction's capacity. Below it (a
   * multilevel seed level, #353) only the tree texels a range inside `[0, count)` can read are rebuilt, so
   * the reduction costs O(count), not O(capacity).
   */
  count: number;
}

/**
 * Where a range query writes: one fragment per range of an `rgba32float` MRT target `[sum, box]` of
 * atlas width `width`, reading each range's `(start, count, …)` from `info` (same atlas). The
 * {@link SegmentTable} is one (its `stats` and `box`, one range per segment).
 */
export interface RangeTarget {
  readonly target: Framebuffer;
  readonly width: number;
  /** Number of ranges. */
  readonly size: number;
  /** `rgba32uint`, `(start, count, …)` per range. */
  readonly info: Texture;
}

const NEAREST: SamplerProps = { minFilter: "nearest", magFilter: "nearest" };
/** The flat map reads nothing beyond the slot inputs: shared empty records, so a tick allocates none. */
const NO_BINDINGS: Readonly<Record<string, Texture>> = Object.freeze({});
const NO_UNIFORMS: Readonly<PassUniforms> = Object.freeze({});

/** The reduction's three programs for `map`: its level-1 gather, the coarser levels' gather and the range query (#385). */
export function segmentedReducePrograms(map: ReduceMap): { level1: LayoutProgram; level: LayoutProgram; query: LayoutProgram } {
  return { level1: fullScreenProgram(level1Fs(map)), level: fullScreenProgram(LEVEL_FS), query: fullScreenProgram(queryFs(map)) };
}

/**
 * The segmented reduction: a 16-ary gather tree over slot order plus a range query per segment
 * (see the file header). Every texture, framebuffer and model is created here for a fixed slot
 * `capacity`; {@link run} allocates nothing.
 *
 * Memory: 2 chains × (texture A + texture B) ≈ 2 × N/15 texels × 16 B — 0.71 MB at 325k slots,
 * 2.1 MB at 1M.
 */
export class SegmentedReduce {
  private readonly device: Device;
  /** The packed tree layout (levels 1…L). */
  readonly layout: ReduceLayout;
  /** Tree textures [A, B] per chain; odd levels in A, even levels in B. */
  private readonly sum: readonly [Texture, Texture];
  private readonly box: readonly [Texture, Texture];
  /** MRT framebuffers `[sum, box]` over A and over B. */
  private readonly fbo: readonly [Framebuffer, Framebuffer];
  private readonly level1Model: Model;
  private readonly levelModel: Model;
  private readonly queryModel: Model;
  private readonly level1Uniforms: PassUniforms;
  private readonly levelUniforms: PassUniforms;
  private readonly queryUniforms: PassUniforms;

  /**
   * @param capacity slots the tree covers.
   * @param map the level-0 map ({@link FLAT_REDUCE_MAP}: the flat layout's stats and box).
   */
  constructor(device: Device, capacity: number, map: ReduceMap = FLAT_REDUCE_MAP) {
    this.device = device;
    const layout = reduceLayout(capacity);
    this.layout = layout;
    const make = (height: number): Texture =>
      device.createTexture({ width: layout.width, height, format: "rgba32float", mipLevels: 1, sampler: NEAREST });
    this.sum = [make(layout.heightA), make(layout.heightB)];
    this.box = [make(layout.heightA), make(layout.heightB)];
    this.fbo = [
      device.createFramebuffer({ width: layout.width, height: layout.heightA, colorAttachments: [this.sum[0], this.box[0]] }),
      device.createFramebuffer({ width: layout.width, height: layout.heightB, colorAttachments: [this.sum[1], this.box[1]] }),
    ];

    this.level1Uniforms = { ...map.uniforms, u_count: 0, u_posWidth: 1, u_width: layout.width, u_rowOffset: 0, u_size: 0 };
    this.levelUniforms = { u_width: layout.width, u_rowOffset: 0, u_size: 0, u_srcRowOffset: 0, u_srcSize: 0 };
    this.queryUniforms = { ...map.uniforms, u_count: 0, u_posWidth: 1, u_width: layout.width, u_tableWidth: 1, u_ranges: 0 };
    for (let l = 1; l <= REDUCE_MAX_LEVELS; l++) {
      this.queryUniforms[`u_row${l}`] = layout.levels[l - 1]?.rowOffset ?? 0;
    }
    // No blend anywhere: every output texel is written exactly once, by a gather.
    const programs = segmentedReducePrograms(map);
    this.level1Model = layoutModel(device, programs.level1, this.level1Uniforms, NO_BLEND);
    this.levelModel = layoutModel(device, programs.level, this.levelUniforms, NO_BLEND);
    this.queryModel = layoutModel(device, programs.query, this.queryUniforms, NO_BLEND);
  }

  /**
   * Rebuild the tree over `input` and query every range of `table` into its target — the segment table's
   * `stats` and `box` for a {@link SegmentTable}. O(N + N/15) texel reads in L + 1 small passes (L = 4 at
   * 325k and at 1M), plus ≤ 30 reads per tree level per range for the query. Nothing is submitted (the
   * caller's work item submits). `bindings` / `uniforms` feed the map's own textures and uniforms (see
   * {@link ReduceMap}); they are set on the level-1 and query passes, the two that apply the map.
   */
  run(input: ReduceInput, table: RangeTarget, bindings: Readonly<Record<string, Texture>> = NO_BINDINGS, uniforms: Readonly<PassUniforms> = NO_UNIFORMS): void {
    const { layout, device } = this;
    const partial = input.count < layout.capacity;
    let reach = input.count; // tree texels of the current level a range inside [0, count) can read
    layout.levels.forEach((level, k) => {
      reach = Math.floor(reach / 16);
      // Below capacity (a seed level, #353), stop where no range can read and rebuild only the rows it can:
      // level ℓ texel j < ⌊count / 16^ℓ⌋ reads only level ℓ−1 texels below ⌊count / 16^(ℓ−1)⌋.
      if (partial && reach === 0) return;
      const rows = partial ? Math.min(level.rows, Math.ceil(reach / layout.width)) : level.rows;
      const pass = beginPass(device, {
        framebuffer: this.fbo[level.texture],
        clear: false, // other levels share this texture: write only this level's rows
        viewport: [0, level.rowOffset, layout.width, rows],
      });
      if (k === 0) {
        const u = this.level1Uniforms;
        Object.assign(u, uniforms);
        u["u_count"] = input.count;
        u["u_posWidth"] = input.posWidth;
        u["u_rowOffset"] = level.rowOffset;
        u["u_size"] = level.size;
        this.level1Model.setBindings(input.vel ? { ...bindings, u_pos: input.pos, u_vel: input.vel } : { ...bindings, u_pos: input.pos });
        this.level1Model.draw(pass);
      } else {
        const src = layout.levels[k - 1];
        if (!src) throw new Error("SegmentedReduce: missing source level");
        const u = this.levelUniforms;
        u["u_rowOffset"] = level.rowOffset;
        u["u_size"] = level.size;
        u["u_srcRowOffset"] = src.rowOffset;
        u["u_srcSize"] = src.size;
        this.levelModel.setBindings({ u_srcSum: this.sum[src.texture], u_srcBox: this.box[src.texture] });
        this.levelModel.draw(pass);
      }
      pass.end();
    });

    // Range query: every table texel is written (padding gets the identities), so no clear.
    const pass = beginPass(device, { framebuffer: table.target, clear: false });
    const u = this.queryUniforms;
    Object.assign(u, uniforms);
    u["u_count"] = input.count;
    u["u_posWidth"] = input.posWidth;
    u["u_tableWidth"] = table.width;
    u["u_ranges"] = table.size;
    this.queryModel.setBindings({
      ...bindings,
      ...(input.vel ? { u_vel: input.vel } : {}),
      u_pos: input.pos,
      u_sumA: this.sum[0],
      u_boxA: this.box[0],
      u_sumB: this.sum[1],
      u_boxB: this.box[1],
      u_info: table.info,
    });
    this.queryModel.draw(pass);
    pass.end();
  }

  destroy(): void {
    this.level1Model.destroy();
    this.levelModel.destroy();
    this.queryModel.destroy();
    this.fbo[0].destroy();
    this.fbo[1].destroy();
    this.sum[0].destroy();
    this.sum[1].destroy();
    this.box[0].destroy();
    this.box[1].destroy();
  }
}
