import type { Device, Texture, Framebuffer, RenderPass } from "@luma.gl/core";
import type { ForceParams, LayoutGraph } from "../force.js";
import { Cooling, DAMPING, equilibriumSpacing, springStabilizers, stepCap } from "../force.js";
import { atlasWidth, pingPong } from "./textures.js";
import { PositionReadback } from "./position-readback.js";
import { IntegratePass } from "./passes/integrate.js";
import { GpuSprings } from "./springs.js";
import { RepulsionPass } from "./passes/repulsion.js";
import { GridPyramid } from "./passes/grid-pyramid.js";
import { CenteringPass } from "./passes/centering.js";
import { beginPass } from "./passes/fullscreen.js";
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
  validateSegments,
  type SegmentFrame,
  type SlotRange,
} from "./segments.js";

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
   * 4096); the nested layout uses 32, the CPU `EXACT_MAX`.
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
   * Override the per-tick displacement clamp (world units). By default it is STEP_CAP equilibrium
   * spacings ({@link stepCap}, shared with the CPU integrator); only a model without an equilibrium
   * spacing falls back to 4× the seed positions' bounding box. The multilevel seed (N8.2) seeds each
   * level's position texture on the **GPU** (prolongation) *after* construction, so it passes its
   * level's cap explicitly rather than relying on that bbox fallback. @see {@link seedFromProlongation}
   */
  maxStep?: number;
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

  /**
   * Maximum displacement per tick — STEP_CAP equilibrium spacings, the same {@link stepCap} the CPU
   * integrator uses — so a dense start can't fling nodes across the layout. Set once at construction.
   */
  private readonly maxStep: number;
  /** Heat schedule multiplying `alpha` (#124) — the CPU integrator's {@link Cooling}, for parity. */
  private readonly cooling = new Cooling();

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
    // A single segment keeps the flat grid (chooseGrid's floor of 16); many segments use tiles from 8.
    const atlas = packTiles(segments, exactMax, singleSegment ? FLAT_TILE_MIN_SIDE : TILE_MIN_SIDE);
    assertAtlasFits(atlas, device.limits.maxTextureDimension2D);

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
    // Explicit override (multilevel seed: positions are GPU-seeded after construction, so the CPU
    // bbox above is meaningless — the caller passes its level's cap instead).
    this.maxStep = options.maxStep ?? stepCap(equilibriumSpacing(params), span0);

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
    this.reduce = new SegmentedReduce(device, this.count);

    // The tile pyramid, only when some segment has a tile. Pre-created in the constructor (all its
    // textures + FBOs) so no per-tick allocation.
    this.pyramid = atlas.levels.length > 0 ? new GridPyramid(device, atlas, singleSegment) : null;

    this.integratePass = new IntegratePass(device);
    // Compiled for exactly the paths this layout's segments take (the flat layout: one of the two),
    // with the traversal stack sized by the pyramid's level count.
    this.repulsionPass = new RepulsionPass(device, {
      singleSegment,
      levelCount: atlas.levels.length,
      exact: atlas.levels.length === 0 || rows.some((row) => row.tile === null && row.count > 0),
    });
    this.centeringPass = new CenteringPass(device, singleSegment);
  }

  /** Cool from heat `from` over `ticks` ticks — the CPU {@link ForceLayout.cool} schedule. */
  cool(ticks: number, from = 1): void {
    this.cooling.cool(ticks, from);
  }

  /** Hold a constant heat — a drag reflow (the CPU {@link ForceLayout.hold}). */
  hold(heat: number): void {
    this.cooling.hold(heat);
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

  /** Rows of the position atlas — the domain {@link forceBand} cuts into bands. */
  get atlasRows(): number {
    return this.height;
  }

  /** Nodes this layout solves (every one, whatever the LOD state). */
  get nodeCount(): number {
    return this.count;
  }

  /**
   * Work item **P** of a tick (#352, spec §6.5.3): everything the force pass reads, computed from the
   * current positions — the segment reductions, the Barnes-Hut pyramid, the hub chunk partials — and the
   * clear of the force accumulator. Each part is its own submitted render pass, as before the split.
   */
  beginTick(): void {
    // ── 1. Segment reductions ─────────────────────────────────────────────────
    // Gather tree over slot order + one range query for the flat segment: writes the segment
    // table's stats (Σx, Σy, Σ|v|, count → the centroid for centering) and box (maxX, maxY, −minX,
    // −minY → the pyramid's cell geometry). No blending: contention-free and deterministic. Its
    // passes submit internally, so the pyramid and force passes below see the results.
    this.reduceSegments();

    // ── 1b. Build the tile pyramid (only when some segment has a tile) ──────
    // Rebuilds every segment's regular-quadtree COM/mass tile over the current positions.
    // Runs its own render passes and submits internally, so it completes before the force pass below
    // reads the pyramid. Skipped entirely when every segment takes the exact loop.
    this.pyramid?.build({
      posTex: this.pos.readTex,
      width: this.width,
      count: this.count,
      segments: this.segments,
      slotSeg: this.slotSeg,
    });

    // ── 1c. Hub spring chunks (#350) ─────────────────────────────────────────
    // Sums every chunk of a row longer than SPRING_CHUNK into its partial — its own render pass into a
    // different framebuffer, submitted before the force pass gathers the partials. No-op without hubs.
    this.springs.prepare(this.pos.readTex, this.width);

    // ── 2. Clear the force texture to zero ────────────────────────────────────
    // Its own pass (the whole attachment), so the force bands after it can each open the target with
    // `clear: false` and write only their rows.
    const clear = beginPass(this.device, { framebuffer: this.forceFbo, clear: [0, 0, 0, 0] });
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
    const [r0, r1] = bandRows(band, bands, this.height);
    if (r1 <= r0) return;
    const forcePass = beginPass(this.device, {
      framebuffer: this.forceFbo,
      clear: false,
      ...(bands > 1 ? { scissor: [0, r0, this.width, r1 - r0] } : {}),
    });

    // Fixed order — springs, repulsion, centering. Float addition is not associative, so the ADD
    // blend makes the force bits depend on pass order; keep it stable.

    // Attraction (spring gather over CSR rows, plus each hub row's chunk partials).
    this.springs.draw(forcePass, this.pos.readTex, {
      count: this.count,
      width: this.width,
      attraction: this.params.attraction,
    });

    // Repulsion within each node's segment: the exact loop at/below exactMax (the parity baseline),
    // the Barnes-Hut traversal of the segment's tile above it. Additive-blended into forceTex.
    this.repulsionPass.run(forcePass, {
      posTex: this.pos.readTex,
      count: this.count,
      width: this.width,
      theta: this.params.theta,
      segments: this.segments,
      pyramid: this.pyramid,
      slotSeg: this.slotSeg,
    });

    // Centering: pull every node toward its segment's centroid (the reduction's stats above) with
    // the segment's centering strength.
    this.centeringPass.run(forcePass, this.pos.readTex, this.segments, {
      count: this.count,
      width: this.width,
    }, this.slotSeg);

    forcePass.end();
    this.device.submit();
  }

  /**
   * Work item **I**: integrate the accumulated force into positions and velocities (MRT), swap the
   * ping-pongs, and advance the heat schedule — the only item that changes positions.
   */
  integrate(): void {
    // Select the pre-created MRT framebuffer whose attachments are the current
    // write textures — no per-tick createFramebuffer.
    const fbo = this.fbos[this.parity]!;

    // Don't clear — every texel is written by the shader (padded texels get
    // vec2(0) from the `id >= u_count` branch).
    const renderPass = beginPass(this.device, { framebuffer: fbo, clear: false });

    this.integratePass.run(renderPass, this.pos.readTex, this.vel.readTex, this.forceTex, this.pinnedTex, this.stabTex, {
      count: this.count,
      width: this.width,
      alpha: this.params.alpha * this.cooling.heat, // the cooled step (#124), as on the CPU
      damping: DAMPING,
      maxStep: this.maxStep, // STEP_CAP equilibrium spacings — see constructor
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
  }

  /**
   * Set the held (pinned) node set for an interactive drag (#183), replacing any previous one — the
   * GPU mirror of {@link ForceLayout.setPinned}. Held nodes are skipped by integration (see the
   * integrate FS) so the drag session can keep them under the cursor while the rest reflows. Pass
   * `null` (or an empty array) to release every pin. Sub-uploads only the changed flag texels
   * (O(prev) clear + O(new) set — the held set is the dragged nodes), never reallocating the texture.
   */
  setPinned(ids: Uint32Array | null): void {
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

  /**
   * The current read-side position texture (N8.2 multilevel seed). The next finer level's
   * prolongation gather samples this by parent slot. Read-only handle — do not write it directly.
   */
  get positionTexture(): Texture {
    return this.pos.readTex;
  }

  /** This layout's position-atlas width (N8.2), so a prolongation from it maps a parent slot → texel. */
  get positionWidth(): number {
    return this.width;
  }

  /**
   * Seed this layout's positions from a coarser level via a single GPU {@link ProlongatePass} gather
   * (N8.2), overwriting the constructor's CPU seed. Renders into the read-side position texture (the
   * one the first tick reads), so a subsequent {@link runFrame} refines from the prolongated seed.
   * O(this level's size), no CPU per-node loop. `run` is a closure the caller supplies so this class
   * needn't import the pass type; it draws into the freshly-opened render pass.
   */
  seedFromProlongation(run: (pass: RenderPass) => void): void {
    // readFbos[0] wraps the current read-side position texture (A, parity 0 at construction), so
    // writing it here seeds exactly what the next tick reads.
    const pass = beginPass(this.device, { framebuffer: this.readFbos[0], clear: false });
    run(pass);
    pass.end();
    this.device.submit();
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
   * reduction tree: a few gather passes over N / 15 texels (0.46 ms at 325k on an M1 Max).
   */
  refreshSegmentStats(): void {
    this.reduceSegments();
  }

  private reduceSegments(): void {
    this.reduce.run(
      { pos: this.pos.readTex, vel: this.vel.readTex, posWidth: this.width, count: this.count },
      this.segments,
    );
  }

  /**
   * Read the current node positions back to the CPU — synchronously, for tests and one-off reads; the
   * streaming transport never calls it (it reads through a fenced PBO, #352).
   * Writes `count * 2` floats into `out` starting at index 0.
   */
  readPositions(out: Float32Array): void {
    // Reuse the pre-created readback FBO for the current read-side texture (no per-call alloc).
    this.readback.read(this.positionFramebuffer, this.count, out);
  }

  /**
   * Read back the per-node force the last tick accumulated (springs + repulsion + centering, before
   * integration) — `count * 2` floats into `out`. A synchronous read for tests and one-off checks,
   * like {@link readPositions}; never on the streaming path. The force is a function of the
   * positions that tick started from, which is what the flat-equivalence contract compares.
   */
  readForces(out: Float32Array): void {
    this.readback.read(this.forceFbo, this.count, out);
  }

  destroy(): void {
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
  }
}
