import type { Device, Framebuffer, RenderPass, RenderPipelineParameters, SamplerProps, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { SLOT_TEXEL_GLSL } from "../textures.js";
import { SEGMENT_OF_GLSL, segmentDefines, type SegmentTable } from "../segment-table.js";
import { bandRows, bandSlots } from "../segments.js";
import { ADDITIVE_BLEND, beginPass, fullScreenModel, NO_BLEND, type PassTarget, type PassUniforms } from "./fullscreen.js";

// ─────────────────────────────────────────────────────────────────────────────
// The nested layout's disc collision on the GPU (#355, spec §11.1): a per-segment K-occupant grid that
// finds every touching pair, plus the exact loop for small segments.
// ─────────────────────────────────────────────────────────────────────────────
//
// The CPU (`collide()` in nested-layout.ts) pushes each overlapping sibling pair apart, one pair after
// another. Here every slot gathers the pushes of all its overlapping siblings from the same positions
// (Jacobi) and moves by RELAX (0.5) of their sum — a pair's two pushes are equal and opposite in mass
// (m = radius²), so each segment's mass-weighted centre stays put.
//
// Which pairs a slot tests:
//
// - a segment of at most EXACT_MAX (32) children — every exact segment — tests all its siblings;
// - a larger segment (it owns a pyramid tile) bins its slots into a grid over its box. The grid's
//   cells are at least 2 · r₉ · PAD wide, r₉ the segment's 9th-largest radius, so two discs no larger
//   than r₉ that touch are at most one cell apart: a slot finds them in its 3×3 cells. The at most 8
//   larger ("large") slots are not binned: every slot tests them exactly, and each tests the whole
//   segment. So the grid is complete by construction.
//
// A cell's occupants are enumerated without atomics by K rounds of MIN-blend point scatters: round r
// writes into each cell the smallest slot id above the one round r − 1 wrote there, so after K rounds a
// cell lists its K smallest occupants in order. A count scatter (ADD) says how many there are. A slot
// whose 3×3 cells hold a cell with more than K occupants falls back to the exact loop over its segment
// — and so does its partner across that cell, which is in the partner's 3×3 too: a pair is always seen
// from both sides, so the pushes stay symmetric.
//
// The grid of a segment lives in the collision atlas at half its pyramid tile: side G_s / 2 cells at
// the tile origin halved (tiles are aligned to their side, so halved tiles are disjoint and aligned).
// Each slot's cell is computed ONCE per tick, by the cell pass, into `slotCell`; the scatters and the
// gather read it, so no two shaders ever round a cell differently.
//
// Round storage: two rgba32float textures, round r in texture r % 2, channel r >> 1 (K ≤ 8). A round
// writes BIG to its other channels, which MIN leaves unchanged, and reads round r − 1 from the other
// texture — never the one it renders into. Cleared to BIG (empty) and the counts to 0 each tick.

/** Rounds of occupant enumeration: cells with more occupants fall back to the exact loop. */
export const COLLISION_ROUNDS = 8;
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
/** Cell side margin over 2 · r₉ · PAD, so a touching pair one ulp short of a cell apart still counts. */
const CELL_MARGIN = 1 + 1e-4;
/** An empty round texel: above every slot id (ids are exact in float32 below 2²⁴). */
const EMPTY = 1e30;
/** `slotCell` of a slot not in a grid: an exact segment's, or a large slot. */
const NO_CELL = 0xffffffff;

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

/** GLSL shared by the passes: the collision tile of a segment (origin and side, halved from its pyramid tile). */
const TILE_GLSL = /* glsl */ `\
const uint NO_CELL = ${NO_CELL}u;
ivec2 collisionOrigin(uvec4 info) { return ivec2(int(info.z & 65535u), int(info.z >> 16)) >> 1; }
int collisionSide(uvec4 info) { return int(info.w >> 16) >> 1; }
`;

/**
 * Cell pass: each slot's grid cell (packed `x | y << 16` in the collision atlas), or NO_CELL — and, by
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
uniform highp sampler2D u_segBox;    // (maxX, maxY, −minX, −minY) of this tick's positions
uniform highp sampler2D u_segNested; // (r₉, owner slot, 0, 0)
uniform highp usampler2D u_segInfo;
uniform int u_count;
uniform int u_width;
uniform float u_cellScale;           // 2 · PAD · (1 + margin)
layout(location = 0) out uint o_cell;
layout(location = 1) out vec4 o_disc;
${SLOT_TEXEL_GLSL}
${SEGMENT_OF_GLSL}
${TILE_GLSL}
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  if (texelSlot(fc, u_width) >= u_count) { o_cell = NO_CELL; o_disc = vec4(0.0); return; }
  vec2 p = texelFetch(u_pos, fc, 0).xy;
  float r = texelFetch(u_rad, fc, 0).r;
  o_disc = vec4(p, r, 0.0);
  ivec2 st = segmentTexelOf(fc);
  uvec4 info = texelFetch(u_segInfo, st, 0);
  float r9 = texelFetch(u_segNested, st, 0).x;
  if (((info.w >> 8) & SEGMENT_HAS_TILE) == 0u || r > r9) { o_cell = NO_CELL; return; }
  vec4 b = texelFetch(u_segBox, st, 0);
  vec2 mn = -b.zw;
  float side = max(max(b.x - mn.x, b.y - mn.y), 1e-30);
  // Cells at least 2 · r₉ · PAD wide (fewer, larger ones when the tile caps them).
  float n = clamp(floor(side / max(r9 * u_cellScale, 1e-30)), 1.0, float(collisionSide(info)));
  float cellSize = side / n;
  int last = int(n) - 1;
  ivec2 c = clamp(ivec2(floor((p - mn) / cellSize)), ivec2(0), ivec2(last));
  ivec2 cell = collisionOrigin(info) + c;
  o_cell = uint(cell.x) | (uint(cell.y) << 16);
}
`;

/**
 * Scatter vertex shader shared by the count pass and the rounds: slot `gl_VertexID` → a point on its
 * cell, or outside the clip volume when it has none. A round also skips a slot whose id is not above the
 * id round r − 1 left in its cell.
 */
const SCATTER_VS = /* glsl */ `\
#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform highp usampler2D u_slotCell;
uniform highp sampler2D u_prev;      // round r − 1 (rounds only)
uniform int u_width;
uniform int u_first;                 // the first slot of this draw (a band of slots, #382)
uniform vec2 u_atlas;                // collision atlas size
uniform int u_round;                 // −1: the count pass; r ≥ 0: round r
flat out float v_id;
${SLOT_TEXEL_GLSL}
${TILE_GLSL}
void main() {
  gl_PointSize = 1.0;
  int slot = u_first + gl_VertexID;
  uint c = texelFetch(u_slotCell, slotTexel(slot, u_width), 0).r;
  v_id = float(slot);
  if (c == NO_CELL) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  ivec2 cell = ivec2(int(c & 65535u), int(c >> 16));
  if (u_round > 0) {
    vec4 p = texelFetch(u_prev, cell, 0);
    int ch = (u_round - 1) >> 1;
    float prev = ch == 0 ? p.x : ch == 1 ? p.y : ch == 2 ? p.z : p.w;
    if (v_id <= prev) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  }
  gl_Position = vec4((vec2(cell) + 0.5) / u_atlas * 2.0 - 1.0, 0.0, 1.0);
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
uniform int u_channel;               // round r → channel r >> 1 of texture r % 2
layout(location = 0) out vec4 o_round;
void main() {
  vec4 o = vec4(${EMPTY.toExponential()});
  if (u_channel == 0) o.x = v_id; else if (u_channel == 1) o.y = v_id; else if (u_channel == 2) o.z = v_id; else o.w = v_id;
  o_round = o;
}
`;

/** Gather pass: every slot's Jacobi collision step, into the other position texture. */
function gatherFs(rounds: number): string {
  return /* glsl */ `\
#version 300 es
${segmentDefines(false)}
#define ROUNDS ${rounds}
precision highp float;
precision highp int;
precision highp usampler2D;
uniform highp sampler2D u_disc;      // (x, y, radius, 0) per slot, from the cell pass
uniform highp sampler2D u_cellCount;
uniform highp sampler2D u_roundA;    // rounds 0, 2, 4, 6 in x, y, z, w
uniform highp sampler2D u_roundB;    // rounds 1, 3, 5, 7
uniform highp usampler2D u_segInfo;
uniform highp usampler2D u_slotCell;
uniform highp usampler2D u_segLarge; // 8 large slots per segment, 2 texels each (NO_CELL pads)
uniform int u_count;
uniform int u_width;
uniform int u_largeWidth;
uniform float u_pad;
uniform float u_relax;
layout(location = 0) out vec2 o_pos;
${SLOT_TEXEL_GLSL}
${SEGMENT_OF_GLSL}
${TILE_GLSL}

// The collision push on slot i (at xi, radius ri) from slot j — nested-layout.ts collide().resolve as
// seen from either side: away from j by the overlap (min − d), times j's mass share m_j / (m_i + m_j). A
// coincident pair separates by exactly min along (cos(a + b), sin(a + b)), a and b their local indices,
// from the lower slot to the higher (#357).
vec2 push(int i, vec2 xi, float ri, int j, int start) {
  vec3 dj = texelFetch(u_disc, slotTexel(j, u_width), 0).xyz;
  vec2 xj = dj.xy;
  float rj = dj.z;
  vec2 d = xi - xj;
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

uint largeSlot(ivec2 st, int q, int tableWidth) {
  int seg = texelSlot(st, tableWidth);
  uvec4 t = texelFetch(u_segLarge, slotTexel(2 * seg + (q >> 2), u_largeWidth), 0);
  int c = q & 3;
  return c == 0 ? t.x : c == 1 ? t.y : c == 2 ? t.z : t.w;
}

float roundId(ivec2 cell, int r) {
  vec4 t = (r & 1) == 0 ? texelFetch(u_roundA, cell, 0) : texelFetch(u_roundB, cell, 0);
  int c = r >> 1;
  return c == 0 ? t.x : c == 1 ? t.y : c == 2 ? t.z : t.w;
}

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int id = texelSlot(fc, u_width);
  if (id >= u_count) { o_pos = vec2(0.0); return; }
  ivec2 st = segmentTexelOf(fc);
  uvec4 info = texelFetch(u_segInfo, st, 0);
  int start = int(info.x);
  int end = start + int(info.y);
  vec3 di = texelFetch(u_disc, fc, 0).xyz;
  vec2 xi = di.xy;
  float ri = di.z;
  uint cellCode = texelFetch(u_slotCell, fc, 0).r;
  vec2 acc = vec2(0.0);

  bool exact = cellCode == NO_CELL; // an exact segment's slot, or a large slot: test the whole segment
  ivec2 cell = ivec2(int(cellCode & 65535u), int(cellCode >> 16));
  ivec2 lo = ivec2(0);
  ivec2 hi = ivec2(0);
  if (!exact) {
    ivec2 origin = collisionOrigin(info);
    int side = collisionSide(info);
    lo = max(cell - 1, origin);
    hi = min(cell + 1, origin + side - 1);
    for (int cy = lo.y; cy <= hi.y && !exact; cy++) {
      for (int cx = lo.x; cx <= hi.x; cx++) {
        if (texelFetch(u_cellCount, ivec2(cx, cy), 0).x > float(ROUNDS)) { exact = true; break; }
      }
    }
  }
  if (exact) {
    for (int j = start; j < end; j++) {
      if (j != id) acc += push(id, xi, ri, j, start);
    }
  } else {
    for (int cy = lo.y; cy <= hi.y; cy++) {
      for (int cx = lo.x; cx <= hi.x; cx++) {
        ivec2 c = ivec2(cx, cy);
        int n = int(texelFetch(u_cellCount, c, 0).x);
        for (int r = 0; r < ROUNDS; r++) {
          if (r >= n) break;
          int j = int(roundId(c, r));
          if (j != id) acc += push(id, xi, ri, j, start);
        }
      }
    }
    for (int q = 0; q < 8; q++) {
      uint j = largeSlot(st, q, u_tableWidth);
      if (j == NO_CELL) break;
      acc += push(id, xi, ri, int(j), start);
    }
  }
  o_pos = xi + u_relax * acc;
}
`;
}

/** What {@link CollisionGrid.prepare} reads. */
export interface CollisionPrepareInput {
  /** Current positions. */
  pos: Texture;
  radius: Texture;
  slotSeg: Texture;
  /** The segment table: info, and this tick's box (reduced over `pos`). */
  segments: SegmentTable;
  /** Per segment `(r₉, owner slot, 0, 0)`, the segment table's atlas. */
  segNested: Texture;
  count: number;
  width: number;
  pad: number;
}

/** What {@link CollisionGrid.gather} reads besides the prepared state. */
export interface CollisionGatherInput {
  slotSeg: Texture;
  segments: SegmentTable;
  /** Per segment its large slots, {@link CollisionGrid}'s `largeWidth` atlas, 2 texels per segment. */
  segLarge: Texture;
  count: number;
  width: number;
  /** Rows of the slot atlas (the bands' domain). */
  rows: number;
  pad: number;
}

/**
 * The collision grid's textures and passes, created once for a slot atlas and a collision atlas
 * (`width × height`, the pyramid tile atlas halved). A Jacobi collision step is {@link prepare} (the cell
 * pass, the count scatter, {@link COLLISION_ROUNDS} round scatters) then {@link gather}. Every one of
 * these passes may be cut into bands of slot-atlas rows (#382) — {@link cells}, {@link count},
 * {@link round}, {@link gather} — each band its own submitted render pass, with the same result for any
 * band count; nothing is allocated.
 *
 * Memory: `slotCell` 4 B and the disc 16 B per slot atlas texel; the count 4 B and the two round textures
 * 16 B each per collision atlas texel (36 B per cell). With no tiled segment the grid is 1×1 and only exact
 * loops run.
 */
export class CollisionGrid {
  private readonly device: Device;
  private readonly slotCell: Texture;
  /** `(x, y, radius, 0)` per slot, written with the cells: the gather's one fetch per pair. */
  private readonly disc: Texture;
  private readonly slotCellFbo: Framebuffer;
  private readonly cellCount: Texture;
  private readonly cellCountFbo: Framebuffer;
  private readonly rounds: readonly [Texture, Texture];
  private readonly roundFbos: readonly [Framebuffer, Framebuffer];
  private readonly cellModel: Model;
  private readonly countModel: Model;
  private readonly roundModel: Model;
  private readonly gatherModel: Model;
  private readonly cellUniforms: PassUniforms;
  private readonly scatterUniforms: PassUniforms;
  private readonly roundUniforms: PassUniforms;
  private readonly gatherUniforms: PassUniforms;
  /** Atlas width of the per-segment large-slot texture (2 texels per segment). */
  readonly largeWidth: number;

  constructor(device: Device, slotWidth: number, slotHeight: number, atlasWidth: number, atlasHeight: number, largeWidth: number) {
    this.device = device;
    this.largeWidth = largeWidth;
    const w = Math.max(1, atlasWidth);
    const h = Math.max(1, atlasHeight);
    this.slotCell = device.createTexture({ width: slotWidth, height: slotHeight, format: "r32uint", mipLevels: 1, sampler: NEAREST });
    this.disc = device.createTexture({ width: slotWidth, height: slotHeight, format: "rgba32float", mipLevels: 1, sampler: NEAREST });
    this.slotCellFbo = device.createFramebuffer({ width: slotWidth, height: slotHeight, colorAttachments: [this.slotCell, this.disc] });
    const cells = (): Texture => device.createTexture({ width: w, height: h, format: "rgba32float", mipLevels: 1, sampler: NEAREST });
    this.cellCount = device.createTexture({ width: w, height: h, format: "r32float", mipLevels: 1, sampler: NEAREST });
    this.cellCountFbo = device.createFramebuffer({ width: w, height: h, colorAttachments: [this.cellCount] });
    this.rounds = [cells(), cells()];
    this.roundFbos = [
      device.createFramebuffer({ width: w, height: h, colorAttachments: [this.rounds[0]] }),
      device.createFramebuffer({ width: w, height: h, colorAttachments: [this.rounds[1]] }),
    ];
    this.cellUniforms = { u_count: 0, u_width: 1, u_tableWidth: 1, u_cellScale: 1 };
    this.cellModel = fullScreenModel(device, CELL_FS, this.cellUniforms, NO_BLEND);
    this.scatterUniforms = { u_width: 1, u_first: 0, u_atlas: new Float32Array([w, h]), u_round: -1 };
    this.roundUniforms = { u_width: 1, u_first: 0, u_atlas: new Float32Array([w, h]), u_round: 0, u_channel: 0 };
    const scatter = (fs: string, uniforms: PassUniforms, parameters: RenderPipelineParameters): Model =>
      new Model(device, { vs: SCATTER_VS, fs, topology: "point-list", vertexCount: 1, uniforms, parameters });
    this.countModel = scatter(COUNT_FS, this.scatterUniforms, ADDITIVE_BLEND);
    this.roundModel = scatter(ROUND_FS, this.roundUniforms, MIN_BLEND);
    this.gatherUniforms = { u_count: 0, u_width: 1, u_tableWidth: 1, u_largeWidth: largeWidth, u_pad: 1, u_relax: COLLISION_RELAX };
    this.gatherModel = fullScreenModel(device, gatherFs(COLLISION_ROUNDS), this.gatherUniforms, NO_BLEND);
  }

  /**
   * Encode the first half of a collision step: every slot's cell and disc (from `input.pos` and this
   * tick's box), the occupancy counts and the {@link COLLISION_ROUNDS} rounds — {@link cells},
   * {@link count} and each {@link round}, unsliced. Then {@link gather}.
   */
  prepare(input: CollisionPrepareInput): void {
    this.cells(input);
    this.count(input);
    for (let r = 0; r < COLLISION_ROUNDS; r++) this.round(r, input);
  }

  /** Every slot's cell (or NO_CELL) and its disc, from this tick's box — over the rows of band `band` of `bands`. */
  cells(input: CollisionPrepareInput, band = 0, bands = 1): void {
    const [r0, r1] = bandRows(band, bands, Math.ceil(input.count / input.width));
    if (r1 <= r0) return;
    const { segments } = input;
    const cu = this.cellUniforms;
    cu["u_count"] = input.count;
    cu["u_width"] = input.width;
    cu["u_tableWidth"] = segments.width;
    cu["u_cellScale"] = 2 * input.pad * CELL_MARGIN;
    this.cellModel.setBindings({
      u_pos: input.pos,
      u_rad: input.radius,
      u_segBox: segments.box,
      u_segNested: input.segNested,
      u_segInfo: segments.info,
      u_slotSeg: input.slotSeg,
    });
    this.draw(this.cellModel, bands > 1 ? { framebuffer: this.slotCellFbo, clear: false, scissor: [0, r0, input.width, r1 - r0] } : { framebuffer: this.slotCellFbo, clear: false });
  }

  /**
   * The occupancy count (ADD) of the slots of band `band` of `bands` — after every band of {@link cells}.
   * Its first band clears the counts. Integer counts add exactly in any order.
   */
  count(input: CollisionPrepareInput, band = 0, bands = 1): void {
    const [first, end] = bandSlots(band, bands, input.width, input.count);
    this.scatterUniforms["u_width"] = input.width;
    this.scatterUniforms["u_first"] = first;
    this.countModel.setBindings({ u_slotCell: this.slotCell, u_prev: this.rounds[1] });
    this.scatter(this.countModel, end - first, band === 0 ? { framebuffer: this.cellCountFbo, clear: [0, 0, 0, 0] } : { framebuffer: this.cellCountFbo, clear: false });
  }

  /**
   * Round `r` (MIN) of the slots of band `band` of `bands` — after every band of round r − 1 (and of
   * {@link cells}). Round r reads round r − 1 from the other texture (round 0 reads nothing it uses); the
   * first band of rounds 0 and 1 opens its texture with the empty clear, later ones keep it. MIN is exact
   * in any order.
   */
  round(r: number, input: CollisionPrepareInput, band = 0, bands = 1): void {
    const [first, end] = bandSlots(band, bands, input.width, input.count);
    const even = (r & 1) === 0;
    const ru = this.roundUniforms;
    ru["u_width"] = input.width;
    ru["u_first"] = first;
    ru["u_round"] = r;
    ru["u_channel"] = r >> 1;
    this.roundModel.setBindings({ u_slotCell: this.slotCell, u_prev: even ? this.rounds[1] : this.rounds[0] });
    const framebuffer = even ? this.roundFbos[0] : this.roundFbos[1];
    this.scatter(this.roundModel, end - first, r < 2 && band === 0 ? { framebuffer, clear: [EMPTY, EMPTY, EMPTY, EMPTY] } : { framebuffer, clear: false });
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
    const gu = this.gatherUniforms;
    gu["u_count"] = input.count;
    gu["u_width"] = input.width;
    gu["u_tableWidth"] = input.segments.width;
    gu["u_pad"] = input.pad;
    this.gatherModel.setBindings({
      u_disc: this.disc,
      u_cellCount: this.cellCount,
      u_roundA: this.rounds[0],
      u_roundB: this.rounds[1],
      u_segInfo: input.segments.info,
      u_slotCell: this.slotCell,
      u_segLarge: input.segLarge,
      u_slotSeg: input.slotSeg,
    });
    this.draw(this.gatherModel, bands > 1 ? { framebuffer: target, clear: false, scissor: [0, r0, input.width, r1 - r0] } : { framebuffer: target, clear: false });
  }

  /** One whole collision step, `input.pos` → `target`: {@link prepare}, then an unsliced {@link gather}. */
  step(target: Framebuffer, input: CollisionPrepareInput & CollisionGatherInput): void {
    this.prepare(input);
    this.gather(target, input);
  }

  private draw(model: Model, target: PassTarget): void {
    const pass: RenderPass = beginPass(this.device, target);
    model.draw(pass);
    pass.end();
    this.device.submit();
  }

  /** A point scatter of `points` slots into `target` (a pass with no draw when there are none: it may carry a clear). */
  private scatter(model: Model, points: number, target: PassTarget): void {
    const pass: RenderPass = beginPass(this.device, target);
    if (points > 0) {
      model.setVertexCount(points);
      model.draw(pass);
    }
    pass.end();
    this.device.submit();
  }

  destroy(): void {
    this.cellModel.destroy();
    this.countModel.destroy();
    this.roundModel.destroy();
    this.gatherModel.destroy();
    this.slotCellFbo.destroy();
    this.slotCell.destroy();
    this.disc.destroy();
    this.cellCountFbo.destroy();
    this.cellCount.destroy();
    this.roundFbos[0].destroy();
    this.roundFbos[1].destroy();
    this.rounds[0].destroy();
    this.rounds[1].destroy();
  }
}
