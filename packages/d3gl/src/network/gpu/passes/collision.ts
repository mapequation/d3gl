import type { Device, Framebuffer, RenderPass, RenderPipelineParameters, SamplerProps, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL, atlasWidth } from "../textures.js";
import { SEGMENT_OF_GLSL, segmentDefines, type SegmentTable } from "../segment-table.js";
import { COLLISION_GLSL, COLLISION_LIST_MAX } from "../collision-plan.js";
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
// a segment lists and which slots take the exact loop):
//
// - a segment of at most EXACT_MAX (32) children, and an exact slot, tests all its siblings;
// - otherwise a slot tests its segment's list, then visits, for every binned class of its segment, the
//   class cells its disc padded by that class's largest radius overlaps — where every touching partner of
//   that class is.
//
// Each collision step bins every slot's position once, in the cell pass: its finest-class cell F and its
// class cell's hash bucket, into `key`, so no two shaders ever round a cell differently. A bucket's
// occupants are enumerated without atomics by K rounds of MIN-blend point scatters over the binned slots
// (a static list): round r writes into each bucket the smallest slot id above the one round r − 1 wrote
// there, so after K rounds a bucket lists its K smallest occupants in order, next to an ADD-blend count.
// The gather keeps a touching occupant only when its class and cell are the visited ones (buckets are
// shared by hash collisions; a touching occupant from another cell is counted at its own). A slot that
// visits a bucket with more than K occupants falls back to the exact loop over its segment — complete
// either way, and each side of a pair finds it once, so the pushes stay symmetric.
//
// Round storage: K / 4 rgba32float textures, round r in texture r % (K / 4), channel r / (K / 4). A round
// writes EMPTY to its other channels, which MIN leaves unchanged, and reads round r − 1 from another
// texture — never the one it renders into. Cleared to EMPTY and the counts to 0 each step.

/** Rounds of occupant enumeration K (a multiple of 4, at least 8): buckets with more occupants fall back to the exact loop. */
export const COLLISION_ROUNDS = 16;
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
uniform int u_bucketShift;           // log2 of the bucket atlas width (a power of two)
ivec2 bucketTexel(uint b) { return ivec2(int(b & ((1u << u_bucketShift) - 1u)), int(b >> u_bucketShift)); }
`;

/**
 * Cell pass: each slot's key `(F.x | F.y << 16, bucket | class << 28)` — its finest-class cell and its
 * class cell's bucket, or NO_CELL when it is not binned — and, by MRT, its disc `(x, y, radius, 0)` in one
 * texel, so every pair test of the gather is one fetch.
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
uniform highp sampler2D u_segNested;    // (finest cell side, owner slot, 0, 0)
uniform highp usampler2D u_slotCollide; // class | EXACT per slot
uniform highp usampler2D u_segCollide;  // per segment: list 0-3, list 4-7, (bucket base, bucket mask, classes, 0)
uniform int u_count;
uniform int u_width;
uniform int u_collideWidth;
layout(location = 0) out uvec2 o_key;
layout(location = 1) out vec4 o_disc;
${SLOT_TEXEL_GLSL}
${SEGMENT_OF_GLSL}
${COLLISION_GLSL}
${COMMON_GLSL}
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  if (texelSlot(fc, u_width) >= u_count) { o_key = uvec2(0u, NO_CELL); o_disc = vec4(0.0); return; }
  vec2 p = texelFetch(u_pos, fc, 0).xy;
  float r = texelFetch(u_rad, fc, 0).r;
  o_disc = vec4(p, r, 0.0);
  int seg = int(texelFetch(u_slotSeg, fc, 0).r);
  ivec2 st = slotTexel(seg, u_tableWidth);
  uvec4 grid = texelFetch(u_segCollide, slotTexel(3 * seg + 2, u_collideWidth), 0);
  if (grid.z == 0u) { o_key = uvec2(0u, NO_CELL); return; } // no grid: every slot takes the exact loop
  vec2 q = (p + texelFetch(u_segBox, st, 0).zw) / texelFetch(u_segNested, st, 0).x;
  ivec2 f = ivec2(clamp(floor(q), vec2(0.0), vec2(float(F_MAX))));
  uint packedF = uint(f.x) | (uint(f.y) << 16);
  int c = int(texelFetch(u_slotCollide, fc, 0).r & 15u);
  int classes = int(grid.z & 31u);
  if (c < int((grid.z >> 5) & 31u)) { o_key = uvec2(packedF, NO_CELL); return; } // listed
  int d = classes - 1 - c;
  uint bucket = grid.x + (cellHash(c, f.x >> d, f.y >> d) & grid.y);
  o_key = uvec2(packedF, bucket | (uint(c) << 28));
}
`;

/**
 * Scatter vertex shader shared by the count pass and the rounds: binned slot `gl_VertexID` → a point on
 * its bucket. A round skips a slot whose id is not above the id round r − 1 left in its bucket.
 */
const SCATTER_VS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform highp usampler2D u_key;
uniform highp usampler2D u_binned;   // the binned slots, one per point
uniform highp sampler2D u_prev;      // round r − 1 (rounds only)
uniform int u_width;
uniform int u_binnedWidth;
uniform vec2 u_atlas;                // bucket atlas size
uniform int u_round;                 // −1: the count pass; r ≥ 0: round r
uniform int u_prevChannel;           // round r − 1's channel in u_prev
flat out float v_id;
${SLOT_TEXEL_GLSL}
${COMMON_GLSL}
void main() {
  gl_PointSize = 1.0;
  int slot = int(texelFetch(u_binned, slotTexel(gl_VertexID, u_binnedWidth), 0).r);
  uint b = texelFetch(u_key, slotTexel(slot, u_width), 0).y;
  v_id = float(slot);
  ivec2 t = bucketTexel(b & ${BUCKET_LIMIT}u);
  if (u_round > 0) {
    vec4 p = texelFetch(u_prev, t, 0);
    float prev = u_prevChannel == 0 ? p.x : u_prevChannel == 1 ? p.y : u_prevChannel == 2 ? p.z : p.w;
    if (v_id <= prev) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  }
  gl_Position = vec4((vec2(t) + 0.5) / u_atlas * 2.0 - 1.0, 0.0, 1.0);
}
`;

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
 * Gather pass: every slot's Jacobi collision step, into the other position texture — or, with
 * `COLLISION_STATS`, what the step did for each slot: `(cells visited, pairs tested, grid partners
 * pushed, 1 exact slot / 2 overflow)` (pairs tested: list entries, bucket occupants read, and an exact
 * loop's k − 1), for tests.
 */
function gatherFs(rounds: number, refine: number, stats: boolean): string {
  const textures = rounds / 4;
  const roundUniforms = Array.from({ length: textures }, (_, t) => `uniform highp sampler2D u_round${t};`).join("\n");
  const roundFetch = Array.from({ length: textures }, (_, t) => `    rt[${t}] = texelFetch(u_round${t}, bt, 0);`).join("\n");
  return /* glsl */ `\
#version 300 es
${segmentDefines(false)}
${stats ? "#define COLLISION_STATS" : ""}
#define ROUNDS ${rounds}
#define ROUND_TEXTURES ${textures}
#define REFINE ${refine}
precision highp float;
precision highp int;
precision highp usampler2D;
uniform highp sampler2D u_disc;         // (x, y, radius, 0) per slot, from the cell pass
uniform highp usampler2D u_key;         // per slot, from the cell pass
uniform highp usampler2D u_slotCollide;
uniform highp sampler2D u_segNested;
uniform highp usampler2D u_segCollide;
uniform highp usampler2D u_segInfo;
uniform highp sampler2D u_cellCount;
${roundUniforms}
uniform int u_count;
uniform int u_width;
uniform int u_collideWidth;
uniform float u_pad;
uniform float u_relax;
#ifdef COLLISION_STATS
layout(location = 0) out vec4 o_stats;
#else
layout(location = 0) out vec2 o_pos;
#endif
${SLOT_TEXEL_GLSL}
${SEGMENT_OF_GLSL}
${COLLISION_GLSL}
${COMMON_GLSL}

// The collision push on slot i (at xi, radius ri) from slot j at (xj, rj) — nested-layout.ts
// collide().resolve as seen from either side: away from j by the overlap (min − d), times j's mass share
// m_j / (m_i + m_j). A coincident pair separates by exactly min along (cos(a + b), sin(a + b)), a and b
// their local indices, from the lower slot to the higher (#357). Zero unless the two touch.
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

uint channel(uvec4 v, int c) { return c == 0 ? v.x : c == 1 ? v.y : c == 2 ? v.z : v.w; }
float channel(vec4 v, int c) { return c == 0 ? v.x : c == 1 ? v.y : c == 2 ? v.z : v.w; }

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int id = texelSlot(fc, u_width);
#ifdef COLLISION_STATS
  if (id >= u_count) { o_stats = vec4(0.0); return; }
  vec4 stat = vec4(0.0);
#else
  if (id >= u_count) { o_pos = vec2(0.0); return; }
#endif
  int seg = int(texelFetch(u_slotSeg, fc, 0).r);
  ivec2 st = slotTexel(seg, u_tableWidth);
  uvec4 info = texelFetch(u_segInfo, st, 0);
  int start = int(info.x);
  int end = start + int(info.y);
  vec3 di = texelFetch(u_disc, fc, 0).xyz;
  vec2 xi = di.xy;
  float ri = di.z;
  uint code = texelFetch(u_slotCollide, fc, 0).r;
  vec2 acc = vec2(0.0);
  bool exact = (code & COLLIDE_EXACT) != 0u;
#ifdef COLLISION_STATS
  if (exact) stat.w = 1.0;
#endif
  if (!exact) {
    // The list: the segment's coarsest classes, tested directly.
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
    uvec4 grid = texelFetch(u_segCollide, slotTexel(3 * seg + 2, u_collideWidth), 0);
    uint fp = texelFetch(u_key, fc, 0).x;
    ivec2 f = ivec2(int(fp & 65535u), int(fp >> 16));
    int ci = int(code & 15u);
    int classes = int(grid.z & 31u);
    float padOverSide = u_pad / texelFetch(u_segNested, st, 0).x;
    vec4 rt[ROUND_TEXTURES];
    for (int c = int((grid.z >> 5) & 31u); c < classes && !exact; c++) {
      if (((grid.z >> (16 + c)) & 1u) == 0u) continue;
      // The class cells this disc, padded by the class's largest radius, overlaps.
      int d = classes - 1 - c;
      float h = searchReach(ri, padOverSide, d + REFINE);
      ivec2 lo = max(f - int(ceil(h)), ivec2(0)) >> d;
      ivec2 hi = min(f + 1 + int(floor(h)), ivec2(F_MAX)) >> d;
      for (int cy = lo.y; cy <= hi.y && !exact; cy++) {
        for (int cx = lo.x; cx <= hi.x; cx++) {
          ivec2 bt = bucketTexel(grid.x + (cellHash(c, cx, cy) & grid.y));
          int n = int(texelFetch(u_cellCount, bt, 0).x);
#ifdef COLLISION_STATS
          stat.x += 1.0;
#endif
          if (n == 0) continue;
          if (n > ROUNDS) { exact = true; break; }
${roundFetch}
          for (int r = 0; r < ROUNDS; r++) {
            if (r >= n) break;
            int j = int(channel(rt[r % ROUND_TEXTURES], r / ROUND_TEXTURES));
            if (j == id) continue;
#ifdef COLLISION_STATS
            stat.y += 1.0;
#endif
            vec2 pj = pushFrom(id, xi, ri, j, texelFetch(u_disc, slotTexel(j, u_width), 0).xyz, start);
            if (pj == vec2(0.0)) continue;
            // Touching: count it here only if this is its own cell (another visited cell may share the bucket).
            uvec2 kj = texelFetch(u_key, slotTexel(j, u_width), 0).xy;
            if (int(kj.y >> 28) != c || int(kj.x & 65535u) >> d != cx || int(kj.x >> 16) >> d != cy) continue;
            acc += pj;
#ifdef COLLISION_STATS
            stat.z += 1.0;
#endif
          }
        }
      }
    }
#ifdef COLLISION_STATS
    if (exact) stat.w = 2.0;
#endif
  }
  if (exact) {
    acc = vec2(0.0);
    for (int j = start; j < end; j++) {
      if (j != id) acc += push(id, xi, ri, j, start);
    }
#ifdef COLLISION_STATS
    stat.y += float(end - start - 1);
#endif
  }
#ifdef COLLISION_STATS
  o_stats = stat;
#else
  o_pos = xi + u_relax * acc;
#endif
}
`;
}

/** The static per-slot and per-segment textures of the plan, and the segment table's per-step state. */
export interface CollisionInputs {
  slotSeg: Texture;
  /** The segment table: info, and this step's box (reduced over the positions). */
  segments: SegmentTable;
  /** Per segment `(finest cell side, owner slot, 0, 0)`, the segment table's atlas. */
  segNested: Texture;
  /** Per slot its class and exact bit (`r32uint`, the slot atlas). */
  slotCollide: Texture;
  /** Per segment 3 `rgba32uint` texels: its list (2), then (bucket base, buckets, classes, 0). */
  segCollide: Texture;
  /** Atlas width of {@link segCollide}. */
  collideWidth: number;
  count: number;
  width: number;
  pad: number;
}

/** What {@link CollisionGrid.prepare} reads besides {@link CollisionInputs}. */
export interface CollisionPrepareInput extends CollisionInputs {
  /** Current positions. */
  pos: Texture;
  radius: Texture;
}

/** What {@link CollisionGrid.gather} reads besides {@link CollisionInputs} and the prepared state. */
export interface CollisionGatherInput extends CollisionInputs {
  /** Rows of the slot atlas (the bands' domain). */
  rows: number;
}

/** Options of a {@link CollisionGrid}. */
export interface CollisionGridOptions {
  /** The plan's cell refinement ρ (`CollisionPlan.refine`). */
  refine: number;
  /** Occupant rounds K. Default {@link COLLISION_ROUNDS}. */
  rounds?: number;
  /** Build the per-slot statistics pass ({@link CollisionGrid.gatherStats}) — tests only. */
  stats?: boolean;
}

/**
 * The collision grid's textures and passes, created once for a slot atlas and a bucket count. A Jacobi
 * collision step is {@link prepare} (the cell pass, the count scatter, K round scatters) then
 * {@link gather}, which may be cut into row bands — each its own submitted render pass; nothing is
 * allocated.
 *
 * Memory: the key 8 B and the disc 16 B per slot atlas texel; 4 B per binned slot (the scatters' list);
 * the count 4 B and K / 4 round textures of 16 B each per bucket (68 B per bucket at K = 16, and 1.5-3
 * buckets per binned slot).
 */
export class CollisionGrid {
  private readonly device: Device;
  private readonly key: Texture;
  /** `(x, y, radius, 0)` per slot, written with the keys: the gather's one fetch per pair. */
  private readonly disc: Texture;
  private readonly keyFbo: Framebuffer;
  private readonly cellCount: Texture;
  private readonly cellCountFbo: Framebuffer;
  private readonly rounds: readonly Texture[];
  private readonly roundFbos: readonly Framebuffer[];
  private readonly cellModel: Model;
  private readonly countModel: Model;
  private readonly roundModel: Model;
  private readonly gatherModel: Model;
  private readonly cellUniforms: PassUniforms;
  private readonly scatterUniforms: PassUniforms;
  private readonly roundUniforms: PassUniforms;
  private readonly gatherUniforms: PassUniforms;
  private readonly stats: { readonly texture: Texture; readonly framebuffer: Framebuffer; readonly model: Model } | null;
  /** The binned slots (the scatters' points) and their atlas width. */
  private readonly binned: Texture;
  private readonly binnedCount: number;
  /** Occupant rounds K. */
  readonly roundCount: number;

  constructor(device: Device, slotWidth: number, slotHeight: number, buckets: number, binnedSlots: Uint32Array, options: CollisionGridOptions) {
    const rounds = options.rounds ?? COLLISION_ROUNDS;
    if (rounds < 8 || rounds % 4 !== 0) throw new Error(`CollisionGrid: ${rounds} rounds; a multiple of 4, at least 8`);
    if (buckets > BUCKET_LIMIT) throw new Error(`CollisionGrid: ${buckets} buckets, beyond ${BUCKET_LIMIT}`);
    this.device = device;
    this.roundCount = rounds;
    // The bucket atlas: a power-of-two width, so a bucket's texel is a mask and a shift.
    let shift = 0;
    while (1 << (2 * shift) < buckets) shift++;
    const w = 1 << shift;
    const h = Math.max(1, Math.ceil(buckets / w));
    this.binnedCount = binnedSlots.length;
    const bw = atlasWidth(Math.max(1, binnedSlots.length));
    const binnedData = new Uint32Array(bw * Math.max(1, Math.ceil(binnedSlots.length / bw)));
    binnedData.set(binnedSlots);
    const own: { destroy(): void }[] = [];
    const keep = <T extends { destroy(): void }>(r: T): T => {
      own.push(r);
      return r;
    };
    try {
      this.binned = keep(device.createTexture({ width: bw, height: binnedData.length / bw, format: "r32uint", data: binnedData, mipLevels: 1, sampler: NEAREST }));
      this.key = keep(device.createTexture({ width: slotWidth, height: slotHeight, format: "rg32uint", mipLevels: 1, sampler: NEAREST }));
      this.disc = keep(device.createTexture({ width: slotWidth, height: slotHeight, format: "rgba32float", mipLevels: 1, sampler: NEAREST }));
      this.keyFbo = keep(device.createFramebuffer({ width: slotWidth, height: slotHeight, colorAttachments: [this.key, this.disc] }));
      this.cellCount = keep(device.createTexture({ width: w, height: h, format: "r32float", mipLevels: 1, sampler: NEAREST }));
      this.cellCountFbo = keep(device.createFramebuffer({ width: w, height: h, colorAttachments: [this.cellCount] }));
      const textures: Texture[] = [];
      const fbos: Framebuffer[] = [];
      for (let t = 0; t < rounds / 4; t++) {
        const tex = keep(device.createTexture({ width: w, height: h, format: "rgba32float", mipLevels: 1, sampler: NEAREST }));
        textures.push(tex);
        fbos.push(keep(device.createFramebuffer({ width: w, height: h, colorAttachments: [tex] })));
      }
      this.rounds = textures;
      this.roundFbos = fbos;
      this.cellUniforms = { u_count: 0, u_width: 1, u_tableWidth: 1, u_collideWidth: 1, u_bucketShift: shift };
      this.cellModel = keep(fullScreenModel(device, CELL_FS, this.cellUniforms, NO_BLEND));
      const scatterBase = { u_width: 1, u_binnedWidth: bw, u_bucketShift: shift, u_atlas: new Float32Array([w, h]), u_prevChannel: 0 };
      this.scatterUniforms = { ...scatterBase, u_round: -1 };
      this.roundUniforms = { ...scatterBase, u_round: 0, u_channel: 0 };
      const scatter = (fs: string, uniforms: PassUniforms, parameters: RenderPipelineParameters): Model =>
        keep(new Model(device, { vs: SCATTER_VS, fs, topology: "point-list", vertexCount: Math.max(1, binnedSlots.length), uniforms, parameters }));
      this.countModel = scatter(COUNT_FS, this.scatterUniforms, ADDITIVE_BLEND);
      this.roundModel = scatter(ROUND_FS, this.roundUniforms, MIN_BLEND);
      this.gatherUniforms = { u_count: 0, u_width: 1, u_tableWidth: 1, u_collideWidth: 1, u_bucketShift: shift, u_pad: 1, u_relax: COLLISION_RELAX };
      this.gatherModel = keep(fullScreenModel(device, gatherFs(rounds, options.refine, false), this.gatherUniforms, NO_BLEND));
      if (options.stats) {
        const texture = keep(device.createTexture({ width: slotWidth, height: slotHeight, format: "rgba32float", mipLevels: 1, sampler: NEAREST }));
        const framebuffer = keep(device.createFramebuffer({ width: slotWidth, height: slotHeight, colorAttachments: [texture] }));
        const model = keep(fullScreenModel(device, gatherFs(rounds, options.refine, true), this.gatherUniforms, NO_BLEND));
        this.stats = { texture, framebuffer, model };
      } else {
        this.stats = null;
      }
    } catch (error) {
      for (let i = own.length - 1; i >= 0; i--) own[i]?.destroy();
      throw error;
    }
    this.owned = own;
  }

  /** Everything this grid created, in creation order ({@link destroy} frees it in reverse). */
  private readonly owned: readonly { destroy(): void }[];

  /**
   * Encode the first half of a collision step: every slot's key and disc (from `input.pos` and this
   * step's box), the occupancy counts and the K rounds. Then {@link gather}.
   */
  prepare(input: CollisionPrepareInput): void {
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
    this.draw(this.cellModel, { framebuffer: this.keyFbo, clear: false });

    // Occupancy: the counts, then the rounds, over the binned slots (none: nothing to bin).
    if (this.binnedCount === 0) return;
    const textures = this.rounds.length;
    const round = (r: number): Texture => this.rounds[r % textures] ?? this.cellCount;
    this.scatterUniforms["u_width"] = input.width;
    this.countModel.setBindings({ u_key: this.key, u_binned: this.binned, u_prev: round(1) });
    this.draw(this.countModel, { framebuffer: this.cellCountFbo, clear: [0, 0, 0, 0] });
    const ru = this.roundUniforms;
    ru["u_width"] = input.width;
    for (let r = 0; r < this.roundCount; r++) {
      ru["u_round"] = r;
      ru["u_channel"] = Math.floor(r / textures);
      ru["u_prevChannel"] = Math.floor((r - 1) / textures);
      // Round r reads round r − 1 from another texture (round 0 reads nothing it uses).
      this.roundModel.setBindings({ u_key: this.key, u_binned: this.binned, u_prev: round(r + textures - 1) });
      const framebuffer = this.roundFbos[r % textures];
      if (!framebuffer) throw new Error("CollisionGrid: missing round framebuffer");
      // Each texture's first round opens it with the empty clear; later rounds keep it.
      this.draw(this.roundModel, r < textures ? { framebuffer, clear: [EMPTY, EMPTY, EMPTY, EMPTY] } : { framebuffer, clear: false });
    }
  }

  /**
   * Encode the second half: the gather — each slot's Jacobi step, from the discs {@link prepare} wrote,
   * into `target` (the other position texture) — over the slot atlas rows of band `band` of `bands` (a
   * scissor; every band reads the same prepared state, so the result does not depend on the slicing).
   */
  gather(target: Framebuffer, input: CollisionGatherInput, band = 0, bands = 1): void {
    const r0 = Math.floor((band * input.rows) / bands);
    const r1 = Math.floor(((band + 1) * input.rows) / bands);
    if (r1 <= r0) return;
    this.bindGather(this.gatherModel, input);
    this.draw(this.gatherModel, bands > 1 ? { framebuffer: target, clear: false, scissor: [0, r0, input.width, r1 - r0] } : { framebuffer: target, clear: false });
  }

  /**
   * Tests only (a grid built with `stats`): run the gather's search over the prepared state and return,
   * per slot, `(cells visited, pairs tested, grid partners pushed, 1 exact slot / 2 overflow)` (4 floats
   * per slot atlas texel, row-major). Reads nothing the solve wrote since {@link prepare}.
   */
  gatherStats(input: CollisionGatherInput): Float32Array {
    if (!this.stats) throw new Error("CollisionGrid: built without stats");
    this.bindGather(this.stats.model, input);
    this.draw(this.stats.model, { framebuffer: this.stats.framebuffer, clear: false });
    const pixels = this.device.readPixelsToArrayWebGL(this.stats.framebuffer, { sourceWidth: this.stats.texture.width, sourceHeight: this.stats.texture.height });
    if (!(pixels instanceof Float32Array)) throw new Error("CollisionGrid: expected a float readback");
    return pixels;
  }

  private bindGather(model: Model, input: CollisionGatherInput): void {
    const gu = this.gatherUniforms;
    gu["u_count"] = input.count;
    gu["u_width"] = input.width;
    gu["u_tableWidth"] = input.segments.width;
    gu["u_collideWidth"] = input.collideWidth;
    gu["u_pad"] = input.pad;
    const bindings: Record<string, Texture> = {
      u_disc: this.disc,
      u_key: this.key,
      u_slotCollide: input.slotCollide,
      u_segNested: input.segNested,
      u_segCollide: input.segCollide,
      u_segInfo: input.segments.info,
      u_cellCount: this.cellCount,
      u_slotSeg: input.slotSeg,
    };
    this.rounds.forEach((t, i) => {
      bindings[`u_round${i}`] = t;
    });
    model.setBindings(bindings);
  }

  /** One whole collision step, `input.pos` → `target`: {@link prepare}, then an unsliced {@link gather}. */
  step(target: Framebuffer, input: CollisionPrepareInput & CollisionGatherInput): void {
    this.prepare(input);
    this.gather(target, input);
  }

  private draw(model: Model, target: Parameters<typeof beginPass>[1]): void {
    const pass: RenderPass = beginPass(this.device, target);
    model.draw(pass);
    pass.end();
    this.device.submit();
  }

  destroy(): void {
    for (let i = this.owned.length - 1; i >= 0; i--) this.owned[i]?.destroy();
  }
}
