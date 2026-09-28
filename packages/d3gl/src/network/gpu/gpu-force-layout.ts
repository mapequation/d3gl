import type { Device, Texture, Framebuffer } from "@luma.gl/core";
import type { ForceParams, LayoutGraph } from "../force.js";
import { CONVERGED_STEP, Cooling, DAMPING, equilibriumSpacing, springStabilizers, stepCap, stopArmed } from "../force.js";
import { atlasWidth, pingPong } from "./textures.js";
import { PositionReadback } from "./position-readback.js";
import { IntegratePass } from "./passes/integrate.js";
import { GpuSprings } from "./springs.js";
import { RepulsionPass } from "./passes/repulsion.js";
import { GridPyramid } from "./passes/grid-pyramid.js";
import { CenteringPass } from "./passes/centering.js";
import { beginPass, type PassViewport } from "./passes/fullscreen.js";
import { SegmentedReduce } from "./passes/segmented-reduce.js";
import { SegmentTable, type SegmentRow } from "./segment-table.js";
import {
  FLAT_TILE_MIN_SIDE,
  TILE_MIN_SIDE,
  assertAtlasFits,
  assertSegmentLocalEdges,
  bandRows,
  flatSegments,
  packTiles,
  segmentSoftening,
  slotSegments,
  tileSide,
  validateSegments,
  type SegmentFrame,
  type SlotRange,
  type Tile,
} from "./segments.js";
import { SeedLevels, SeedPasses } from "./seed-levels.js";
import type { SeedPlan } from "./seed-plan.js";
import { StopLatchPass } from "./passes/stop-latch.js";

// DAMPING is imported from force.ts so both integrators share one constant.

/**
 * The flat layout's `exactMax` — the node-count threshold for the repulsion algorithm. At or below
 * this many nodes the exact all-pairs O(n²) loop runs (cheap at small N and bit-for-bit the
 * correctness/parity baseline every existing test relies on); above it the Barnes-Hut grid-pyramid
 * traversal (O(n log n)) runs. 4096 keeps the all-pairs cost bounded (~16.7M pair terms) while
 * covering all current tiny-N tests.
 */
export const GPU_REPULSION_ALLPAIRS_MAX = 4096;

/** Optional overrides for {@link GpuForceLayout} (test/tuning hooks). */
export interface GpuForceLayoutOptions {
  /**
   * Force a repulsion algorithm for every segment regardless of its size — shorthand for
   * {@link exactMax}, and it takes precedence over it:
   *   "allpairs" — exact O(k²) (`exactMax: Infinity`);  "pyramid" — Barnes-Hut tiles (`exactMax: 0`).
   * Omitted → {@link exactMax}.
   */
  repulsionMode?: "allpairs" | "pyramid";
  /**
   * The largest segment solved by the exact loop; every larger segment gets a pyramid tile and the
   * Barnes-Hut traversal (spec §6.2.1). Default {@link GPU_REPULSION_ALLPAIRS_MAX} (the flat layout's
   * 4096); the nested layout uses 32, the CPU `EXACT_MAX`. A multilevel seed level (#353) follows the same
   * rule by its own slot count.
   */
  exactMax?: number;
  /**
   * The segments (#333): contiguous slot ranges `[start, start + count)` covering every node in order.
   * Forces never cross a segment: repulsion, springs and centering act only between the slots of one
   * segment, and every segment is centred on its own centroid. Default: one segment over every node —
   * the flat layout. The node ids are the slots (identity permutation), and an edge whose endpoints lie
   * in different segments is rejected.
   */
  segments?: readonly SlotRange[];
  /**
   * The frame the segments are solved in, which sets each segment's repulsion softening
   * ({@link segmentSoftening}): `"world"` (default) keeps the flat 1e-2 on both paths; `"unit"` (a
   * segment solved in a unit disc, as the nested layout does) uses 1e-9 on the exact loop and 1e-8 on
   * the tiles.
   */
  frame?: SegmentFrame;
  /**
   * Compile the passes a multilevel seed's mass-weighted levels need (#353), so {@link GpuForceLayout.beginSeed}
   * can run a {@link SeedPlan} on this solver — the flat layout only (one segment, the world frame). The
   * mass fetch is a uniform branch the graph's own level skips, so its ticks compute what a solver without
   * this option computes; a solver without it compiles exactly the flat programs. Both repulsion paths are
   * compiled (a seed level at or below `exactMax` takes the exact loop, a larger one a tile in the atlas
   * corner). The seed's own programs (its springs, the prolongation, the leaf seed) are compiled here too,
   * so a seed compiles nothing and a failed compile fails this construction.
   */
  multilevel?: boolean;
}

/**
 * The level the solver's ticks currently run: the graph itself, or a multilevel seed level (#353). Its
 * slots are `[0, count)` of the solver's atlas (the first `rows` rows), laid out with one width.
 */
interface ActiveLevel {
  readonly count: number;
  readonly rows: number;
  /**
   * A seed level's pyramid tile (#353): `chooseGrid(count)` cells on a side in the corner (0, 0) of the
   * atlas when the level is larger than `exactMax`, else null (the exact loop). Null on the graph's level,
   * whose segments keep the tiles of their rows.
   */
  readonly seedTile: Tile | null;
  /** Per-slot masses (a seed level), or null (unit masses: the graph). */
  readonly mass: Texture | null;
  readonly springs: GpuSprings;
  readonly stab: Texture;
  readonly attraction: number;
}

/**
 * GPU-side force-directed layout. Mirrors {@link ForceLayout} semantics but runs
 * the integration step entirely on the GPU via a ping-pong compute-in-raster loop.
 *
 * Force accumulation (Tasks 2–4): each tick begins by clearing `forceTex` to zero
 * via a dedicated `forceFbo`, then each force pass draws into it with additive
 * blending (ONE, ONE) so contributions accumulate.  Finally the integrate pass reads
 * the summed force texture.  All FBOs are pre-created in the constructor — no
 * `createFramebuffer` on the hot path.
 */
export class GpuForceLayout {
  private readonly device: Device;
  private readonly count: number;
  private readonly width: number;
  private readonly height: number;
  private readonly params: ForceParams;
  private readonly integratePass: IntegratePass;
  /**
   * The springs (#350): the CSR textures, the hub chunk table and the row-gather + hub-chunk passes.
   * Every CSR entry is gathered once per tick; no fragment loops more than `SPRING_CHUNK` times (up to
   * degree `SPRING_CHUNK · HUB_CHUNK`).
   */
  private readonly springs: GpuSprings;
  /** Repulsion per segment: the tile-root traversal for tiled segments, the exact loop for the rest. */
  private readonly repulsionPass: RepulsionPass;
  private readonly centeringPass: CenteringPass;

  /**
   * The segment table — S = 1 for the flat layout: one segment `[0, count)`. Each segment's `stats`
   * `(Σx, Σy, Σ|v|, count)` feed centering and its `box` feeds its pyramid tile, both written each tick
   * by {@link reduce}; `info` and `param` hold its slots, tile, strengths and softening.
   */
  private readonly segments: SegmentTable;
  /**
   * The segment id of every slot (`r32uint`, the slot atlas), or `null` for a single segment — then
   * the id is a compile-time constant and the flat layout pays nothing for segments (spec §5.3).
   */
  private readonly slotSeg: Texture | null;
  /**
   * Contention-free segmented reduction (16-ary gather tree + range query) — replaced the two 1-px
   * point scatters (centroid, bbox) that serialised every node on one texel.
   */
  private readonly reduce: SegmentedReduce;

  /**
   * The tile-atlas grid pyramid (one regular-quadtree COM/mass tile per segment above `exactMax`), or
   * `null` when every segment is exact. Rebuilt each tick before the force pass; the repulsion pass
   * then traverses the tile of each node's segment. Pre-created in the constructor (all its textures
   * and FBOs too) so ticking allocates nothing.
   */
  private readonly pyramid: GridPyramid | null;
  /** The largest segment the exact loop solves (the resolved {@link GpuForceLayoutOptions.exactMax}). */
  private readonly exactMax: number;
  /** The flat layout's one tile (the graph's level), or null when it takes the exact loop; a seed restores it. */
  private readonly flatTile: Tile | null;

  /** The graph's own level: every node, unit masses, its own springs and stabilizers. */
  private readonly finest: ActiveLevel;
  /** The level ticks run on now: {@link finest}, or a seed level while a multilevel seed runs (#353). */
  private active: ActiveLevel;
  /** A multilevel solver's seed programs (#353), compiled with it; null on a flat solver. */
  private readonly seedPasses: SeedPasses | null;
  /** A running multilevel seed's resources, or null. */
  private seed: SeedLevels | null = null;
  /** The seed level last made current by {@link setLevel} (−1 before the first). */
  private seedLevel = -1;
  /** 1×1 `r32float` stand-in bound where a multilevel pass reads masses on the graph's level (never sampled there). */
  private readonly unit: Texture | null;
  /** One `rg32float` texel: the virtual root a seed's top level is placed about. */
  private readonly rootScratch = new Float32Array(2);

  /**
   * Maximum displacement per tick — STEP_CAP equilibrium spacings, the same {@link stepCap} the CPU
   * integrator uses — so a dense start can't fling nodes across the layout. Set once at construction.
   */
  private readonly maxStep: number;
  /** Heat schedule multiplying `alpha` (#124) — the CPU integrator's {@link Cooling}, for parity. */
  private readonly cooling = new Cooling();
  /** The force model's equilibrium spacing — the unit of the convergence test (0: no stop). */
  private readonly spacing: number;
  /**
   * The per-tick convergence stop (#376): a one-texel latch evaluated after every reduction, read by the
   * integrate pass. See `stop-latch.ts`.
   */
  private readonly stop: StopLatchPass;
  /**
   * Ticks integrated on the graph's level since construction (pass-through ticks after a stop included; a
   * multilevel seed's ticks are not counted, #353).
   */
  private ticks = 0;
  /** Ticks integrated since the heat schedule was last set — the CPU's `settleTicks`. */
  private settleTicks = 0;
  /** The heat schedule's epoch: every {@link cool} / {@link hold} starts a new one (#376). */
  private epoch = 0;
  /** The tick boundary (value of {@link ticks}) the latch last evaluated the rule at; −1 before any. */
  private latchedAt = -1;
  /**
   * Whether the latch may stop the layout (#376): the CPU loop's stop check. The streaming transport
   * turns it on in a run or a re-cool and off in a drag, as the worker checks `converged` only in those
   * modes. Off by default, so {@link runFrame} ticks like `ForceLayout.tick` (the step history is recorded
   * either way). Non-finite stats freeze the integrate whether or not it is on.
   */
  stopOnConvergence = false;

  /**
   * Position ping-pong pair. `readTex` = current positions; `writeTex` = render
   * target for the next tick's positions.
   */
  private readonly pos: ReturnType<typeof pingPong>;
  /** Velocity ping-pong pair — same structure as pos. */
  private readonly vel: ReturnType<typeof pingPong>;
  /**
   * Force accumulation texture (rg32float).  Cleared to zero at the start of
   * each tick; each force pass additively blends its per-node contribution into
   * it; the integrate pass reads it once.
   */
  private readonly forceTex: Texture;
  /**
   * Pre-created FBO wrapping `forceTex` — used only for the clear-at-tick-start
   * step (a pass opened with clear [0,0,0,0]).  Force passes render into
   * it with additive blend.  Pre-created in the constructor per the no-per-tick-
   * alloc rule.
   */
  private readonly forceFbo: Framebuffer;

  /**
   * The two MRT framebuffer configurations, pre-created once. `swap()` only ever
   * alternates between two fixed texture pairs, so there are exactly two possible
   * `[posWrite, velWrite]` attachment sets. `fbos[0]` wraps the initial write
   * textures, `fbos[1]` wraps the post-swap ones. A per-tick `parity` selects the
   * one whose attachments currently match the write side — NO `createFramebuffer`
   * on the hot path (AGENTS.md: "buffers updated in place, not recreated per frame").
   */
  private readonly fbos: readonly [Framebuffer, Framebuffer];
  /** Selects which pre-created FBO this tick writes into; flipped each tick alongside swap(). */
  private parity = 0;

  /**
   * Pre-created readback FBOs for `readPositions`. Two FBOs (one per ping-pong parity) so we can
   * read from whichever texture is currently the read side without creating a new FBO per call.
   * `readFbos[0]` wraps the A texture (initial read side); `readFbos[1]` wraps the B texture.
   * After each swap, `parity` selects which one holds the current read texture.
   */
  private readonly readFbos: readonly [Framebuffer, Framebuffer];
  /**
   * Reads the position atlas back in a format the device supports (#351): `RG/FLOAT` where that is the
   * implementation read format (ANGLE Metal), else `RGBA/FLOAT` through a `width × height × 4` scratch it
   * allocates once.
   */
  private readonly readback: PositionReadback;

  /**
   * Per-node pinned-flag texture (r8unorm, one byte per node; 255 = held, 0 = free) — the GPU
   * mirror of {@link ForceLayout}'s `pinned` array (#183 drag reheat). Sampled by the integrate
   * pass: a held node is skipped by integration (held in place, velocity zeroed) but still acts
   * on its neighbours through the force passes. Pre-created zeroed in the constructor and updated
   * by {@link setPinned} via sub-uploads (no per-tick / per-move allocation).
   */
  private readonly pinnedTex: Texture;
  /**
   * Per-node `1/(1+K̃)` spring-stiffness stabilizer texture (r32float, #203) — the GPU mirror
   * of {@link springStabilizers}. Static (degrees don't change), created once in the constructor
   * and sampled by the integrate pass; padding texels are 1 (identity).
   */
  private readonly stabTex: Texture;
  /** The currently-pinned ids (so {@link setPinned} can clear them before applying the next set). */
  private pinnedIds: Uint32Array | null = null;
  /** Scratch for a single-texel flag sub-upload (r8unorm: 255 = held, 0 = free). */
  private readonly flagScratch = new Uint8Array(1);
  /** Scratch for a single-texel (x, y) position sub-upload into the read-side position texture. */
  private readonly heldScratch = new Float32Array(2);

  constructor(
    device: Device,
    graph: LayoutGraph,
    params: ForceParams,
    options: GpuForceLayoutOptions = {},
  ) {
    this.device = device;
    this.count = graph.nodeCount;
    this.params = params;

    // Segments (flat: one) and the repulsion path of each: segments above exactMax get a pyramid tile.
    const segments = options.segments ?? flatSegments(this.count);
    validateSegments(segments, this.count);
    const singleSegment = segments.length === 1;
    // A multilevel seed (#353) runs on the flat layout's one segment, in the world frame.
    if (options.multilevel && (!singleSegment || (options.frame ?? "world") !== "world")) {
      throw new Error("GpuForceLayout: a multilevel seed runs on the flat layout (one segment, the world frame)");
    }
    // Many segments: the slot → segment map, and no spring may cross two segments (isolation). Checked
    // before the first GPU allocation, so a rejected layout leaks nothing.
    const slotSeg = singleSegment ? null : slotSegments(segments, this.count);
    if (slotSeg) assertSegmentLocalEdges(slotSeg, graph.source, graph.target, graph.edgeCount);
    const exactMax =
      options.repulsionMode === "pyramid"
        ? 0
        : options.repulsionMode === "allpairs"
          ? Infinity
          : (options.exactMax ?? GPU_REPULSION_ALLPAIRS_MAX);
    this.exactMax = exactMax;
    // A single segment keeps the flat grid (chooseGrid's floor of 16); many segments use tiles from 8.
    const atlas = packTiles(segments, exactMax, singleSegment ? FLAT_TILE_MIN_SIDE : TILE_MIN_SIDE);
    assertAtlasFits(atlas, device.limits.maxTextureDimension2D);
    this.flatTile = singleSegment ? (atlas.tiles[0] ?? null) : null;

    const width = atlasWidth(this.count);
    const height = Math.ceil(this.count / width);
    this.width = width;
    this.height = height;

    // Per-tick step clamp: STEP_CAP equilibrium spacings (shared stepCap). Only a model without a
    // spacing uses the seed span (max of the x/y extents ≈ force.ts's 2·rootHalf) instead.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < graph.nodeCount; i++) {
      const x = graph.positions[i * 2]!;
      const y = graph.positions[i * 2 + 1]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const span0 = Math.max((maxX - minX), (maxY - minY), 1);
    // The same cap on every level of a multilevel seed: mass-weighted levels share the finest equilibrium
    // scale (spec §8).
    this.spacing = equilibriumSpacing(params);
    this.maxStep = stepCap(this.spacing, span0);

    // Build padded position data (same layout as packPositionsTexture) and seed
    // the position read (A) side with it. Velocity starts zeroed (no seed).
    const posData = new Float32Array(width * height * 2);
    posData.set(graph.positions);
    this.pos = pingPong(device, width, height, posData);
    this.vel = pingPong(device, width, height);

    // Pre-create readback FBOs: one per parity so readPositions never allocates per call.
    // readFbos[0] wraps the A texture (readTex before any swap); readFbos[1] wraps B.
    const makeReadFbo = (): Framebuffer =>
      device.createFramebuffer({ width, height, colorAttachments: [this.pos.readTex] });
    const readFbo0 = makeReadFbo();
    this.pos.swap();
    const readFbo1 = makeReadFbo();
    this.pos.swap(); // restore to initial state
    this.readFbos = [readFbo0, readFbo1];
    this.readback = new PositionReadback(device, width, height);

    // Force accumulation texture — cleared each tick, written by force passes.
    this.forceTex = device.createTexture({
      width,
      height,
      format: "rg32float",
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });

    // Pre-create the FBO wrapping forceTex for the per-tick clear step.
    this.forceFbo = device.createFramebuffer({
      width,
      height,
      colorAttachments: [this.forceTex],
    });

    // Per-node pinned-flag texture (#183), seeded all-zero (nothing held). Updated by setPinned
    // via 1×1 writeData sub-uploads — never reallocated, so the no-per-tick-alloc spies stay green.
    this.pinnedTex = device.createTexture({
      width,
      height,
      format: "r8unorm",
      data: new Uint8Array(width * height),
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });

    // Per-node spring-stiffness stabilizer (#203): 1/(1+K̃) with K̃ = damping·α·attraction·degree,
    // computed ONCE from the edge list (degrees are static) and sampled by the integrate pass so a
    // high-degree hub's aggregate spring can never turn the integration oscillatory-unstable.
    // Identical math to the CPU ForceLayout (springStabilizers) — keeps backend parity, including the
    // weighted degree of a layout with spring weights (the springs honour them, #350).
    const stab = springStabilizers(graph.nodeCount, graph.source, graph.target, graph.edgeCount, params, undefined, graph.springWeight);
    const stabPadded = new Float32Array(width * height).fill(1);
    stabPadded.set(stab);
    this.stabTex = device.createTexture({
      width,
      height,
      format: "r32float",
      data: stabPadded,
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });

    // Pre-create BOTH MRT framebuffer configurations once. fbos[0] wraps the
    // initial write textures; swap both ping-pongs and fbos[1] wraps the other
    // pair; swap back to restore the initial read/write orientation. At any tick
    // the read textures are the ones NOT attached to fbos[parity], so there is no
    // read/write hazard.
    const makeFbo = (): Framebuffer =>
      device.createFramebuffer({
        width,
        height,
        colorAttachments: [this.pos.writeTex, this.vel.writeTex],
      });
    const fbo0 = makeFbo();
    this.pos.swap();
    this.vel.swap();
    const fbo1 = makeFbo();
    this.pos.swap();
    this.vel.swap();
    this.fbos = [fbo0, fbo1];

    // Many segments: the slot → segment texture (the map was built and checked above).
    if (!slotSeg) {
      this.slotSeg = null;
    } else {
      const padded = new Uint32Array(width * height);
      padded.set(slotSeg);
      this.slotSeg = device.createTexture({
        width,
        height,
        format: "r32uint",
        data: padded,
        mipLevels: 1,
        sampler: { minFilter: "nearest", magFilter: "nearest" },
      });
    }

    // Springs: symmetric CSR + hub chunk table, uploaded ONCE here and reused every tick (#350).
    this.springs = new GpuSprings(device, graph);

    // Segment table + its reduction: every texture, FBO and model created here, once — ticking
    // allocates nothing (the createFramebuffer / createTexture spy tests stay green). Each segment's
    // softening follows its path and frame (flat: the absolute 1e-2 of quadtree.ts on both paths).
    const frame = options.frame ?? "world";
    const rows: SegmentRow[] = segments.map((seg, s) => {
      const tile = atlas.tiles[s] ?? null;
      return {
        ...seg,
        tile,
        param: {
          repulsion: params.repulsion,
          centering: params.centering,
          softening: segmentSoftening(frame, tile === null),
          alpha0: 1,
        },
      };
    });
    this.segments = new SegmentTable(device, rows);
    // A multilevel solver (#353) compiles the mass-reading passes with a uniform branch; the stand-in is
    // what they bind on the graph's own level, where the branch never samples it.
    this.unit = options.multilevel
      ? device.createTexture({ width: 1, height: 1, format: "r32float", data: new Float32Array([1]), mipLevels: 1, sampler: { minFilter: "nearest", magFilter: "nearest" } })
      : null;
    const multilevel = this.unit ? { unit: this.unit } : undefined;
    this.reduce = new SegmentedReduce(device, this.count, multilevel ? { multilevel } : {});

    // The tile pyramid, only when some segment has a tile. Pre-created in the constructor (all its
    // textures + FBOs) so no per-tick allocation. A multilevel one (#353) scatters a seed level's masses and
    // builds its smaller tile in the atlas corner.
    this.pyramid = atlas.levels.length > 0 ? new GridPyramid(device, atlas, singleSegment, multilevel ? { multilevel } : {}) : null;

    this.integratePass = new IntegratePass(device);
    // Compiled for exactly the paths this layout's segments take (the flat layout: one of the two),
    // with the traversal stack sized by the pyramid's level count. A multilevel solver (#353) compiles both:
    // a seed level at or below exactMax takes the exact loop (mass-weighted), a larger one its tile.
    this.repulsionPass = new RepulsionPass(
      device,
      {
        singleSegment,
        levelCount: atlas.levels.length,
        exact: atlas.levels.length === 0 || multilevel !== undefined || rows.some((row) => row.tile === null && row.count > 0),
        multilevel: multilevel !== undefined,
      },
      multilevel ? { multilevel } : {},
    );
    this.centeringPass = new CenteringPass(device, singleSegment);
    this.stop = new StopLatchPass(device);
    this.seedPasses = multilevel ? new SeedPasses(device) : null;

    this.finest = {
      count: this.count,
      rows: this.height,
      seedTile: null,
      mass: null,
      springs: this.springs,
      stab: this.stabTex,
      attraction: params.attraction,
    };
    this.active = this.finest;
  }

  /**
   * A seed level's pyramid tile (#353): above `exactMax`, `chooseGrid(count)` cells on a side at the atlas
   * corner — inside the flat tile, which a level smaller than the graph never outgrows — else null.
   */
  private seedTileFor(count: number): Tile | null {
    return count > this.exactMax ? { x: 0, y: 0, side: tileSide(count, FLAT_TILE_MIN_SIDE) } : null;
  }

  /** A scissor over the active level's rows, or undefined when the level fills the atlas. */
  private levelScissor(): PassViewport | undefined {
    return this.active.rows < this.height ? [0, 0, this.width, this.active.rows] : undefined;
  }

  /**
   * Cool from heat `from` over `ticks` ticks — the CPU {@link ForceLayout.cool} schedule. Starts a new
   * schedule: its first `MIN_SETTLE_TICKS` ticks cannot stop, and a stop of the previous one is
   * released (#376).
   */
  cool(ticks: number, from = 1): void {
    this.cooling.cool(ticks, from);
    this.newSchedule();
  }

  /** Hold a constant heat — a drag reflow (the CPU {@link ForceLayout.hold}). Starts a new schedule, as {@link cool}. */
  hold(heat: number): void {
    this.cooling.hold(heat);
    this.newSchedule();
  }

  private newSchedule(): void {
    this.settleTicks = 0;
    this.epoch++;
  }

  /** The current heat schedule's epoch — what a harvested stop must carry to belong to it (#376). */
  get scheduleEpoch(): number {
    return this.epoch;
  }

  /**
   * Execute `ticks` whole ticks on the GPU — each is the three work items {@link beginTick},
   * {@link forceBand}`(0, 1)` and {@link integrate}. A convenience for tests and one-off solves; the
   * streaming transport encodes the items itself, a budgeted number per frame (#352).
   */
  runFrame(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      this.beginTick();
      this.forceBand(0, 1);
      this.integrate();
    }
  }

  /** Rows of the position atlas. */
  get atlasRows(): number {
    return this.height;
  }

  /** Nodes this layout solves (every one, whatever the LOD state). */
  get nodeCount(): number {
    return this.count;
  }

  /** Slots of the level ticks run on now: every node, or a seed level's slots while a seed runs (#353). */
  get levelSlots(): number {
    return this.active.count;
  }

  /** Atlas rows of the level ticks run on now — the domain {@link forceBand} cuts into bands. */
  get levelRows(): number {
    return this.active.rows;
  }

  // ── The multilevel seed (#353, spec §6.4) ──────────────────────────────────

  /** Whether a multilevel seed is running (between {@link beginSeed} and {@link endSeed}). */
  get seeding(): boolean {
    return this.seed !== null;
  }

  /**
   * Start running `plan` on this solver (built with `multilevel`): create the seed's textures, sized to its
   * largest level — the only allocation of the whole seed, and no program: those were compiled with the
   * solver — and write its virtual root into slot 0 of the positions, which the top level is placed about.
   * Then {@link setLevel} each level in order, tick it (its `ticks`), and {@link endSeed} places the graph's
   * nodes. Nothing is read back. If it throws, the solver is as it was: no seed, its positions untouched.
   */
  beginSeed(plan: SeedPlan): void {
    if (!this.unit || !this.seedPasses) throw new Error("GpuForceLayout.beginSeed: build the solver with { multilevel: true }");
    if (this.seed) throw new Error("GpuForceLayout.beginSeed: a seed is already running");
    if (plan.nodeCount !== this.count) throw new Error("GpuForceLayout.beginSeed: the plan is for another graph");
    // A level's tile (seedTileFor) lies inside the flat tile only while the level is no larger than the graph.
    if (plan.levels.some((level) => level.count > this.count)) throw new Error("GpuForceLayout.beginSeed: a seed level is larger than the graph");
    this.seed = new SeedLevels(this.device, plan, this.width, this.height, this.seedPasses);
    this.seedLevel = -1;
    this.rootScratch[0] = plan.root[0];
    this.rootScratch[1] = plan.root[1];
    this.pos.readTex.writeData(this.rootScratch, { x: 0, y: 0, width: 1, height: 1 });
  }

  /**
   * Make seed level `k` (the next one, in plan order) the level ticks run on: move the previous level's
   * terminal leaves to the leaf seed, upload the level (sub-uploads into the seed's textures), prolongate it
   * from the level above — positions and **zero velocities** by MRT, then swap — point the segment at its
   * slots, and cool over its ticks. The pinned mask stays all-zero (a drag's pins wait for the graph's
   * level), and the stabilizers are the level's. Allocates nothing.
   */
  setLevel(k: number): void {
    const seed = this.seed;
    if (!seed) throw new Error("GpuForceLayout.setLevel: no seed is running");
    const level = seed.plan.levels[k];
    if (!level || k !== this.seedLevel + 1) throw new Error(`GpuForceLayout.setLevel: level ${k} is not next`);
    if (k > 0) seed.scatterLeaves(k - 1, this.pos.readTex);
    seed.upload(k, this.forceTex);
    const rows = Math.max(1, Math.ceil(level.count / this.width));
    this.prolongateInto(level.count, rows < this.height ? [0, 0, this.width, rows] : undefined);
    this.seedLevel = k;
    const seedTile = this.seedTileFor(level.count);
    this.active = {
      count: level.count,
      rows,
      seedTile,
      mass: seed.mass,
      springs: seed.springs,
      stab: seed.stab,
      attraction: seed.plan.attraction,
    };
    this.segments.setRange(0, { start: 0, count: level.count }, seedTile);
    this.cooling.cool(level.ticks);
  }

  /**
   * Finish the seed after its last level: move that level's leaves to the leaf seed, place the graph's nodes
   * (a prolongation from the last level, or the leaf seed's gather), zero their velocities, make the graph's
   * level current again and free the seed's resources. The heat is left at full: the caller cools the run.
   */
  endSeed(): void {
    const seed = this.seed;
    if (!seed) throw new Error("GpuForceLayout.endSeed: no seed is running");
    if (this.seedLevel !== seed.plan.levels.length - 1) throw new Error("GpuForceLayout.endSeed: levels are left");
    seed.scatterLeaves(this.seedLevel, this.pos.readTex);
    if (seed.uploadFinest(this.forceTex)) {
      this.prolongateInto(this.count, undefined);
    } else {
      const pass = beginPass(this.device, { framebuffer: this.writeFramebuffer, clear: false });
      seed.gatherLeaves(pass);
      pass.end();
      this.device.submit();
      this.pos.swap();
      this.vel.swap();
      this.parity ^= 1;
    }
    this.active = this.finest;
    this.segments.setRange(0, { start: 0, count: this.count }, this.flatTile);
    this.cooling.hold(1);
    seed.destroy();
    this.seed = null;
    this.seedLevel = -1;
  }

  /**
   * Abandon a running seed (a failed seed step): free its resources and make the graph's level current
   * again. The slots keep the seed level they held, not the graph's nodes, so the solver must not tick or be
   * read again: its caller keeps what it last harvested and destroys the solver.
   */
  cancelSeed(): void {
    const seed = this.seed;
    if (!seed) return;
    this.active = this.finest;
    this.segments.setRange(0, { start: 0, count: this.count }, this.flatTile);
    seed.destroy();
    this.seed = null;
    this.seedLevel = -1;
  }

  /**
   * Run a whole plan synchronously: {@link beginSeed}, each level's {@link setLevel} and ticks, then
   * {@link endSeed}. A convenience for tests and one-off seeds; the streaming transport encodes the same
   * steps as work items within its frame budget.
   */
  runSeed(plan: SeedPlan): void {
    this.beginSeed(plan);
    plan.levels.forEach((level, k) => {
      this.setLevel(k);
      this.runFrame(level.ticks);
    });
    this.endSeed();
  }

  /** The prolongation of the current seed placement into the write side (positions + zero velocities), then swap. */
  private prolongateInto(count: number, scissor: PassViewport | undefined): void {
    const seed = this.seed;
    if (!seed) throw new Error("GpuForceLayout: no seed is running");
    const pass = beginPass(this.device, { framebuffer: this.writeFramebuffer, clear: false, ...(scissor ? { scissor } : {}) });
    seed.prolongate.run(pass, {
      parentPosTex: this.pos.readTex,
      parentSlotTex: seed.parent,
      offsetTex: this.forceTex,
      count,
      width: this.width,
    });
    pass.end();
    this.device.submit();
    this.pos.swap();
    this.vel.swap();
    this.parity ^= 1;
  }

  /**
   * Work item **P** of a tick (#352, spec §6.5.3): everything the force pass reads, computed from the
   * current positions — the segment reductions and the stop latch over them (#376), the Barnes-Hut
   * pyramid, the hub chunk partials — and the clear of the force accumulator. Each part is its own
   * submitted render pass, as before the split.
   */
  beginTick(): void {
    // ── 1. Segment reductions ─────────────────────────────────────────────────
    // Gather tree over slot order + one range query for the flat segment: writes the segment
    // table's stats (Σx, Σy, Σ|v|, count → the centroid for centering) and box (maxX, maxY, −minX,
    // −minY → the pyramid's cell geometry). No blending: contention-free and deterministic. Its
    // passes submit internally, so the pyramid and force passes below see the results.
    this.reduceSegments();

    // ── 1b. Build the tile pyramid (only when some segment has a tile) ──────
    // Rebuilds every segment's regular-quadtree COM/mass tile over the current positions — or a seed
    // level's tile in the atlas corner, mass-weighted (#353). Runs its own render passes and submits
    // internally, so it completes before the force pass below reads the pyramid. Skipped entirely when
    // every segment (or the seed level) takes the exact loop.
    const level = this.active;
    if (level === this.finest) {
      this.pyramid?.build({
        posTex: this.pos.readTex,
        width: this.width,
        count: this.count,
        segments: this.segments,
        slotSeg: this.slotSeg,
      });
    } else if (level.seedTile) {
      this.pyramid?.build({
        posTex: this.pos.readTex,
        width: this.width,
        count: level.count,
        segments: this.segments,
        slotSeg: this.slotSeg,
        grid: level.seedTile.side,
        mass: level.mass,
      });
    }

    // ── 1c. Hub spring chunks (#350) ─────────────────────────────────────────
    // Sums every chunk of a row longer than SPRING_CHUNK into its partial — its own render pass into a
    // different framebuffer, submitted before the force pass gathers the partials. No-op without hubs.
    level.springs.prepare(this.pos.readTex, this.width);

    // ── 2. Clear the force texture to zero ────────────────────────────────────
    // Its own pass (the whole attachment, or a seed level's rows), so the force bands after it can each
    // open the target with `clear: false` and write only their rows.
    const scissor = this.levelScissor();
    const clear = beginPass(this.device, { framebuffer: this.forceFbo, clear: [0, 0, 0, 0], ...(scissor ? { scissor } : {}) });
    clear.end();
    this.device.submit();
  }

  /**
   * Work item **F_b**: the force pass over atlas rows {@link bandRows}`(band, bands)` — springs, then
   * repulsion, then centering, additively blended into the force texture (a scissor over the band's
   * rows; the viewport and the slot ↔ texel mapping stay the whole atlas). Positions change only in
   * {@link integrate}, so every band reads the same positions and pyramid, the bands write disjoint
   * texels, and each texel receives its three contributions in the same order for any `bands`: the tick
   * is bitwise independent of how it was sliced. `bands = 1` is the whole atlas without a scissor.
   */
  forceBand(band: number, bands: number): void {
    const level = this.active;
    const [r0, r1] = bandRows(band, bands, level.rows);
    if (r1 <= r0) return;
    const forcePass = beginPass(this.device, {
      framebuffer: this.forceFbo,
      clear: false,
      ...(bands > 1 || level.rows < this.height ? { scissor: [0, r0, this.width, r1 - r0] } : {}),
    });

    // Fixed order — springs, repulsion, centering. Float addition is not associative, so the ADD
    // blend makes the force bits depend on pass order; keep it stable.

    // Attraction (spring gather over CSR rows, plus each hub row's chunk partials; a seed level's rows
    // are weighted and divided by the slot's mass).
    level.springs.draw(forcePass, this.pos.readTex, {
      count: level.count,
      width: this.width,
      attraction: level.attraction,
    }, level.mass);

    // Repulsion within each node's segment: the exact loop at/below exactMax (the parity baseline),
    // the Barnes-Hut traversal of the segment's tile above it. Additive-blended into forceTex. On a seed
    // level (#353) the segment's row names the level's tile or the exact loop, and node j repels by its mass.
    this.repulsionPass.run(forcePass, {
      posTex: this.pos.readTex,
      count: level.count,
      width: this.width,
      theta: this.params.theta,
      segments: this.segments,
      pyramid: this.pyramid,
      slotSeg: this.slotSeg,
      mass: level.mass,
    });

    // Centering: pull every node toward its segment's centroid (the reduction's stats above — mass-weighted
    // on a seed level) with the segment's centering strength.
    this.centeringPass.run(forcePass, this.pos.readTex, this.segments, {
      count: level.count,
      width: this.width,
    }, this.slotSeg);

    forcePass.end();
    this.device.submit();
  }

  /**
   * Work item **I**: integrate the accumulated force into positions and velocities (MRT), swap the
   * ping-pongs, and advance the heat schedule — the only item that changes positions. Once the stop latch
   * has latched in the current schedule (or the layout went non-finite) the integrate passes positions
   * and velocities through unchanged (#376).
   */
  integrate(): void {
    // Select the pre-created MRT framebuffer whose attachments are the current
    // write textures — no per-tick createFramebuffer.
    const fbo = this.writeFramebuffer;

    // Don't clear — every texel is written by the shader (padded texels get
    // vec2(0) from the `id >= u_count` branch). A seed level writes only its rows.
    const scissor = this.levelScissor();
    const renderPass = beginPass(this.device, { framebuffer: fbo, clear: false, ...(scissor ? { scissor } : {}) });

    const level = this.active;
    this.integratePass.run(renderPass, this.pos.readTex, this.vel.readTex, this.forceTex, this.pinnedTex, level.stab, this.stop.state, {
      count: level.count,
      width: this.width,
      alpha: this.params.alpha * this.cooling.heat, // the cooled step (#124), as on the CPU
      damping: DAMPING,
      maxStep: this.maxStep, // STEP_CAP equilibrium spacings — see constructor
      epoch: this.epoch, // a stop latched in this schedule freezes the integrate (#376)
    });

    renderPass.end();
    this.device.submit();

    // Swap both ping-pongs so the freshly-written textures become the read
    // sources for the next tick, and flip parity so the next tick writes into
    // the OTHER pre-created FBO (which wraps those next write textures).
    this.pos.swap();
    this.vel.swap();
    this.parity ^= 1;
    this.cooling.next();
    if (this.seed) return; // a seed level's tick is not one of the run's (see reduceSegments)
    this.ticks++;
    this.settleTicks++;
  }

  /**
   * Set the held (pinned) node set for an interactive drag (#183), replacing any previous one — the
   * GPU mirror of {@link ForceLayout.setPinned}. Held nodes are skipped by integration (see the
   * integrate FS) so the drag session can keep them under the cursor while the rest reflows. Pass
   * `null` (or an empty array) to release every pin. Sub-uploads only the changed flag texels
   * (O(prev) clear + O(new) set — the held set is the dragged nodes), never reallocating the texture.
   */
  setPinned(ids: Uint32Array | null): void {
    if (this.seed) throw new Error("GpuForceLayout.setPinned: pins wait for the graph's level (a seed is running)");
    const prev = this.pinnedIds;
    if (prev) for (let k = 0; k < prev.length; k++) this.writeFlag(prev[k]!, false);
    this.pinnedIds = ids && ids.length > 0 ? ids : null;
    const next = this.pinnedIds;
    if (next) for (let k = 0; k < next.length; k++) this.writeFlag(next[k]!, true);
  }

  /**
   * Write the held nodes' positions into the current read-side position texture (#183) so they sit
   * exactly where the drag put them; the integrate pass then copies each held texel forward each tick
   * (o_pos = p) so it stays put while neighbours reflow. `ids`/`positions` are parallel: node `ids[k]`
   * gets `(positions[2k], positions[2k+1])`. Sub-uploads one texel per held node (O(held)).
   */
  setHeldPositions(ids: Uint32Array, positions: Float32Array): void {
    if (this.seed) throw new Error("GpuForceLayout.setHeldPositions: held nodes wait for the graph's level (a seed is running)");
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k]!;
      if (id < 0 || id >= this.count) continue;
      this.heldScratch[0] = positions[k * 2]!;
      this.heldScratch[1] = positions[k * 2 + 1]!;
      this.pos.readTex.writeData(this.heldScratch, { x: id % this.width, y: (id / this.width) | 0, width: 1, height: 1 });
    }
  }

  /** Set one node's pinned-flag texel (255 = held, 0 = free) via a 1×1 sub-upload. */
  private writeFlag(id: number, on: boolean): void {
    if (id < 0 || id >= this.count) return;
    this.flagScratch[0] = on ? 255 : 0;
    this.pinnedTex.writeData(this.flagScratch, { x: id % this.width, y: (id / this.width) | 0, width: 1, height: 1 });
  }

  /** The current read-side position texture (what a readback copies). Read-only handle — do not write it directly. */
  get positionTexture(): Texture {
    return this.pos.readTex;
  }

  /** This layout's position-atlas width. */
  get positionWidth(): number {
    return this.width;
  }

  /** The pre-created MRT framebuffer `[position, velocity]` of the current write side. */
  private get writeFramebuffer(): Framebuffer {
    return this.parity === 0 ? this.fbos[0] : this.fbos[1];
  }

  /**
   * The pre-created framebuffer holding the current positions (the read side) — what a readback copies.
   * It changes with every {@link integrate}, so read it at copy time, never cache it.
   */
  get positionFramebuffer(): Framebuffer {
    return this.parity === 0 ? this.readFbos[0] : this.readFbos[1];
  }

  /**
   * The segment table's `stats` and `box` textures (1×1 each for the flat layout): the last reductions'
   * `(Σx, Σy, Σ|v|, count)` and `(maxX, maxY, −minX, −minY)` — from {@link beginTick} or
   * {@link refreshSegmentStats} — which the streaming readback copies with the positions to catch a
   * non-finite layout (#352).
   */
  get segmentStats(): { readonly stats: Texture; readonly box: Texture } {
    return this.segments;
  }

  /**
   * Re-run the segment reductions over the current positions, so {@link segmentStats} describe them
   * (#352): after an {@link integrate} they still describe the positions before it, and the streaming
   * readback's finiteness check must cover the positions it copies. **Between ticks only** — after an
   * `integrate`, before the next {@link beginTick}, which recomputes the same values from the same
   * positions. Mid-tick it would change the box and centroid the remaining force bands read. Costs the
   * reduction tree: a few gather passes over N / 15 texels (0.46 ms at 325k on an M1 Max). The stop latch
   * evaluates the tick just integrated here, as the next `beginTick` would have (#376), so the copy
   * carries the stop as soon as there is one.
   */
  refreshSegmentStats(): void {
    this.reduceSegments();
  }

  /**
   * The segment reductions, then the stop latch over their stats (#376). The latch evaluates the rule only
   * at the first reduction after an integrate: a copy between ticks and the next tick's prep both reduce,
   * with the same velocities, so the stop does not depend on whether a copy happened.
   */
  private reduceSegments(): void {
    const level = this.active;
    this.reduce.run(
      { pos: this.pos.readTex, vel: this.vel.readTex, posWidth: this.width, count: level.count, mass: level.mass },
      this.segments,
    );
    // A multilevel seed level (#353) is not the run: its stats are mass-weighted (`w` is Σm, not its slots)
    // and its ticks are the seed's. The latch reads the graph's level only, from the run's first tick, as the
    // CPU refine checks `converged` only after its seed.
    if (this.seed) return;
    const evaluate = this.latchedAt !== this.ticks;
    this.latchedAt = this.ticks;
    this.stop.run(this.segments.stats, {
      evaluate,
      sample: this.ticks > 0,
      armed: this.stopOnConvergence && stopArmed(this.spacing, this.settleTicks),
      threshold: CONVERGED_STEP * this.spacing,
      tick: this.ticks,
      epoch: this.epoch,
    });
  }

  /**
   * The stop latch's current texel `(prevStep, stopTick, epoch, flags)` (#376), from the last reduction —
   * what the streaming readback copies with the stats. See `stop-latch.ts`.
   */
  get stopState(): Texture {
    return this.stop.state;
  }

  /**
   * Read the stop latch's current texel synchronously into `out[0..4)` — `(prevStep, stopTick, epoch,
   * flags)`. For tests and one-off reads, like {@link readPositions}; the streaming transport reads it with
   * the stats through its PBO.
   */
  readStopState(out: Float32Array): void {
    this.stop.read(out);
  }

  /**
   * Read the current positions back to the CPU — synchronously, for tests and one-off reads; the
   * streaming transport never calls it (it reads through a fenced PBO, #352).
   * Writes `2 · slots` floats into `out` starting at index 0: every node, or a seed level's slots while a
   * seed runs.
   */
  readPositions(out: Float32Array): void {
    // Reuse the pre-created readback FBO for the current read-side texture (no per-call alloc).
    this.readback.read(this.positionFramebuffer, this.active.count, out);
  }

  /**
   * Read back the per-slot force the last tick accumulated (springs + repulsion + centering, before
   * integration) — `2 · slots` floats into `out`, as {@link readPositions}. A synchronous read for tests
   * and one-off checks; never on the streaming path. The force is a function of the positions that tick
   * started from, which is what the flat-equivalence contract compares.
   */
  readForces(out: Float32Array): void {
    this.readback.read(this.forceFbo, this.active.count, out);
  }

  destroy(): void {
    this.seed?.destroy();
    this.seed = null;
    this.seedPasses?.destroy();
    this.unit?.destroy();
    this.pos.destroy();
    this.vel.destroy();
    this.forceTex.destroy();
    this.forceFbo.destroy();
    this.pinnedTex.destroy();
    this.stabTex.destroy();
    this.slotSeg?.destroy();
    this.segments.destroy();
    this.reduce.destroy();
    this.fbos[0].destroy();
    this.fbos[1].destroy();
    this.readFbos[0].destroy();
    this.readFbos[1].destroy();
    this.springs.destroy();
    this.integratePass.destroy();
    this.repulsionPass.destroy();
    this.centeringPass.destroy();
    this.pyramid?.destroy();
    this.stop.destroy();
  }
}
