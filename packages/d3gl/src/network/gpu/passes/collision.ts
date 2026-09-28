import type { Device, Framebuffer, RenderPass, RenderPipelineParameters, SamplerProps, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL, atlasWidth } from "../textures.js";
import { SEGMENT_OF_GLSL, segmentDefines, type SegmentTable } from "../segment-table.js";
import { bandRows, bandSlots } from "../segments.js";
import {
  COLLISION_GLSL,
  COLLISION_ITEM_SHIFT,
  COLLISION_LIST_MAX,
  COLLISION_ITEMIZED,
  COLLISION_PART_PAIRS,
  collisionCuts,
  workCut,
  COLLISION_PART_VISITS,
  type CollisionPlan,
} from "../collision-plan.js";
import { ADDITIVE_BLEND, beginPass, fullScreenModel, NO_BLEND, type PassUniforms } from "./fullscreen.js";

// ─────────────────────────────────────────────────────────────────────────────
// The nested layout's disc collision on the GPU (#355, #380, spec §11.1): a per-segment radius-class grid
// that finds every touching pair, plus the exact loop for small segments.
// ─────────────────────────────────────────────────────────────────────────────
//
// The CPU (`collide()` in nested-layout.ts) pushes each overlapping sibling pair apart, one pair after
// another. Here every slot gathers the pushes of all its overlapping siblings from the same positions
// (Jacobi) and moves by RELAX (0.5) of their sum — a pair's two pushes are equal and opposite in mass
// (m = radius²), so each segment's mass-weighted centre stays put.
//
// Which pairs a slot tests (the plan, `collision-plan.ts`, says which class each slot is in, which slots
// a segment lists, which slots take the exact loop, and how each slot's search is cut into work items):
//
// - a segment of at most EXACT_MAX (32) children, and an exact slot, tests all its siblings;
// - otherwise a slot tests its segment's list, then visits, for every binned class of its segment, the
//   class cells its disc padded by that class's largest radius overlaps — where every touching partner of
//   that class is.
//
// A collision step is two parts:
//
// 1. **Prepare** (work item P): the cell pass bins every slot's position once — its finest sub-cell F,
//    its class cell's bucket and its sub-cell's bucket, into `key`, so no two shaders ever round a cell
//    differently. Then K rounds of MIN-blend point scatters over the binned slots (a static list)
//    enumerate each class-cell bucket's occupants without atomics: round r writes into each bucket the
//    smallest slot id above the one round r − 1 wrote there, so after K rounds a bucket lists its K
//    smallest occupants in order, next to an ADD-blend count. The occupants of the buckets with more than
//    K are then enumerated again by sub-cell into the sub-cell table (the same scatters; every other slot
//    is culled in the vertex shader).
// 2. **Gather**: the work items — each a slice of one grid slot's cells or of a large exact slot's segment,
//    summing the pushes it finds — then every slot's resolve into its new position: a slot sums its items,
//    or runs its exact loop when that is a single item. A search visits a dense cell's sub-cells in its place, and keeps a touching occupant only
//    when its class and cell are the visited ones (buckets are shared by hash collisions; a touching
//    occupant from another cell is counted at its own). A search that meets a sub-cell with more than K
//    occupants redoes its slice as an exact loop over the segment restricted to the partners whose cells
//    are in that slice — complete either way, and each side of a pair finds it once, so the pushes stay
//    symmetric.
//
// Round storage, per table: K / 4 rgba32float textures, round r in texture r % (K / 4), channel r / (K / 4).
// A round writes EMPTY to its other channels, which MIN leaves unchanged, and reads round r − 1 from
// another texture — never the one it renders into. Cleared to EMPTY and the counts to 0 each step.
//
// Every pass is sliceable into bands (#382), each band its own render pass, and the step does not
// depend on the bands: the cell pass and the resolve write their own rows of the slot atlas; a scatter's
// bands draw its own range of the binned slots, in order, and ADD of integer counts and MIN are exact in
// any order; the item pass's bands compute their own items. The items are cut at equal shares of their
// estimated work and the resolve's rows at equal shares of its own (the plan's), so a band costs what its
// share of the estimate says, whichever slots it holds (#380).

/**
 * Rounds of occupant enumeration K of the class-cell table (a multiple of 4, at least 8): a class cell with
 * more occupants is refined into sub-cells.
 */
export const COLLISION_ROUNDS = 8;
/**
 * Rounds of the sub-cell table (a multiple of 4, at least 8): a sub-cell with more occupants sends the work
 * item that visits it to the exact loop. The fullest sub-cell of the real maps held 8 (see
 * `COLLISION_SUB_BUCKETS_PER_SLOT`); 12 leaves room. The gather then samples 15 textures, within WebGL2's
 * guaranteed 16.
 */
export const COLLISION_SUB_ROUNDS = 12;
/** Under-relaxation of the Jacobi collision step (spec §11.1). */
export const COLLISION_RELAX = 0.5;
/**
 * Jacobi collision steps per compact tick. The CPU resolves its pairs one after another (Gauss-Seidel),
 * so one sweep separates a dense pack further than one Jacobi step at 0.5. Measured on the float64
 * reference (worst sibling distance over the radius sum after a full layout; the CPU layout's
 * invariant asks ≥ 0.98): a 40 × 12 × 60 map ends at 0.92 with one step, 1.08 with two, 1.12 with
 * three (the CPU: 1.12); 4 × 50 × 3 at 0.98 / 1.11 / 1.14 (CPU 1.14). Two keep the invariant with margin
 * at two thirds of the cost of three; each step re-bins the positions, so each is complete.
 */
export const COLLISION_STEPS = 2;
/** An empty round texel: above every slot id (ids are exact in float32 below 2²⁴). */
const EMPTY = 1e30;
/** `key.y` of a slot that is not binned (an exact segment's, or a listed slot), and a list pad. */
const NO_CELL = 0xffffffff;
/** Buckets addressable next to a 4-bit class in `key.y`. */
const BUCKET_LIMIT = 0x0fffffff;

const NEAREST: SamplerProps = { minFilter: "nearest", magFilter: "nearest" };

const MIN_BLEND: RenderPipelineParameters = {
  blend: true,
  blendColorSrcFactor: "one",
  blendColorDstFactor: "one",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one",
  blendColorOperation: "min",
  blendAlphaOperation: "min",
};

/** GLSL shared by the passes. */
const COMMON_GLSL = /* glsl */ `\
const uint NO_CELL = ${NO_CELL}u;
const uint BUCKET_LIMIT = ${BUCKET_LIMIT}u;
const int ITEM_SHIFT = ${COLLISION_ITEM_SHIFT};
uniform int u_bucketShift;           // log2 of the class-cell bucket atlas width (a power of two)
uniform int u_subShift;              // log2 of the sub-cell bucket atlas width
ivec2 atlasTexel(uint b, int shift) { return ivec2(int(b & ((1u << shift) - 1u)), int(b >> shift)); }
`;

/**
 * Cell pass: each slot's key `(F.x | F.y << 16, bucket | class << 28, sub-cell bucket, 0)` — its finest
 * sub-cell, its class cell's bucket (NO_CELL when it is not binned) and its sub-cell's bucket — and, by
 * MRT, its disc `(x, y, radius, 0)` in one texel, so every pair test of the gather is one fetch.
 */
const CELL_FS = /* glsl */ `\
#version 300 es
${segmentDefines(false)}
precision highp float;
precision highp int;
precision highp usampler2D;
uniform highp sampler2D u_pos;
uniform highp sampler2D u_rad;
uniform highp sampler2D u_segBox;       // (maxX, maxY, −minX, −minY) of this step's positions
uniform highp sampler2D u_segNested;    // (finest sub-cell side, owner slot, 0, 0)
uniform highp usampler2D u_slotCollide; // class | EXACT | first item per slot
uniform highp usampler2D u_segCollide;  // per segment: list 0-3, list 4-7, (bucket base, bucket mask, classes, sub base)
uniform int u_count;
uniform int u_width;
uniform int u_collideWidth;
layout(location = 0) out uvec4 o_key;
layout(location = 1) out vec4 o_disc;
${SLOT_TEXEL_GLSL}
${SEGMENT_OF_GLSL}
${COLLISION_GLSL}
${COMMON_GLSL}
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  if (texelSlot(fc, u_width) >= u_count) { o_key = uvec4(0u, NO_CELL, 0u, 0u); o_disc = vec4(0.0); return; }
  vec2 p = texelFetch(u_pos, fc, 0).xy;
  float r = texelFetch(u_rad, fc, 0).r;
  o_disc = vec4(p, r, 0.0);
  int seg = int(texelFetch(u_slotSeg, fc, 0).r);
  ivec2 st = slotTexel(seg, u_tableWidth);
  uvec4 grid = texelFetch(u_segCollide, slotTexel(3 * seg + 2, u_collideWidth), 0);
  if (grid.z == 0u) { o_key = uvec4(0u, NO_CELL, 0u, 0u); return; } // no grid: every slot takes the exact loop
  vec2 q = (p + texelFetch(u_segBox, st, 0).zw) / texelFetch(u_segNested, st, 0).x;
  ivec2 f = ivec2(clamp(floor(q), vec2(0.0), vec2(float(F_MAX))));
  uint packedF = uint(f.x) | (uint(f.y) << 16);
  int c = int(texelFetch(u_slotCollide, fc, 0).r & 15u);
  if (c < int((grid.z >> 5) & 31u)) { o_key = uvec4(packedF, NO_CELL, 0u, 0u); return; } // listed
  int shift = int(grid.z & 31u) - 1 - c + SUB;
  uint bucket = grid.x + (cellHash(c, f.x >> shift, f.y >> shift) & grid.y);
  uint subMask = (1u << ((grid.z >> 10) & 31u)) - 1u;
  uint subBucket = grid.w + (cellHash(c + 16, f.x >> (shift - SUB), f.y >> (shift - SUB)) & subMask);
  o_key = uvec4(packedF, bucket | (uint(c) << 28), subBucket, 0u);
}
`;

/**
 * Scatter vertex shader shared by the count passes and the rounds of both tables: binned slot
 * `gl_VertexID` → a point on its bucket — in the sub-cell table only when its class-cell bucket holds more
 * than K. A round skips a slot whose id is not above the id round r − 1 left in its bucket.
 */
function scatterVs(rounds: number): string {
  return /* glsl */ `\
#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform highp usampler2D u_key;
uniform highp usampler2D u_binned;   // the binned slots, one per point
uniform highp sampler2D u_prev;      // round r − 1 (rounds only)
uniform highp sampler2D u_cellCount; // the class-cell counts (the sub-cell table's cull)
uniform int u_width;
uniform int u_binnedWidth;
uniform int u_first;                 // the first binned slot of this draw (a band of them, #382)
uniform vec2 u_atlas;                // this table's atlas size
uniform int u_sub;                   // 0: the class-cell table; 1: the sub-cell table
uniform int u_round;                 // −1: the count pass; r ≥ 0: round r
uniform int u_prevChannel;           // round r − 1's channel in u_prev
flat out float v_id;
${SLOT_TEXEL_GLSL}
${COMMON_GLSL}
void main() {
  gl_PointSize = 1.0;
  int slot = int(texelFetch(u_binned, slotTexel(u_first + gl_VertexID, u_binnedWidth), 0).r);
  uvec4 key = texelFetch(u_key, slotTexel(slot, u_width), 0);
  v_id = float(slot);
  ivec2 cell = atlasTexel(key.y & BUCKET_LIMIT, u_bucketShift);
  ivec2 t = cell;
  if (u_sub == 1) {
    if (texelFetch(u_cellCount, cell, 0).x <= ${rounds}.0) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
    t = atlasTexel(key.z, u_subShift);
  }
  if (u_round > 0) {
    vec4 p = texelFetch(u_prev, t, 0);
    float prev = u_prevChannel == 0 ? p.x : u_prevChannel == 1 ? p.y : u_prevChannel == 2 ? p.z : p.w;
    if (v_id <= prev) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  }
  gl_Position = vec4((vec2(t) + 0.5) / u_atlas * 2.0 - 1.0, 0.0, 1.0);
}
`;
}

const COUNT_FS = /* glsl */ `\
#version 300 es
precision highp float;
flat in float v_id;
layout(location = 0) out vec4 o_count;
void main() { o_count = vec4(1.0, 0.0, 0.0, 0.0); }
`;

const ROUND_FS = /* glsl */ `\
#version 300 es
precision highp float;
flat in float v_id;
uniform int u_channel;               // round r → channel r / (K / 4) of texture r % (K / 4)
layout(location = 0) out vec4 o_round;
void main() {
  vec4 o = vec4(${EMPTY.toExponential()});
  if (u_channel == 0) o.x = v_id; else if (u_channel == 1) o.y = v_id; else if (u_channel == 2) o.z = v_id; else o.w = v_id;
  o_round = o;
}
`;


/**
 * The collision push on slot i (at xi, radius ri) from slot j at dj = (xj, rj) — nested-layout.ts
 * collide().resolve as seen from either side: away from j by the overlap (min − d), times j's mass share
 * m_j / (m_i + m_j). A coincident pair separates by exactly min along (cos(a + b), sin(a + b)), a and b
 * their local indices, from the lower slot to the higher (#357). Zero unless the two touch. Needs
 * `u_disc`, `u_width` and `u_pad`.
 */
const PUSH_GLSL = /* glsl */ `\
vec2 pushFrom(int i, vec2 xi, float ri, int j, vec3 dj, int start) {
  vec2 d = xi - dj.xy;
  float rj = dj.z;
  float minD = (ri + rj) * u_pad;
  float d2 = dot(d, d);
  if (!(d2 < minD * minD)) return vec2(0.0);
  float mi = ri * ri;
  float mj = rj * rj;
  float share = mj / (mi + mj);
  if (d2 > 0.0) {
    float dist = sqrt(d2);
    return d * ((minD - dist) / dist * share);
  }
  float ang = float((i - start) + (j - start));
  vec2 u = normalize(vec2(cos(ang), sin(ang))); // a unit vector even where cos / sin are approximations
  return (i < j ? -u : u) * (minD * share);
}

vec2 push(int i, vec2 xi, float ri, int j, int start) {
  return pushFrom(i, xi, ri, j, texelFetch(u_disc, slotTexel(j, u_width), 0).xyz, start);
}
`;

/**
 * The collision search of the item pass: `slotWork(id, sc, part, parts, stat)` — the sum of the
 * pushes slot `id` (at slot-atlas texel `sc`) finds in its work item `part` of `parts`. With
 * `COLLISION_STATS`, `stat` accumulates `(cells visited, pairs tested, grid partners pushed, 1 exact slot /
 * 2 overflow)` (cells visited: class cells and the sub-cells of dense ones; pairs tested: list entries,
 * bucket occupants read, and exact-loop partners).
 */
function collideGlsl(refine: number): string {
  const cellTextures = COLLISION_ROUNDS / 4;
  const subTextures = COLLISION_SUB_ROUNDS / 4;
  const uniforms = (name: string, n: number): string => Array.from({ length: n }, (_, t) => `uniform highp sampler2D ${name}${t};`).join("\n");
  // Round r of a bucket: texture r % (K / 4), channel r / (K / 4).
  const roundId = (fn: string, name: string, n: number): string =>
    `float ${fn}(ivec2 bt, int r) {\n  int t = r % ${n};\n  vec4 v = ` +
    Array.from({ length: n }, (_, t) => (t < n - 1 ? `t == ${t} ? texelFetch(${name}${t}, bt, 0) : ` : `texelFetch(${name}${t}, bt, 0)`)).join("") +
    `;\n  return channel(v, r / ${n});\n}`;
  return /* glsl */ `\
#define ROUNDS ${COLLISION_ROUNDS}
#define SUB_ROUNDS ${COLLISION_SUB_ROUNDS}
#define REFINE ${refine}
#define PART_VISITS ${COLLISION_PART_VISITS}
#define PART_PAIRS ${COLLISION_PART_PAIRS}
uniform highp sampler2D u_disc;         // (x, y, radius, 0) per slot, from the cell pass
uniform highp usampler2D u_key;         // per slot, from the cell pass
uniform highp usampler2D u_slotCollide; // class | EXACT | MULTI | items before it, per slot
uniform highp usampler2D u_items;       // (slot, part | parts << 16) per work item
uniform highp sampler2D u_segNested;
uniform highp usampler2D u_segCollide;
uniform highp usampler2D u_segInfo;
uniform highp sampler2D u_cellCount;
${uniforms("u_round", cellTextures)}
uniform highp sampler2D u_subCount;
${uniforms("u_subRound", subTextures)}
uniform int u_count;
uniform int u_width;
uniform int u_itemWidth;
uniform int u_collideWidth;
uniform float u_pad;
${SLOT_TEXEL_GLSL}
${SEGMENT_OF_GLSL}
${COLLISION_GLSL}
${COMMON_GLSL}

${PUSH_GLSL}
uint channel(uvec4 v, int c) { return c == 0 ? v.x : c == 1 ? v.y : c == 2 ? v.z : v.w; }
float channel(vec4 v, int c) { return c == 0 ? v.x : c == 1 ? v.y : c == 2 ? v.z : v.w; }
${roundId("cellRound", "u_round", cellTextures)}
${roundId("subRound", "u_subRound", subTextures)}

// The class cells (2^shift finest sub-cells wide) slot i visits: those its disc, padded by the class's
// largest radius, overlaps.
void searchWindow(ivec2 f, float ri, float padOverSide, int shift, out ivec2 lo, out ivec2 hi) {
  float h = searchReach(ri, padOverSide, shift + REFINE);
  lo = max(f - int(ceil(h)), ivec2(0)) >> shift;
  hi = min(f + 1 + int(floor(h)), ivec2(F_MAX)) >> shift;
}

vec2 slotWork(int id, ivec2 sc, int part, int parts, inout vec4 stat) {
  int seg = int(texelFetch(u_slotSeg, sc, 0).r);
  ivec2 st = slotTexel(seg, u_tableWidth);
  uvec4 info = texelFetch(u_segInfo, st, 0);
  int start = int(info.x);
  int end = start + int(info.y);
  vec3 di = texelFetch(u_disc, sc, 0).xyz;
  vec2 xi = di.xy;
  float ri = di.z;
  vec2 acc = vec2(0.0);
  if ((texelFetch(u_slotCollide, sc, 0).r & COLLIDE_EXACT) != 0u) {
    // An exact slot: its part of the loop over its k − 1 partners, the plan's parts of PART_PAIRS each.
    // Partner q is slot start + q, one further from the slot itself on.
    int q0 = part * PART_PAIRS;
    int q1 = min(q0 + PART_PAIRS, end - start - 1);
    for (int q = q0; q < q1; q++) {
      int j = start + q;
      acc += push(id, xi, ri, j < id ? j : j + 1, start);
    }
#ifdef COLLISION_STATS
    stat.y += float(max(q1 - q0, 0));
    stat.w = 1.0;
#endif
    return acc;
  }
  // A grid slot. Part 0 also tests the segment's list, its coarsest classes, directly.
  if (part == 0) {
    uvec4 list0 = texelFetch(u_segCollide, slotTexel(3 * seg, u_collideWidth), 0);
    uvec4 list1 = texelFetch(u_segCollide, slotTexel(3 * seg + 1, u_collideWidth), 0);
    for (int q = 0; q < ${COLLISION_LIST_MAX}; q++) {
      uint j = channel(q < 4 ? list0 : list1, q & 3);
      if (j == NO_CELL) break;
      if (int(j) == id) continue;
      acc += push(id, xi, ri, int(j), start);
#ifdef COLLISION_STATS
      stat.y += 1.0;
#endif
    }
  }
  vec2 listed = acc;
  uvec4 grid = texelFetch(u_segCollide, slotTexel(3 * seg + 2, u_collideWidth), 0);
  uint fp = texelFetch(u_key, sc, 0).x;
  ivec2 f = ivec2(int(fp & 65535u), int(fp >> 16));
  int classes = int(grid.z & 31u);
  int firstClass = int((grid.z >> 5) & 31u);
  uint subMask = (1u << ((grid.z >> 10) & 31u)) - 1u;
  float padOverSide = u_pad / texelFetch(u_segNested, st, 0).x;
  // This part's slice [a, b) of the slot's class-cell visits, in class then row-major order. The plan's
  // parts cover the most cells these float32 windows can span (searchCellsPerAxis), so no part has more
  // than PART_VISITS; the last part still runs to the end, so completeness does not rest on that bound.
  int a = part * PART_VISITS;
  int b = part == parts - 1 ? 0x7fffffff : a + PART_VISITS;
  int idx = 0;
  bool overflow = false;
  for (int c = firstClass; c < classes && idx < b && !overflow; c++) {
    if (((grid.z >> (16 + c)) & 1u) == 0u) continue;
    int shift = classes - 1 - c + SUB;
    ivec2 lo;
    ivec2 hi;
    searchWindow(f, ri, padOverSide, shift, lo, hi);
    int wx = hi.x - lo.x + 1;
    int cells = wx * (hi.y - lo.y + 1);
    int v1 = min(cells, b - idx);
    for (int v = max(a - idx, 0); v < v1 && !overflow; v++) {
      ivec2 cell = lo + ivec2(v % wx, v / wx);
      ivec2 bt = atlasTexel(grid.x + (cellHash(c, cell.x, cell.y) & grid.y), u_bucketShift);
      int n = int(texelFetch(u_cellCount, bt, 0).x);
#ifdef COLLISION_STATS
      stat.x += 1.0;
#endif
      if (n == 0) continue;
      // A dense cell is visited as its 2^SUB × 2^SUB sub-cells, in the sub-cell table.
      bool dense = n > ROUNDS;
      int subs = dense ? 1 << (2 * SUB) : 1;
      int at = dense ? shift - SUB : shift;
      for (int s = 0; s < subs; s++) {
        ivec2 target = cell;
        if (dense) {
          target = (cell << SUB) + ivec2(s & ((1 << SUB) - 1), s >> SUB);
          bt = atlasTexel(grid.w + (cellHash(c + 16, target.x, target.y) & subMask), u_subShift);
          n = int(texelFetch(u_subCount, bt, 0).x);
#ifdef COLLISION_STATS
          stat.x += 1.0;
#endif
          if (n == 0) continue;
          if (n > SUB_ROUNDS) { overflow = true; break; }
        }
        for (int r = 0; r < SUB_ROUNDS; r++) {
          if (r >= n) break;
          int j = int(dense ? subRound(bt, r) : cellRound(bt, r));
          if (j == id) continue;
#ifdef COLLISION_STATS
          stat.y += 1.0;
#endif
          vec2 pj = pushFrom(id, xi, ri, j, texelFetch(u_disc, slotTexel(j, u_width), 0).xyz, start);
          if (pj == vec2(0.0)) continue;
          // Touching: count it here only if this is its own cell (another visited cell may share the bucket).
          uvec2 kj = texelFetch(u_key, slotTexel(j, u_width), 0).xy;
          if (int(kj.y >> 28) != c || ivec2(int(kj.x & 65535u), int(kj.x >> 16)) >> at != target) continue;
          acc += pj;
#ifdef COLLISION_STATS
          stat.z += 1.0;
#endif
        }
      }
    }
    idx += cells;
  }
  if (overflow) {
    // A sub-cell had more occupants than its rounds list: redo this slice exactly — every binned sibling
    // whose class cell is one of this part's visits (the list stays part 0's), class by class.
    acc = listed;
    int first = 0; // the visit index of the class's first cell
    for (int c = firstClass; c < classes && first < b; c++) {
      if (((grid.z >> (16 + c)) & 1u) == 0u) continue;
      int shift = classes - 1 - c + SUB;
      ivec2 lo;
      ivec2 hi;
      searchWindow(f, ri, padOverSide, shift, lo, hi);
      int wx = hi.x - lo.x + 1;
      int cells = wx * (hi.y - lo.y + 1);
      if (first + cells > a) {
        for (int j = start; j < end; j++) {
          if (j == id) continue;
          uvec2 kj = texelFetch(u_key, slotTexel(j, u_width), 0).xy;
          if (kj.y == NO_CELL || int(kj.y >> 28) != c) continue;
          ivec2 cell = ivec2(int(kj.x & 65535u), int(kj.x >> 16)) >> shift;
          if (any(lessThan(cell, lo)) || any(greaterThan(cell, hi))) continue;
          int v = first + (cell.y - lo.y) * wx + (cell.x - lo.x);
          if (v < a || v >= b) continue;
          acc += push(id, xi, ri, j, start);
#ifdef COLLISION_STATS
          stat.y += 1.0;
#endif
        }
      }
      first += cells;
    }
#ifdef COLLISION_STATS
    stat.w = 2.0;
#endif
  }
  return acc;
}
`;
}

/**
 * Item pass: the work items of the slots cut into more than one, those in `[u_itemBegin, u_itemEnd)` (a
 * band's; the others under its scissor are discarded, so another band's partials stay) — each its part's
 * push sum into the partial texture, or with `COLLISION_STATS` its statistics.
 */
function itemFs(refine: number, stats: boolean): string {
  return /* glsl */ `\
#version 300 es
${segmentDefines(false)}
${stats ? "#define COLLISION_STATS" : ""}
precision highp float;
precision highp int;
precision highp usampler2D;
${collideGlsl(refine)}
uniform int u_itemBegin;
uniform int u_itemEnd;
#ifdef COLLISION_STATS
layout(location = 0) out vec4 o_out;
#else
layout(location = 0) out vec2 o_out;
#endif
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int item = texelSlot(fc, u_itemWidth);
  if (item < u_itemBegin || item >= u_itemEnd) {
    discard;
  } else {
    uvec2 work = texelFetch(u_items, fc, 0).xy;
    int id = int(work.x);
    vec4 stat = vec4(0.0);
    vec2 acc = slotWork(id, slotTexel(id, u_width), int(work.y & 65535u), int(work.y >> 16), stat);
#ifdef COLLISION_STATS
    o_out = stat;
#else
    o_out = acc;
#endif
  }
}
`;
}

/**
 * Resolve pass: each slot's new position — its position plus RELAX of its pushes: the sum of its work
 * items' partials, or its exact loop when that is not itemized (a single item's worth) — or with
 * `COLLISION_STATS` its statistics. It carries no grid search, so it runs at the exact loop's occupancy.
 */
function resolveFs(stats: boolean): string {
  return /* glsl */ `\
#version 300 es
${segmentDefines(false)}
${stats ? "#define COLLISION_STATS" : ""}
precision highp float;
precision highp int;
precision highp usampler2D;
uniform highp sampler2D u_disc;         // (x, y, radius, 0) per slot, from the cell pass
uniform highp usampler2D u_slotCollide; // class | EXACT | ITEMIZED | items before it, per slot
uniform highp usampler2D u_items;       // (slot, part | parts << 16) per work item
uniform highp usampler2D u_segInfo;
uniform highp sampler2D u_partial;      // per work item, from the item pass (with COLLISION_STATS: its statistics)
uniform int u_count;
uniform int u_width;
uniform int u_itemWidth;
uniform float u_pad;
uniform float u_relax;
#ifdef COLLISION_STATS
layout(location = 0) out vec4 o_out;
#else
layout(location = 0) out vec2 o_out;
#endif
${SLOT_TEXEL_GLSL}
${SEGMENT_OF_GLSL}
${COMMON_GLSL}
${PUSH_GLSL}
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int id = texelSlot(fc, u_width);
#ifdef COLLISION_STATS
  if (id >= u_count) { o_out = vec4(0.0); return; }
#else
  if (id >= u_count) { o_out = vec2(0.0); return; }
#endif
  uint code = texelFetch(u_slotCollide, fc, 0).r;
  vec3 di = texelFetch(u_disc, fc, 0).xyz;
  vec4 stat = vec4(0.0);
  vec2 acc = vec2(0.0);
  if ((code & ${COLLISION_ITEMIZED}u) != 0u) {
    int first = int(code >> ITEM_SHIFT);
    int parts = int(texelFetch(u_items, slotTexel(first, u_itemWidth), 0).y >> 16);
    for (int p = 0; p < parts; p++) {
      vec4 part = texelFetch(u_partial, slotTexel(first + p, u_itemWidth), 0);
      acc += part.xy;
      stat = vec4(stat.xyz + part.xyz, max(stat.w, part.w));
    }
  } else {
    // An exact slot whose loop is a single item: run it here.
    uvec4 info = texelFetch(u_segInfo, segmentTexelOf(fc), 0);
    int start = int(info.x);
    int end = start + int(info.y);
    for (int j = start; j < end; j++) {
      if (j != id) acc += push(id, di.xy, di.z, j, start);
    }
    stat = vec4(0.0, float(end - start - 1), 0.0, 1.0);
  }
#ifdef COLLISION_STATS
  o_out = stat;
#else
  o_out = di.xy + u_relax * acc;
#endif
}
`;
}

/** The static per-slot and per-segment textures of the plan, and the segment table's per-step state. */
export interface CollisionInputs {
  slotSeg: Texture;
  /** The segment table: info, and this step's box (reduced over the positions). */
  segments: SegmentTable;
  /** Per segment `(finest sub-cell side, owner slot, 0, 0)`, the segment table's atlas. */
  segNested: Texture;
  /** Per slot its class, exact and multi bits, and the work items before it (`r32uint`, the slot atlas). */
  slotCollide: Texture;
  /** Per segment 3 `rgba32uint` texels: its list (2), then (bucket base, bucket mask, classes, sub-cell base). */
  segCollide: Texture;
  /** Atlas width of {@link segCollide}. */
  collideWidth: number;
  count: number;
  width: number;
  /** Rows of the slot atlas (the bands' domain). */
  rows: number;
  pad: number;
}

/** What {@link CollisionGrid.prepare} reads besides {@link CollisionInputs}. */
export interface CollisionPrepareInput extends CollisionInputs {
  /** Current positions. */
  pos: Texture;
  radius: Texture;
}

/** Options of a {@link CollisionGrid}. */
export interface CollisionGridOptions {
  /** Build the statistics passes ({@link CollisionGrid.gatherStats}) — tests only. */
  stats?: boolean;
}

/** One hash table's textures: counts, K / 4 round textures, and the atlas shift. */
interface BucketTable {
  readonly count: Texture;
  readonly countFbo: Framebuffer;
  readonly rounds: readonly Texture[];
  readonly roundFbos: readonly Framebuffer[];
  readonly shift: number;
  readonly atlas: Float32Array;
}

/**
 * The atlas of a hash table of `buckets` buckets: a power-of-two width, so a bucket's texel is a mask and a
 * shift, and as many rows as the buckets fill. The grid's tables and {@link collisionGridSide} share it.
 */
function bucketAtlas(buckets: number): { shift: number; width: number; height: number } {
  let shift = 0;
  while (1 << (2 * shift) < buckets) shift++;
  const width = 1 << shift;
  return { shift, width, height: Math.max(1, Math.ceil(buckets / width)) };
}

/** Rows of the work-item atlas of `items` items on a `slotWidth`-wide slot atlas (its width). */
function itemAtlasRows(slotWidth: number, items: number): number {
  return Math.max(1, Math.ceil(items / slotWidth));
}

/**
 * The largest texture side a {@link CollisionGrid} of `plan` allocates besides its slot-atlas textures
 * (the keys and discs, `slotWidth` wide): its two hash tables, the work-item atlas and the binned-slot
 * list — sized by the rules the constructor uses, so the nested layout's device verdict
 * (`gpuNestedLayoutNeed`) covers them. O(1).
 */
export function collisionGridSide(slotWidth: number, plan: CollisionPlan): number {
  const cells = bucketAtlas(plan.bucketCount);
  const subs = bucketAtlas(plan.subBucketCount);
  const binnedWidth = atlasWidth(Math.max(1, plan.binnedSlots.length));
  return Math.max(cells.width, cells.height, subs.width, subs.height, itemAtlasRows(slotWidth, plan.itemCount), binnedWidth);
}

/** The statistics passes' targets and programs (tests only). */
interface StatsPasses {
  readonly items: Texture;
  readonly itemsFbo: Framebuffer;
  readonly slots: Texture;
  readonly slotsFbo: Framebuffer;
  readonly itemModel: Model;
  readonly resolveModel: Model;
}

/**
 * The collision grid's textures and passes, created once for a slot atlas and a {@link CollisionPlan}. A
 * Jacobi collision step is {@link prepare} (the {@link cells} pass, then per table a count scatter and K
 * round {@link scatter}s), then {@link gather} (the work {@link items}, then the {@link resolve}) — each pass
 * sliceable into bands, each band its own render pass (#382). Nothing is allocated or submitted per step
 * (the caller's work item submits, #402).
 *
 * Memory: the key 16 B and the disc 16 B per slot atlas texel; the work items 8 B and their partial sums
 * 8 B per item-atlas texel (the parts of the slots cut into more than one); 4 B per binned slot (the
 * scatters' list); per class-cell bucket the count 4 B and 2 round textures of 16 B (36 B), 1-2 per binned
 * slot; per sub-cell bucket 4 B and 3 round textures (52 B), 0.5-1 per binned slot.
 */
export class CollisionGrid {
  private readonly device: Device;
  private readonly key: Texture;
  /** `(x, y, radius, 0)` per slot, written with the keys: the gather's one fetch per pair. */
  private readonly disc: Texture;
  private readonly keyFbo: Framebuffer;
  /** The class-cell table and the sub-cell table. */
  private readonly cells_: BucketTable;
  private readonly subs: BucketTable;
  /** The binned slots (the scatters' points), and their atlas width. */
  private readonly binned: Texture;
  private readonly binnedCount: number;
  private readonly binnedWidth: number;
  /** Where the item and resolve bands are cut: their cumulative estimated work (the plan's, `collisionCuts`). */
  private readonly itemWorkBefore: Float64Array;
  private readonly resolveWorkBefore: Float64Array;
  /** The work items `(slot, part | parts << 16)`, and each item's partial sum. */
  private readonly items_: Texture;
  private readonly partial: Texture;
  private readonly partialFbo: Framebuffer;
  /** Per slot, the work items of the slots before it (the plan's, for the bands' item ranges). */
  private readonly itemsBefore: Uint32Array;
  private readonly cellModel: Model;
  private readonly countModel: Model;
  private readonly roundModel: Model;
  private readonly itemModel: Model;
  private readonly resolveModel: Model;
  private readonly cellUniforms: PassUniforms;
  private readonly scatterUniforms: PassUniforms;
  private readonly roundUniforms: PassUniforms;
  private readonly searchUniforms: PassUniforms;
  private readonly stats: StatsPasses | null;
  /** Everything this grid created, in creation order ({@link destroy} frees it in reverse). */
  private readonly owned: readonly { destroy(): void }[];
  /** The work-item atlas: its width (the slot atlas's) and rows. */
  private readonly itemWidth: number;
  private readonly itemRows_: number;
  /**
   * The search and resolve passes' texture bindings, filled once and pointed at each step's inputs (no record
   * per band).
   */
  private readonly searchBindings: Record<string, Texture>;
  private readonly resolveBindings: Record<string, Texture>;
  private readonly itemCount: number;
  private readonly slotHeight: number;

  constructor(device: Device, slotWidth: number, slotHeight: number, plan: CollisionPlan, options: CollisionGridOptions = {}) {
    if (plan.bucketCount > BUCKET_LIMIT) throw new Error(`CollisionGrid: ${plan.bucketCount} buckets, beyond ${BUCKET_LIMIT}`);
    this.device = device;
    const binnedSlots = plan.binnedSlots;
    this.binnedCount = binnedSlots.length;
    const bw = atlasWidth(Math.max(1, binnedSlots.length));
    this.binnedWidth = bw;
    this.slotHeight = slotHeight;
    const binnedData = new Uint32Array(bw * Math.max(1, Math.ceil(binnedSlots.length / bw)));
    binnedData.set(binnedSlots);
    this.itemCount = plan.itemCount;
    this.itemsBefore = new Uint32Array(plan.slotCollide.length + 1);
    plan.slotCollide.forEach((word, i) => {
      this.itemsBefore[i] = word >>> COLLISION_ITEM_SHIFT;
    });
    this.itemsBefore[plan.slotCollide.length] = plan.itemCount;
    const cuts = collisionCuts(plan, slotWidth);
    this.itemWorkBefore = cuts.itemWorkBefore;
    this.resolveWorkBefore = cuts.resolveWorkBefore;
    this.itemWidth = slotWidth;
    this.itemRows_ = itemAtlasRows(slotWidth, plan.itemCount);
    const iw = this.itemWidth;
    const ih = this.itemRows_;
    const itemData = new Uint32Array(2 * iw * ih);
    itemData.set(plan.items);
    const own: { destroy(): void }[] = [];
    const keep = <T extends { destroy(): void }>(r: T): T => {
      own.push(r);
      return r;
    };
    // A table of `buckets` buckets and `rounds` rounds ({@link bucketAtlas}).
    const table = (buckets: number, rounds: number): BucketTable => {
      const { shift, width: w, height: h } = bucketAtlas(buckets);
      const texture = (format: "r32float" | "rgba32float"): Texture => keep(device.createTexture({ width: w, height: h, format, mipLevels: 1, sampler: NEAREST }));
      const fbo = (t: Texture): Framebuffer => keep(device.createFramebuffer({ width: w, height: h, colorAttachments: [t] }));
      const count = texture("r32float");
      const textures = Array.from({ length: rounds / 4 }, () => texture("rgba32float"));
      return { count, countFbo: fbo(count), rounds: textures, roundFbos: textures.map(fbo), shift, atlas: new Float32Array([w, h]) };
    };
    try {
      this.binned = keep(device.createTexture({ width: bw, height: binnedData.length / bw, format: "r32uint", data: binnedData, mipLevels: 1, sampler: NEAREST }));
      this.items_ = keep(device.createTexture({ width: iw, height: ih, format: "rg32uint", data: itemData, mipLevels: 1, sampler: NEAREST }));
      this.partial = keep(device.createTexture({ width: iw, height: ih, format: "rg32float", mipLevels: 1, sampler: NEAREST }));
      this.partialFbo = keep(device.createFramebuffer({ width: iw, height: ih, colorAttachments: [this.partial] }));
      this.key = keep(device.createTexture({ width: slotWidth, height: slotHeight, format: "rgba32uint", mipLevels: 1, sampler: NEAREST }));
      this.disc = keep(device.createTexture({ width: slotWidth, height: slotHeight, format: "rgba32float", mipLevels: 1, sampler: NEAREST }));
      this.keyFbo = keep(device.createFramebuffer({ width: slotWidth, height: slotHeight, colorAttachments: [this.key, this.disc] }));
      this.cells_ = table(plan.bucketCount, COLLISION_ROUNDS);
      this.subs = table(plan.subBucketCount, COLLISION_SUB_ROUNDS);
      const searchBindings: Record<string, Texture> = {
        u_disc: this.disc,
        u_key: this.key,
        u_items: this.items_,
        u_cellCount: this.cells_.count,
        u_subCount: this.subs.count,
      };
      this.cells_.rounds.forEach((t, i) => {
        searchBindings[`u_round${i}`] = t;
      });
      this.subs.rounds.forEach((t, i) => {
        searchBindings[`u_subRound${i}`] = t;
      });
      this.searchBindings = searchBindings;
      this.resolveBindings = { u_disc: this.disc, u_items: this.items_ };
      const shifts = { u_bucketShift: this.cells_.shift, u_subShift: this.subs.shift };
      this.cellUniforms = { u_count: 0, u_width: 1, u_tableWidth: 1, u_collideWidth: 1, ...shifts };
      this.cellModel = keep(fullScreenModel(device, CELL_FS, this.cellUniforms, NO_BLEND));
      const scatterBase = { u_width: 1, u_binnedWidth: bw, u_first: 0, ...shifts, u_atlas: this.cells_.atlas, u_sub: 0, u_prevChannel: 0 };
      this.scatterUniforms = { ...scatterBase, u_round: -1 };
      this.roundUniforms = { ...scatterBase, u_round: 0, u_channel: 0 };
      const vs = scatterVs(COLLISION_ROUNDS);
      const scatter = (fs: string, uniforms: PassUniforms, parameters: RenderPipelineParameters): Model =>
        keep(new Model(device, { vs, fs, topology: "point-list", vertexCount: Math.max(1, binnedSlots.length), uniforms, parameters }));
      this.countModel = scatter(COUNT_FS, this.scatterUniforms, ADDITIVE_BLEND);
      this.roundModel = scatter(ROUND_FS, this.roundUniforms, MIN_BLEND);
      this.searchUniforms = {
        u_count: 0,
        u_width: 1,
        u_itemWidth: iw,
        u_tableWidth: 1,
        u_collideWidth: 1,
        u_pad: 1,
        u_itemBegin: 0,
        u_itemEnd: 0,
        u_relax: COLLISION_RELAX,
        ...shifts,
      };
      this.itemModel = keep(fullScreenModel(device, itemFs(plan.refine, false), this.searchUniforms, NO_BLEND));
      this.resolveModel = keep(fullScreenModel(device, resolveFs(false), this.searchUniforms, NO_BLEND));
      if (options.stats) {
        const items = keep(device.createTexture({ width: iw, height: ih, format: "rgba32float", mipLevels: 1, sampler: NEAREST }));
        const slots = keep(device.createTexture({ width: slotWidth, height: slotHeight, format: "rgba32float", mipLevels: 1, sampler: NEAREST }));
        this.stats = {
          items,
          itemsFbo: keep(device.createFramebuffer({ width: iw, height: ih, colorAttachments: [items] })),
          slots,
          slotsFbo: keep(device.createFramebuffer({ width: slotWidth, height: slotHeight, colorAttachments: [slots] })),
          itemModel: keep(fullScreenModel(device, itemFs(plan.refine, true), this.searchUniforms, NO_BLEND)),
          resolveModel: keep(fullScreenModel(device, resolveFs(true), this.searchUniforms, NO_BLEND)),
        };
      } else {
        this.stats = null;
      }
    } catch (error) {
      for (let i = own.length - 1; i >= 0; i--) own[i]?.destroy();
      throw error;
    }
    this.owned = own;
  }

  /** Rows of the binned slots' atlas: the most bands a {@link scatter} can be cut into. */
  get scatterRows(): number {
    return Math.max(1, Math.ceil(this.binnedCount / this.binnedWidth));
  }

  /** Rows of the work-item atlas: the most bands {@link items} can be cut into (1 without items). */
  get itemRows(): number {
    return this.itemRows_;
  }

  /** Rounds of occupant enumeration of table `table` (0: the class cells, 1: the sub-cells). */
  rounds(table: 0 | 1): number {
    return table === 0 ? COLLISION_ROUNDS : COLLISION_SUB_ROUNDS;
  }

  /**
   * Encode the first half of a collision step: every slot's key and disc (from `input.pos` and this
   * step's box), then each table's counts and K rounds. Then {@link gather}.
   */
  prepare(input: CollisionPrepareInput): void {
    this.cells(input);
    for (const table of TABLES) {
      for (let round = -1; round < this.rounds(table); round++) this.scatter(table, round, input.width);
    }
  }

  /**
   * The cell pass over the slot atlas rows of band `band` of `bands` (a scissor): every slot's key and disc,
   * from `input.pos` and this step's box.
   */
  cells(input: CollisionPrepareInput, band = 0, bands = 1): void {
    const [r0, r1] = bandRows(band, bands, input.rows);
    if (r1 <= r0) return;
    const { segments } = input;
    const cu = this.cellUniforms;
    cu["u_count"] = input.count;
    cu["u_width"] = input.width;
    cu["u_tableWidth"] = segments.width;
    cu["u_collideWidth"] = input.collideWidth;
    this.cellModel.setBindings({
      u_pos: input.pos,
      u_rad: input.radius,
      u_segBox: segments.box,
      u_segNested: input.segNested,
      u_slotCollide: input.slotCollide,
      u_segCollide: input.segCollide,
      u_slotSeg: input.slotSeg,
    });
    this.draw(this.cellModel, bands > 1 ? { framebuffer: this.keyFbo, clear: false, scissor: [0, r0, input.width, r1 - r0] } : { framebuffer: this.keyFbo, clear: false });
  }

  /**
   * One scatter of table `table` (0: the class cells, 1: the sub-cells of the dense ones) over the binned
   * slots of band `band` of `bands` (their atlas rows): its count (`round` −1), or round `round`. The first
   * band of the count, and of each round texture's first round, opens its target with the clear; every band
   * scatters its own range of the binned slots, in order. The sub-cell table reads the class-cell counts (its
   * cull), so it follows every band of the class-cell count.
   */
  scatter(table: 0 | 1, round: number, slotWidth: number, band = 0, bands = 1): void {
    if (this.binnedCount === 0) return; // nothing to bin
    const [first, end] = bandSlots(band, bands, this.binnedWidth, this.binnedCount);
    const t = table === 0 ? this.cells_ : this.subs;
    const textures = t.rounds.length;
    const tex = (r: number): Texture => t.rounds[r % textures] ?? t.count;
    // The class-cell counts are the sub-cell table's cull; the class-cell table never reads them (a stand-in
    // is bound, since a sampled texture that is also the render target drops the draw).
    const counts = table === 1 ? this.cells_.count : this.subs.count;
    if (round < 0) {
      if (band > 0 && end <= first) return;
      const su = this.scatterUniforms;
      su["u_width"] = slotWidth;
      su["u_sub"] = table;
      su["u_atlas"] = t.atlas;
      su["u_first"] = first;
      this.countModel.setBindings({ u_key: this.key, u_binned: this.binned, u_prev: tex(1), u_cellCount: counts });
      this.countModel.setVertexCount(Math.max(0, end - first));
      this.draw(this.countModel, band === 0 ? { framebuffer: t.countFbo, clear: [0, 0, 0, 0] } : { framebuffer: t.countFbo, clear: false });
      return;
    }
    const framebuffer = t.roundFbos[round % textures];
    if (!framebuffer) throw new Error("CollisionGrid: missing round framebuffer");
    // Each texture's first round opens it with the empty clear (its first band); later rounds keep it.
    const clears = round < textures && band === 0;
    if (!clears && end <= first) return;
    const ru = this.roundUniforms;
    ru["u_width"] = slotWidth;
    ru["u_sub"] = table;
    ru["u_atlas"] = t.atlas;
    ru["u_first"] = first;
    ru["u_round"] = round;
    ru["u_channel"] = Math.floor(round / textures);
    ru["u_prevChannel"] = Math.floor((round - 1) / textures);
    // Round r reads round r − 1 from another texture (round 0 reads nothing it uses).
    this.roundModel.setBindings({ u_key: this.key, u_binned: this.binned, u_prev: tex(round + textures - 1), u_cellCount: counts });
    this.roundModel.setVertexCount(Math.max(0, end - first));
    this.draw(this.roundModel, clears ? { framebuffer, clear: [EMPTY, EMPTY, EMPTY, EMPTY] } : { framebuffer, clear: false });
  }

  /**
   * Encode the second half: the work items, then every slot's resolve into `target` (the other position
   * texture). Every band of either reads the same prepared state and writes only its own items or rows, so
   * the result does not depend on how they are cut.
   */
  gather(target: Framebuffer, input: CollisionInputs): void {
    this.items(input);
    this.resolve(target, input);
  }

  /**
   * The work items of band `band` of `bands` — the item atlas rows holding about `1 / bands` of their
   * estimated work, each item summing its part of its slot's pushes into its partial.
   */
  items(input: CollisionInputs, band = 0, bands = 1): void {
    const rows = this.itemWorkBefore.length - 1;
    const i0 = Math.min(this.itemCount, workCut(this.itemWorkBefore, rows, band, bands) * this.itemWidth);
    const i1 = Math.min(this.itemCount, workCut(this.itemWorkBefore, rows, band + 1, bands) * this.itemWidth);
    this.encodeItems(this.itemModel, this.partialFbo, input, i0, i1);
  }

  /**
   * The resolve of the slot atlas rows of band `band` of `bands` — rows holding about `1 / bands` of the
   * resolve's estimated work — into `target`: each slot's position plus RELAX of its pushes, after every
   * band of {@link items}.
   */
  resolve(target: Framebuffer, input: CollisionInputs, band = 0, bands = 1): void {
    const r0 = workCut(this.resolveWorkBefore, this.slotHeight, band, bands);
    const r1 = workCut(this.resolveWorkBefore, this.slotHeight, band + 1, bands);
    this.encodeResolve(this.resolveModel, target, this.partial, input, r0, r1, bands > 1);
  }

  /**
   * Tests only (a grid built with `stats`): run the search over the prepared state and return per slot
   * `(cells visited, pairs tested, grid partners pushed, 1 exact slot / 2 overflow)` — summed over its work
   * items — 4 floats per slot atlas texel. Reads nothing the solve wrote since {@link prepare}.
   */
  gatherStats(input: CollisionInputs): Float32Array {
    const stats = this.stats;
    if (!stats) throw new Error("CollisionGrid: built without stats");
    this.encodeItems(stats.itemModel, stats.itemsFbo, input, 0, this.itemCount);
    this.encodeResolve(stats.resolveModel, stats.slotsFbo, stats.items, input, 0, input.rows, false);
    const pixels = this.device.readPixelsToArrayWebGL(stats.slotsFbo, { sourceWidth: stats.slots.width, sourceHeight: stats.slots.height });
    if (!(pixels instanceof Float32Array)) throw new Error("CollisionGrid: expected a float readback");
    return pixels.subarray(0, 4 * input.count);
  }

  /** The item pass over the items `[i0, i1)` (a scissor over their atlas rows; the others there are discarded). */
  private encodeItems(itemModel: Model, itemTarget: Framebuffer, input: CollisionInputs, i0: number, i1: number): void {
    if (i1 <= i0) return;
    const su = this.searchUniforms;
    su["u_count"] = input.count;
    su["u_width"] = input.width;
    su["u_tableWidth"] = input.segments.width;
    su["u_collideWidth"] = input.collideWidth;
    su["u_pad"] = input.pad;
    su["u_itemBegin"] = i0;
    su["u_itemEnd"] = i1;
    const bindings = this.searchBindings;
    bindings["u_slotCollide"] = input.slotCollide;
    bindings["u_segNested"] = input.segNested;
    bindings["u_segCollide"] = input.segCollide;
    bindings["u_segInfo"] = input.segments.info;
    bindings["u_slotSeg"] = input.slotSeg;
    itemModel.setBindings(bindings);
    const y0 = Math.floor(i0 / this.itemWidth);
    const y1 = Math.ceil(i1 / this.itemWidth);
    this.draw(itemModel, { framebuffer: itemTarget, clear: false, scissor: [0, y0, this.itemWidth, y1 - y0] });
  }

  /** The resolve of slot atlas rows `[r0, r1)` into `target` (a scissor when `scissored`). */
  private encodeResolve(
    resolveModel: Model,
    target: Framebuffer,
    partial: Texture,
    input: CollisionInputs,
    r0: number,
    r1: number,
    scissored: boolean,
  ): void {
    if (r1 <= r0) return;
    const su = this.searchUniforms;
    su["u_count"] = input.count;
    su["u_width"] = input.width;
    su["u_tableWidth"] = input.segments.width; // the exact loop's segment lookup
    su["u_collideWidth"] = input.collideWidth;
    su["u_pad"] = input.pad;
    const bindings = this.resolveBindings;
    bindings["u_slotCollide"] = input.slotCollide;
    bindings["u_segInfo"] = input.segments.info;
    bindings["u_slotSeg"] = input.slotSeg;
    bindings["u_partial"] = partial;
    resolveModel.setBindings(bindings);
    this.draw(resolveModel, scissored ? { framebuffer: target, clear: false, scissor: [0, r0, input.width, r1 - r0] } : { framebuffer: target, clear: false });
  }

  /** One whole collision step, `input.pos` → `target`: {@link prepare}, then an unsliced {@link gather}. */
  step(target: Framebuffer, input: CollisionPrepareInput): void {
    this.prepare(input);
    this.gather(target, input);
  }

  private draw(model: Model, target: Parameters<typeof beginPass>[1]): void {
    const pass: RenderPass = beginPass(this.device, target);
    model.draw(pass);
    pass.end();
  }

  destroy(): void {
    for (let i = this.owned.length - 1; i >= 0; i--) this.owned[i]?.destroy();
  }
}

/** The two hash tables of a collision step, in the order they are scattered: the class cells, then the sub-cells. */
const TABLES: readonly (0 | 1)[] = [0, 1];

