import type { Device, Framebuffer, SamplerProps, Texture } from "@luma.gl/core";
import type { LayoutGraph } from "../force.js";
import { NESTED, WARM_ALPHA, nestedAlphaDecay } from "../nested-layout.js";
import { atlasWidth, pingPong, type PingPong } from "./textures.js";
import { beginPass, type PassUniforms } from "./passes/fullscreen.js";
import { SegmentedReduce, segmentedReducePrograms, type RangeTarget, type ReduceMap } from "./passes/segmented-reduce.js";
import { GridPyramid, gridPyramidPrograms } from "./passes/grid-pyramid.js";
import { RepulsionPass, repulsionProgram, type RepulsionVariant } from "./passes/repulsion.js";
import { NestedIntegratePass, NestedPredictPass, nestedIntegrateProgram, nestedPredictProgram, type NestedSlotInputs } from "./passes/nested.js";
import { COLLISION_STEPS, CollisionGrid, collisionGridProgramList, collisionGridSide, type CollisionInputs } from "./passes/collision.js";
import { COLLISION_LIST_MAX } from "./collision-plan.js";
import { NestedComposePass, nestedComposeProgram } from "./passes/nested-compose.js";
import { GpuSprings, springPrograms, springVariant } from "./springs.js";
import type { LayoutProgram } from "./programs.js";
import type { NestedSpringInputs } from "./passes/attraction.js";
import { SegmentTable, type SegmentRow } from "./segment-table.js";
import { TILE_MIN_SIDE, assertAtlasFits, packTiles, segmentSoftening, slotSegments, type SlotRange, type TileAtlas } from "./segments.js";
import { NESTED_MAX_SLOTS, gpuNestedSlotNeed, type GpuLayoutNeed } from "./device-caps.js";
import type { PackedPositions } from "./async-readback.js";
import type { StreamSolver } from "./gpu-stream.js";
import { itemCostMs, type ItemCosts, type ItemKind } from "./frame-budget.js";
import type { NestedSolverTopology } from "./nested-topology.js";
import { EXACT_MAX } from "../nested-layout.js";

// ─────────────────────────────────────────────────────────────────────────────
// The batched GPU nested layout (#355, spec §11.1).
// ─────────────────────────────────────────────────────────────────────────────
//
// One segmented solve over every tree node but the root (segment = parent module, `nested-topology.ts`),
// so every module at every depth solves at once: T ticks in all, where the CPU runs T per module, top-down.
// It reuses the segmented solver's primitives — the segment table, the contention-free reductions, the
// tile-atlas grid pyramid with its per-segment traversal and the exact loop, the chunked CSR springs —
// with the nested physics of `nested-layout.ts` (the same constants, {@link NESTED}):
//
// A solve tick is one stream tick (work items P, F_b, I) in the organise phase and one per collision
// step in the compact phase. The heaviest pass, the collision gather, is cut into row bands like the
// repulsion (one unsliced compact tick was 29 ms at 1M):
//
// | stream tick                 | P                                                    | F_b                    | I                  |
// |-----------------------------|------------------------------------------------------|------------------------|--------------------|
// | organise (first 60%)        | reductions (box) → tile pyramid                      | clear force, repulsion, band b | predict v*; springs at x + v* (zero rest); integrate |
// | compact, collision step 1   | predict; springs (rest lengths); integrate; reductions; collision cells, both tables' counts and rounds | collision work items, then resolve, of band b | swap |
// | compact, collision step 2   | reductions; collision cells, both tables' counts and rounds | collision work items, then resolve, of band b | swap; next tick |
//
// Each item submits once, after its render passes (#402), and a force clear is the first draw's `clear`
// (a band's rows, the springs' whole target), never a pass of its own. The compact swap, and a gather band
// without rows, encode nothing.
//
// The composition (`passes/nested-compose.ts`) maps the local solutions into world discs and packs leaf
// positions and module discs in node order, for the streaming readback ({@link prepareReadback}).
//
// The collision gather's cost follows the contacts, not the leaves: a module of heavy-tailed radii can do
// ten times the work per leaf of an even one. So its bands are cut at equal shares of the collision
// plan's per-slot work estimate (`collision-plan.ts`), not at equal rows, and costed by the plan's total,
// so that a band costs what the frame budget expects (#380).
//
// Not every item fits the frame budget. Two cannot be cut: compact step 1's P (4-5 ms at 325k, 7.5 ms at
// 1M on an M1 Max) and the composition a copy frame adds (2.7-5.6 / 4.5-9.9 ms), which the frame reserves
// but which never stops its first item. So a copy frame can carry up to ~12 ms of layout GPU work at 325k
// and ~17 ms at 1M, against a 10 ms budget at 60 Hz (5 ms at 120 Hz).
//
// Not the CPU's: Jacobi instead of Gauss-Seidel links and collision pairs (every term reads one state),
// and grid-pyramid Barnes-Hut instead of the CPU's adaptive quadtree for segments above 32 children (the
// flat layout's approximation). Everything else — radii, seeds, links, forces, the integration constants,
// the alpha schedule per segment, the composition — is the CPU's (spec §11.1, Q6).

const NEAREST: SamplerProps = { minFilter: "nearest", magFilter: "nearest" };

/** Barnes-Hut opening angle of the CPU nested solve's `repel()`. */
const NESTED_THETA = 0.9;

/**
 * GPU time per leaf of the organise ticks' work items, ns — measured on an M1 Max (ANGLE Metal) on the
 * synthetic Infomap-like maps (325,729 and 1,000,000 leaves): P 1.9 ms at 325k (reductions + tile
 * pyramid), a whole-atlas repulsion band 2.1 ms, I 1.6 ms (predict + springs + integrate).
 */
const NESTED_ORGANISE_NS: ItemCosts = { prep: 4, force: 6, integrate: 4 };

/**
 * The compact ticks' work items, measured on the same M1 Max over web-NotreDame's Infomap trees, the
 * synthetic 325k and 1M maps and one-module Zipf maps of 20,000 and 60,000 children (#380):
 *
 * - P (the solve tick's predict + springs + integrate on step 1, the reductions, the cell pass and the
 *   occupancy scatters) is 3.4-5.4 ms, 7.5 at 1M: a fixed ~3.2 ms of passes plus 4 ns per leaf;
 * - the unbanded gather is 4.0 ms plus 47 ps per unit of the collision plan's work estimate (its pair
 *   tests plus 16 per cell visit), within ±8% on all six maps (5.2-11.7 ms) — where the previous 13 ns per
 *   leaf was off by 0.06-1.1× between them (0.06× on the 20,000-child Zipf module: the frame stalls). The
 *   4 ms is the work items' pass (its longest serial chains); a map without items — every module small
 *   enough for single-item exact loops — has 0.3 ms instead (1.0 / 1.2 ms at 20k / 100k leaves, fence
 *   wait included);
 * - I is a swap.
 *
 * A slower GPU is caught by the frame budget's fences, as for the flat layout.
 */
const NESTED_COMPACT = { prepMs: 3.2, prepNsPerLeaf: 4, gatherMs: 4, gatherMsWithoutItems: 0.3, gatherPsPerWork: 47, integrateNsPerLeaf: 0.2 } as const;

/**
 * The share of the compact items' measured GPU time the frame budget is told. The per-leaf model this
 * replaces told it about half on web-NotreDame's Infomap trees (4.2 ms for a 9 ms gather, 3.3 / 1 ms for
 * a 5 / 3 ms P), and the fence gate — two frames in flight — absorbed that: those layouts streamed without
 * a blocked frame. Kept here, so they pace as before (2.1-2.2 s cold on the M1 Max), and now the same
 * factor on every map, where the per-leaf model's ranged 0.06-1.1 (0.06 on a 20,000-child Zipf module:
 * the gate blocked ~200 frames and frames stalled). At 1 — the budget told the whole measured time —
 * those trees take ~2.85 s instead.
 */
const NESTED_COMPACT_BUDGET_SHARE = 0.5;

/** Work units a slot adds to its band besides its search (its resolve): a cell visit's worth. */
const NESTED_SLOT_BASE_WORK = 16;

/** GPU time per leaf of a readback's composition (two reductions and the compose pass), ns: 4.7 ms at 325k. */
const NESTED_READBACK_NS = 12;

/**
 * The nested reduce map: in mode 1 each slot's `(rad² · x, rad² · y, rad², 1)` and box `(x, y, −x, −y)` —
 * the segments' weighted centroids (the composition's m_p) and boxes (the pyramid's and the collision
 * grid's geometry); in mode 2 its distance from its segment's centroid plus its radius in the box chain's
 * x — the segments' extents.
 */
const NESTED_REDUCE_MAP: ReduceMap = {
  glsl: /* glsl */ `\
uniform highp usampler2D u_slotSeg;
uniform highp sampler2D u_rad;
uniform highp sampler2D u_segSum;   // mode 2: mode 1's sums per segment
uniform int u_segTableWidth;        // the segment table's atlas width (u_segSum's)
uniform int u_mode;                 // 1: weighted centroid sums + box; 2: extent about the centroid
void mapSlot(int s, out vec4 sum, out vec4 box) {
  if (s >= u_count) { sum = vec4(0.0); box = BOX_IDENTITY; return; }
  ivec2 t = slotTexel(s, u_posWidth);
  vec2 p = texelFetch(u_pos, t, 0).xy;
  float r = texelFetch(u_rad, t, 0).r;
  if (u_mode == 1) {
    float w = r * r;
    sum = vec4(p * w, w, 1.0);
    box = vec4(p, -p);
    return;
  }
  vec4 a = texelFetch(u_segSum, slotTexel(int(texelFetch(u_slotSeg, t, 0).r), u_segTableWidth), 0);
  vec2 m = a.z > 0.0 ? a.xy / a.z : vec2(0.0);
  sum = vec4(0.0);
  box = vec4(length(p - m) + r, BOX_IDENTITY.yzw);
}
`,
  uniforms: { u_segTableWidth: 1, u_mode: 1 },
};

/**
 * How a {@link GpuNestedLayout} of `topo` lays the solve out in textures, derived once: the segments as
 * slot ranges, their tile atlas (a tile for each segment above {@link EXACT_MAX} children, the CPU's exact
 * threshold), and the segment collision table's size. {@link gpuNestedLayoutNeed} checks it against the
 * device and the constructor allocates it, so the verdict and the allocation share one size rule, and a
 * transport packs the tiles once. O(S log S) over S segments (the tile packing).
 */
export interface NestedLayoutPlan {
  readonly topo: NestedSolverTopology;
  readonly segments: readonly SlotRange[];
  readonly atlas: TileAtlas;
  /**
   * The segment collision table: 3 `rgba32uint` texels per segment-table row — S segments and the
   * whole-slot range — its collision list (2), then its grid (bucket base, bucket mask, classes, sub-cell base).
   */
  readonly collide: { readonly width: number; readonly height: number };
}

/** The nested layout's repulsion variant: many segments, the exact loop and the tiles of `atlas`. */
function nestedRepulsion(atlas: TileAtlas): RepulsionVariant {
  return { singleSegment: false, levelCount: atlas.levels.length, exact: true };
}

/** The {@link NestedLayoutPlan} of `topo`. O(S log S) over S segments. */
export function nestedLayoutPlan(topo: NestedSolverTopology): NestedLayoutPlan {
  const segments: SlotRange[] = [];
  for (let s = 0; s < topo.segStart.length; s++) segments.push({ start: topo.segStart[s] ?? 0, count: topo.segCount[s] ?? 0 });
  const collideTexels = 3 * (segments.length + 1);
  const collideWidth = atlasWidth(collideTexels);
  return {
    topo,
    segments,
    atlas: packTiles(segments, EXACT_MAX, TILE_MIN_SIDE),
    collide: { width: collideWidth, height: Math.ceil(collideTexels / collideWidth) },
  };
}

/**
 * Every texture side and limit a {@link GpuNestedLayout} of `plan` needs, for `gpuLayoutSupport`: the
 * slot atlas (every per-slot texture, the collision cells' slot targets, the composition's staging
 * texture, at most as many texels), the CSR offsets (and the composition's node map, as many), and the
 * slot count ({@link gpuNestedSlotNeed}, checked before the prep too); then the springs, the tile atlas
 * (the pyramid's level 0; its coarser levels are smaller), the segment collision table (the other segment
 * tables are smaller) and the collision grid's own textures ({@link collisionGridSide}: its hash tables,
 * work items and binned-slot list). A transport checks it before constructing, so a tree the device
 * cannot run is unsupported rather than a constructor throw. O(1).
 */
export function gpuNestedLayoutNeed(plan: NestedLayoutPlan): GpuLayoutNeed {
  const { topo, atlas, collide } = plan;
  return {
    ...gpuNestedSlotNeed(topo.slotCount),
    springSide: atlasWidth(2 * topo.linkSource.length),
    pyramidSide: Math.max(atlas.width, atlas.height),
    nested: { slots: topo.slotCount, collideSide: collide.width, gridSide: collisionGridSide(atlasWidth(topo.slotCount), topo.collision) },
  };
}

/** Options of {@link GpuNestedLayout}. */
export interface GpuNestedLayoutOptions {
  /**
   * The root disc's centre, world units. Default the prep's (`topo.rootX`, `topo.rootY`): the origin for a
   * cold layout (a warm one is placed after), or where a warm start placed by its seed puts it (#454).
   */
  rootX?: number;
  rootY?: number;
  /** Test hook: ticks of the organise phase (default `⌈0.6 · iterations⌉`, the CPU's). */
  organise?: number;
  /** Test hook: build the collision grid's per-slot statistics pass ({@link GpuNestedLayout.collisionStats}). */
  collisionStats?: boolean;
}

/**
 * The batched GPU nested layout — see the file header. Built once per layout from the
 * {@link NestedLayoutPlan} of a {@link NestedSolverTopology}; every texture, framebuffer and program is
 * created here, so ticking and reading back allocate nothing. A {@link StreamSolver}: the streaming
 * transport encodes its work items within the frame budget and reads the composed positions back through
 * a fenced PBO.
 */
export class GpuNestedLayout implements StreamSolver {
  private readonly device: Device;
  private readonly topo: NestedSolverTopology;
  /** Slots, slot atlas width and height. */
  private readonly slots: number;
  private readonly width: number;
  private readonly height: number;
  private readonly pos: PingPong;
  private readonly vel: PingPong;
  /** `[pos write, vel write]` MRT framebuffers, indexed `[pos parity][vel parity]` (collision swaps pos only). */
  private readonly integrateFbos: readonly [readonly [Framebuffer, Framebuffer], readonly [Framebuffer, Framebuffer]];
  /** A framebuffer per position texture: [0] wraps the initial read side (A), [1] the other (B). */
  private readonly posFbos: readonly [Framebuffer, Framebuffer];
  private posParity = 0;
  private velParity = 0;
  private readonly vstar: Texture;
  private readonly vstarFbo: Framebuffer;
  private readonly force: Texture;
  private readonly forceFbo: Framebuffer;
  private readonly radius: Texture;
  private readonly slotSeg: Texture;
  /** Per segment `(finest collision sub-cell side, owner slot, 0, 0)`. */
  private readonly segNested: Texture;
  /** Per slot its collision class and exact bit (`r32uint`). */
  private readonly slotCollide: Texture;
  /** Per segment its collision list (2 `rgba32uint` texels) and grid (bucket base, bucket mask, classes, sub-cell base). */
  private readonly segCollide: Texture;
  /** The segment table — S segments plus one range over every slot (the readback's finiteness check). */
  private readonly segments: SegmentTable;
  /** Mode 2's target: each range's extent about its centroid (box x). */
  private readonly extent: { readonly stats: Texture; readonly box: Texture; readonly target: RangeTarget };
  private readonly reduce: SegmentedReduce;
  private readonly pyramid: GridPyramid | null;
  private readonly repulsion: RepulsionPass;
  private readonly springs: GpuSprings;
  private readonly predict: NestedPredictPass;
  private readonly integratePass: NestedIntegratePass;
  private readonly collision: CollisionGrid;
  private readonly compose: NestedComposePass;
  private readonly slotInputs: NestedSlotInputs;
  private readonly gatherInput: CollisionInputs;
  private readonly springInputs: NestedSpringInputs;
  /**
   * The nested map's textures per mode. Mode 2 reads mode 1's sums (the segment table's `stats`); mode 1
   * renders into that texture, so it binds a stand-in there — a texture bound for sampling while it is
   * the render target is a feedback loop, and WebGL drops the draw, whether the shader reads it or not.
   */
  private readonly reduceBindings: readonly [Record<string, Texture>, Record<string, Texture>];
  private readonly reduceUniforms: PassUniforms = { u_segTableWidth: 1, u_mode: 1 };
  private readonly rootX: number;
  private readonly rootY: number;
  /** Every GPU resource and pass this layout created, in creation order ({@link destroy} frees them in reverse). */
  private readonly owned: { destroy(): void }[] = [];

  /** Solve ticks done, the organise → compact switch, and each start's alpha and decay. */
  private tick = 0;
  /** The collision step the current compact tick is at (0 … COLLISION_STEPS − 1). */
  private step = 0;
  private readonly organise: number;
  private alphaCold = 1;
  private alphaWarm = WARM_ALPHA;
  private readonly decayCold: number;
  private readonly decayWarm: number;

  /** The readback's staging texture: leaf positions then module discs, in node order. */
  readonly packed: PackedPositions;
  /**
   * The frame budget's per-leaf band model, which it sizes its static band count by: the organise
   * repulsion's, or the compact gather's plan-based estimate per leaf when that is heavier (see
   * {@link itemCostMs} for the per-item estimates).
   */
  readonly itemCosts: ItemCosts;
  /** The compact gather's unbanded GPU time estimate as the frame budget is told it, ms ({@link NESTED_COMPACT}). */
  private readonly gatherMs: number;
  /** Cumulative gather work up to each slot atlas row (`height + 1` entries): the compact bands' cuts. */
  private readonly rowWork: Float64Array;

  /** The next item's estimated GPU time, ms, for the stream tick the solve is at. */
  itemCostMs(kind: ItemKind, bands: number): number {
    const leaves = this.topo.leafCount;
    if (this.organising) return itemCostMs(kind, leaves, bands, NESTED_ORGANISE_NS);
    if (kind === "prep") return NESTED_COMPACT_BUDGET_SHARE * (NESTED_COMPACT.prepMs + (NESTED_COMPACT.prepNsPerLeaf * leaves) / 1e6);
    if (kind === "force") return this.gatherMs / Math.max(1, bands);
    return (NESTED_COMPACT.integrateNsPerLeaf * leaves) / 1e6;
  }

  /** Estimated GPU time of a readback's composition, ms. */
  get readbackCostMs(): number {
    return (NESTED_READBACK_NS * this.topo.leafCount) / 1e6;
  }

  /**
   * Every program a nested layout of `plan` with `options` compiles, as its passes declare them (#385) — so a
   * transport can compile them all at once, in parallel, before it builds the layout. Pure, no GPU work. The
   * springs' variant (hub rows or not) needs the links' row lengths, counted here over the plan's links:
   * O(slots + links), one slot-sized count array (the constructor's CSR build counts them again).
   */
  static programs(plan: NestedLayoutPlan, options: GpuNestedLayoutOptions = {}): LayoutProgram[] {
    const { topo, atlas } = plan;
    const reduce = segmentedReducePrograms(NESTED_REDUCE_MAP);
    // Each link adds to both endpoints' rows, as buildCSR counts them for the springs' CSR.
    const degree = new Uint32Array(topo.slotCount);
    for (let e = 0; e < topo.linkSource.length; e++) {
      const i = topo.linkSource[e] ?? 0;
      const j = topo.linkTarget[e] ?? 0;
      degree[i] = (degree[i] ?? 0) + 1;
      degree[j] = (degree[j] ?? 0) + 1;
    }
    const programs = [reduce.level1, reduce.level, reduce.query];
    if (atlas.levels.length > 0) {
      const pyramid = gridPyramidPrograms(false, false);
      programs.push(pyramid.scatter, pyramid.reduce);
    }
    programs.push(
      repulsionProgram(nestedRepulsion(atlas)),
      ...springPrograms(springVariant({ springWeight: topo.linkWeight }, degree, true)),
      nestedPredictProgram(),
      nestedIntegrateProgram(),
      ...collisionGridProgramList(topo.collision, { stats: options.collisionStats === true }),
      nestedComposeProgram(topo.depth),
    );
    return programs;
  }

  constructor(device: Device, plan: NestedLayoutPlan, options: GpuNestedLayoutOptions = {}) {
    const topo = plan.topo;
    this.device = device;
    this.topo = topo;
    // Anything created before a later step throws (a shader the driver rejects, a limit) is freed.
    const own = <T extends { destroy(): void }>(resource: T): T => {
      this.owned.push(resource);
      return resource;
    };
    try {
      const slots = topo.slotCount;
      if (slots < 1) throw new Error("GpuNestedLayout: the tree has no node below its root");
      if (slots >= NESTED_MAX_SLOTS) throw new Error("GpuNestedLayout: slot ids must stay exact in float32 (below 2^24)");
      this.slots = slots;
      this.rootX = options.rootX ?? topo.rootX;
      this.rootY = options.rootY ?? topo.rootY;
      const width = atlasWidth(slots);
      const height = Math.ceil(slots / width);
      this.width = width;
      this.height = height;
      const T = topo.iterations;
      this.organise = options.organise ?? Math.ceil(T * NESTED.ORGANISE);
      this.decayCold = nestedAlphaDecay(1, T);
      this.decayWarm = nestedAlphaDecay(WARM_ALPHA, T);

      // Segments + one whole-slot range; tiles for segments above EXACT_MAX (the CPU's exact threshold).
      // A transport has checked the atlas (gpuNestedLayoutNeed); the assertion guards direct callers.
      const S = topo.segStart.length;
      const { segments, atlas } = plan;
      assertAtlasFits(atlas, device.limits.maxTextureDimension2D);
      const rows: SegmentRow[] = segments.map((seg, s) => {
        const tile = atlas.tiles[s] ?? null;
        return {
          ...seg,
          tile,
          frozen: seg.count === 1,
          param: {
            repulsion: NESTED.REPULSION_K / Math.max(1, seg.count),
            centering: NESTED.GRAVITY,
            softening: segmentSoftening("unit", tile === null),
            alpha0: topo.segAlpha0[s] ?? 1,
          },
        };
      });
      rows.push({ start: 0, count: slots, tile: null, param: { repulsion: 0, centering: 0, softening: 0, alpha0: 1 } });

      const slotData = (n: number, data: ArrayLike<number>, floats: number, pad = 0): Float32Array => {
        const out = new Float32Array(width * height * floats).fill(pad);
        for (let i = 0; i < n * floats; i++) out[i] = data[i] ?? 0;
        return out;
      };
      this.pos = own(pingPong(device, width, height, slotData(slots, topo.seed, 2)));
      this.vel = own(pingPong(device, width, height));
      const posFbo = (): Framebuffer => own(device.createFramebuffer({ width, height, colorAttachments: [this.pos.readTex] }));
      const posA = posFbo();
      this.pos.swap();
      const posB = posFbo();
      this.pos.swap();
      this.posFbos = [posA, posB];
      // MRT pairs [pos write, vel write] for each (pos parity, vel parity): the write side of parity p is
      // the texture NOT read at p — B at 0, A at 1.
      const mrt = (): Framebuffer => own(device.createFramebuffer({ width, height, colorAttachments: [this.pos.writeTex, this.vel.writeTex] }));
      const pp: Framebuffer[] = [];
      for (let p = 0; p < 2; p++) {
        for (let v = 0; v < 2; v++) {
          if (p === 1) this.pos.swap();
          if (v === 1) this.vel.swap();
          pp.push(mrt());
          if (p === 1) this.pos.swap();
          if (v === 1) this.vel.swap();
        }
      }
      const [f00, f01, f10, f11] = pp;
      if (!f00 || !f01 || !f10 || !f11) throw new Error("GpuNestedLayout: missing integrate framebuffer");
      this.integrateFbos = [[f00, f01], [f10, f11]];

      const tex2 = (): Texture => own(device.createTexture({ width, height, format: "rg32float", mipLevels: 1, sampler: NEAREST }));
      this.vstar = tex2();
      this.vstarFbo = own(device.createFramebuffer({ width, height, colorAttachments: [this.vstar] }));
      this.force = tex2();
      this.forceFbo = own(device.createFramebuffer({ width, height, colorAttachments: [this.force] }));
      this.radius = own(device.createTexture({ width, height, format: "r32float", data: slotData(slots, topo.radius, 1), mipLevels: 1, sampler: NEAREST }));
      const seg = new Uint32Array(width * height);
      seg.set(slotSegments(segments, slots));
      this.slotSeg = own(device.createTexture({ width, height, format: "r32uint", data: seg, mipLevels: 1, sampler: NEAREST }));

      this.segments = own(new SegmentTable(device, rows));
      const tw = this.segments.width;
      const th = Math.ceil(rows.length / tw);
      const nested = new Float32Array(tw * th * 4);
      const collision = topo.collision;
      for (let s = 0; s < S; s++) {
        nested[s * 4] = collision.segCellSide[s] ?? 0;
        nested[s * 4 + 1] = topo.segOwner[s] ?? -1;
      }
      nested[S * 4 + 1] = -1;
      this.segNested = own(device.createTexture({ width: tw, height: th, format: "rgba32float", data: nested, mipLevels: 1, sampler: NEAREST }));
      const classes = new Uint32Array(width * height);
      classes.set(collision.slotCollide);
      this.slotCollide = own(device.createTexture({ width, height, format: "r32uint", data: classes, mipLevels: 1, sampler: NEAREST }));
      // 3 texels per segment row: its list (−1 → NO_CELL pads), then (bucket base, bucket mask, classes, sub-cell base).
      const { width: collideWidth, height: collideRows } = plan.collide;
      const collide = new Uint32Array(collideWidth * collideRows * 4);
      for (let s = 0; s < S; s++) {
        for (let q = 0; q < COLLISION_LIST_MAX; q++) collide[12 * s + q] = (collision.segList[s * COLLISION_LIST_MAX + q] ?? -1) >>> 0;
        collide[12 * s + 8] = collision.segBucketBase[s] ?? 0;
        collide[12 * s + 9] = collision.segBucketMask[s] ?? 0;
        collide[12 * s + 10] = collision.segClasses[s] ?? 0;
        collide[12 * s + 11] = collision.segSubBase[s] ?? 0;
      }
      this.segCollide = own(device.createTexture({ width: collideWidth, height: collideRows, format: "rgba32uint", data: collide, mipLevels: 1, sampler: NEAREST }));
      const extentTex = (): Texture => own(device.createTexture({ width: tw, height: th, format: "rgba32float", mipLevels: 1, sampler: NEAREST }));
      const extentStats = extentTex();
      const extentBox = extentTex();
      this.extent = {
        stats: extentStats,
        box: extentBox,
        target: {
          target: own(device.createFramebuffer({ width: tw, height: th, colorAttachments: [extentStats, extentBox] })),
          width: tw,
          size: rows.length,
          info: this.segments.info,
        },
      };

      this.reduce = own(new SegmentedReduce(device, slots, NESTED_REDUCE_MAP));
      this.reduceBindings = [
        { u_slotSeg: this.slotSeg, u_rad: this.radius, u_segSum: this.extent.stats },
        { u_slotSeg: this.slotSeg, u_rad: this.radius, u_segSum: this.segments.stats },
      ];
      this.reduceUniforms["u_segTableWidth"] = tw;
      this.pyramid = atlas.levels.length > 0 ? own(new GridPyramid(device, atlas, false)) : null;
      this.repulsion = own(new RepulsionPass(device, nestedRepulsion(atlas)));

      const links: LayoutGraph = {
        nodeCount: slots,
        edgeCount: topo.linkSource.length,
        source: topo.linkSource,
        target: topo.linkTarget,
        springWeight: topo.linkWeight,
        positions: new Float32Array(0),
      };
      this.springs = own(new GpuSprings(device, links, { nested: true, rowScale: topo.springScale }));
      this.predict = own(new NestedPredictPass(device));
      this.integratePass = own(new NestedIntegratePass(device, 1 - NESTED.DECAY));
      this.collision = own(
        new CollisionGrid(device, width, height, collision, { stats: options.collisionStats === true }),
      );
      this.compose = own(new NestedComposePass(device, topo.nodeSlot, topo.leafCount, topo.depth, NESTED.FILL, NESTED.ONLY_CHILD));
      this.packed = { framebuffer: this.compose.framebuffer, width: this.compose.width, height: this.compose.height, extraFloats: this.compose.extraFloats };

      // The compact gather's cost and its bands' cuts, from the collision plan's per-slot work.
      const gatherFloorMs = collision.itemCount > 0 ? NESTED_COMPACT.gatherMs : NESTED_COMPACT.gatherMsWithoutItems;
      this.gatherMs = NESTED_COMPACT_BUDGET_SHARE * (gatherFloorMs + (NESTED_COMPACT.gatherPsPerWork * collision.gatherWork) / 1e9);
      const gatherNsPerLeaf = (this.gatherMs * 1e6) / Math.max(1, topo.leafCount);
      this.itemCosts = { ...NESTED_ORGANISE_NS, force: Math.max(NESTED_ORGANISE_NS.force, gatherNsPerLeaf) };
      this.rowWork = new Float64Array(height + 1);
      for (let r = 0; r < height; r++) {
        let work = 0;
        for (let i = r * width; i < Math.min(slots, (r + 1) * width); i++) work += (collision.slotWork[i] ?? 0) + NESTED_SLOT_BASE_WORK;
        this.rowWork[r + 1] = (this.rowWork[r] ?? 0) + work;
      }

      this.slotInputs = {
        count: slots,
        width,
        slotSeg: this.slotSeg,
        segParam: this.segments.param,
        tableWidth: tw,
        alphaCold: 1,
        alphaWarm: WARM_ALPHA,
      };
      this.springInputs = { vstar: this.vstar, radius: this.radius, rest: 0, pad: NESTED.PAD };
      this.gatherInput = {
        slotSeg: this.slotSeg,
        segments: this.segments,
        segNested: this.segNested,
        slotCollide: this.slotCollide,
        segCollide: this.segCollide,
        collideWidth,
        count: slots,
        width,
        rows: height,
        pad: NESTED.PAD,
      };
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  // ── StreamSolver / ReadbackSource ──────────────────────────────────────────

  /** Leaves: the positions a readback returns (in node order). */
  get nodeCount(): number {
    return this.topo.leafCount;
  }

  /** Rows of the slot atlas — the domain the repulsion bands cut. */
  get atlasRows(): number {
    return this.height;
  }

  /** Solve ticks completed so far. */
  get ticks(): number {
    return this.tick;
  }

  /**
   * Stream ticks of the whole solve — what the streaming transport runs: one per organise tick and
   * {@link COLLISION_STEPS} per compact tick.
   */
  get streamTicks(): number {
    return this.organise + COLLISION_STEPS * Math.max(0, this.topo.iterations - this.organise);
  }

  /** Run `ticks` whole solve ticks, every item unsliced — for tests and one-off solves. */
  runTicks(ticks: number): void {
    const until = this.tick + ticks;
    while (this.tick < until) {
      this.beginTick();
      this.forceBand(0, 1);
      this.integrate();
    }
  }

  get positionTexture(): Texture {
    return this.pos.readTex;
  }

  get positionFramebuffer(): Framebuffer {
    return this.posFbo(this.posParity);
  }

  get positionWidth(): number {
    return this.width;
  }

  get segmentStats(): { readonly stats: Texture; readonly box: Texture } {
    return this.segments;
  }

  /** The whole-slot range (the last row of the table): its stats refuse a non-finite readback. */
  get statsTexel(): readonly [number, number] {
    const s = this.topo.segStart.length;
    return [s % this.segments.width, Math.floor(s / this.segments.width)];
  }

  private get organising(): boolean {
    return this.tick < this.organise;
  }

  /** Work item **P** of the current stream tick (see the file header). */
  beginTick(): void {
    if (this.organising) {
      this.runReduce(1, this.segments);
      this.pyramid?.build({
        posTex: this.pos.readTex,
        width: this.width,
        count: this.slots,
        segments: this.segments,
        slotSeg: this.slotSeg,
      });
      this.device.submit();
      return;
    }
    if (this.step === 0) this.advance(false);
    // This collision step's cells and occupancy, from the positions it starts at.
    this.runReduce(1, this.segments);
    this.collision.prepare({ ...this.gatherInput, pos: this.pos.readTex, radius: this.radius });
    this.device.submit();
  }

  /**
   * Work item **F_b**: band `band` of `bands` of the slot atlas's rows — the repulsion over equal rows
   * (organise), which clears its rows of the force texture as it opens it, or the collision gather over
   * rows of equal estimated work (compact).
   */
  forceBand(band: number, bands: number): void {
    if (!this.organising) {
      const [r0, r1] = this.gatherBandRows(band, bands);
      if (r1 <= r0) return;
      this.collision.gather(this.posFbo(this.posParity ^ 1), this.gatherInput, r0, r1);
      this.device.submit();
      return;
    }
    const r0 = Math.floor((band * this.height) / bands);
    const r1 = Math.floor(((band + 1) * this.height) / bands);
    if (r1 <= r0) return;
    const pass = beginPass(this.device, {
      framebuffer: this.forceFbo,
      clear: [0, 0, 0, 0],
      ...(bands > 1 ? { scissor: [0, r0, this.width, r1 - r0] } : {}),
    });
    this.repulsion.run(pass, {
      posTex: this.pos.readTex,
      count: this.slots,
      width: this.width,
      theta: NESTED_THETA,
      segments: this.segments,
      pyramid: this.pyramid,
      slotSeg: this.slotSeg,
    });
    pass.end();
    this.device.submit();
  }

  /**
   * Work item **I**: in the organise phase predict, springs and integrate; in the compact phase the swap
   * to the collided positions. The last item of a solve tick advances the alpha schedules.
   */
  integrate(): void {
    if (this.organising) {
      this.advance(true);
      this.device.submit();
      this.endTick();
      return;
    }
    this.swapPos(); // the gather bands wrote every slot of the other position texture
    this.step++;
    if (this.step >= COLLISION_STEPS) {
      this.step = 0;
      this.endTick();
    }
  }

  /**
   * Predict v*, gather the springs at x + v* (zero rest while organising) into the force texture — cleared as
   * the springs' pass opens it, after the predict has read the force it held — integrate (MRT), swap. The
   * item that calls it submits.
   */
  private advance(organising: boolean): void {
    const input = this.slotInputs;
    input.alphaCold = this.alphaCold;
    input.alphaWarm = this.alphaWarm;

    let pass = beginPass(this.device, { framebuffer: this.vstarFbo, clear: false });
    this.predict.run(pass, this.pos.readTex, this.vel.readTex, this.force, organising, input);
    pass.end();

    const springs = this.springInputs;
    springs.rest = organising ? 0 : 1;
    this.springs.prepare(this.pos.readTex, this.width, springs);
    pass = beginPass(this.device, { framebuffer: this.forceFbo, clear: [0, 0, 0, 0] });
    this.springs.draw(pass, this.pos.readTex, { count: this.slots, width: this.width, attraction: 1 }, null, springs);
    pass.end();

    const [atPos0, atPos1] = this.integrateFbos;
    const pair = this.posParity === 0 ? atPos0 : atPos1;
    const fbo = this.velParity === 0 ? pair[0] : pair[1];
    pass = beginPass(this.device, { framebuffer: fbo, clear: false });
    this.integratePass.run(pass, this.pos.readTex, this.vstar, this.force, input);
    pass.end();
    this.swapPos();
    this.vel.swap();
    this.velParity ^= 1;
  }

  /**
   * The slot atlas rows `[r0, r1)` compact band `band` of `bands` gathers: rows of about `1 / bands` of the
   * collision plan's estimated work each (a band cannot split a row), tiling the atlas in order.
   */
  gatherBandRows(band: number, bands: number): [number, number] {
    return [this.workRow(band, bands), this.workRow(band + 1, bands)];
  }

  /**
   * The first slot atlas row of compact band `band` of `bands`: the first row whose cumulative gather work
   * reaches `band / bands` of the total (0 for band 0, the atlas height for band `bands`), so consecutive
   * bands tile the rows in order.
   */
  private workRow(band: number, bands: number): number {
    if (band <= 0) return 0;
    if (band >= bands) return this.height;
    const target = ((this.rowWork[this.height] ?? 0) * band) / bands;
    let lo = 0;
    let hi = this.height;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.rowWork[mid] ?? 0) < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** A solve tick is complete: advance the alpha schedules. */
  private endTick(): void {
    this.alphaCold -= this.alphaCold * this.decayCold;
    this.alphaWarm -= this.alphaWarm * this.decayWarm;
    this.tick++;
  }

  /**
   * Compose the current local positions into world positions and discs, packed in node order for the
   * readback: the weighted centroids and boxes (mode 1, whose whole-slot range the harvest checks for
   * finiteness), the extents (mode 2), then the composition. Positions change only in {@link integrate},
   * so this is safe at any point of a tick; it recomputes the reductions itself either way. It encodes and
   * does not submit: the readback's copy submits (or {@link readComposed}, synchronously).
   */
  prepareReadback(): void {
    this.runReduce(1, this.segments);
    this.runReduce(2, this.extent.target);
    this.compose.run({
      pos: this.pos.readTex,
      radius: this.radius,
      slotSeg: this.slotSeg,
      width: this.width,
      segments: this.segments,
      segExtent: this.extent.box,
      segNested: this.segNested,
      rootX: this.rootX,
      rootY: this.rootY,
      rootRadius: this.topo.rootRadius,
    });
  }

  /**
   * Compose and read back synchronously — for tests and one-off reads; the streaming transport never
   * calls it (it reads through a fenced PBO). `positions` gets the leaves' world positions (`2 · leaves`
   * floats), `discs` (optional) every module's world disc as `(cx, cy, r, 0)` (`4 · modules` floats).
   */
  readComposed(positions: Float32Array, discs?: Float32Array): void {
    this.prepareReadback();
    this.device.submit();
    const { width, height, framebuffer } = this.compose;
    const pixels = this.device.readPixelsToArrayWebGL(framebuffer, { sourceWidth: width, sourceHeight: height });
    if (!(pixels instanceof Float32Array)) throw new Error("GpuNestedLayout: expected a float readback");
    positions.set(pixels.subarray(0, 2 * this.topo.leafCount));
    if (discs) {
      const from = 4 * Math.ceil(this.topo.leafCount / 2);
      discs.set(pixels.subarray(from, from + Math.min(discs.length, this.compose.extraFloats)));
    }
  }

  /**
   * Tests only (a layout built with `collisionStats`): what the current collision step does per slot,
   * summed over its work items — `(cells visited, pairs tested, grid partners pushed, 1 exact slot / 2
   * overflow)`, 4 floats per slot — from the state its work item P prepared (call it after
   * {@link beginTick} of a compact tick).
   */
  collisionStats(): Float32Array {
    return this.collision.gatherStats(this.gatherInput);
  }

  /** The slots' local positions (each in its parent's unit disc), synchronously — for tests: `2 · slots` floats. */
  readLocal(out: Float32Array): void {
    const pixels = this.device.readPixelsToArrayWebGL(this.positionFramebuffer, { sourceWidth: this.width, sourceHeight: this.height });
    if (!(pixels instanceof Float32Array)) throw new Error("GpuNestedLayout: expected a float readback");
    // rg32float reads back as RGBA or RG depending on the device: take x, y of every texel either way.
    const channels = pixels.length / (this.width * this.height);
    for (let i = 0; i < this.slots; i++) {
      out[2 * i] = pixels[channels * i] ?? Number.NaN;
      out[2 * i + 1] = pixels[channels * i + 1] ?? Number.NaN;
    }
  }

  destroy(): void {
    for (let i = this.owned.length - 1; i >= 0; i--) this.owned[i]?.destroy();
    this.owned.length = 0;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private runReduce(mode: 1 | 2, table: RangeTarget): void {
    this.reduceUniforms["u_mode"] = mode;
    this.reduce.run(
      { pos: this.pos.readTex, posWidth: this.width, count: this.slots },
      table,
      mode === 1 ? this.reduceBindings[0] : this.reduceBindings[1],
      this.reduceUniforms,
    );
  }

  /** The framebuffer of the position texture that is the read side at parity `p`. */
  private posFbo(p: number): Framebuffer {
    return p === 0 ? this.posFbos[0] : this.posFbos[1];
  }

  private swapPos(): void {
    this.pos.swap();
    this.posParity ^= 1;
  }
}
