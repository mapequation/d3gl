import type { Device, Texture, Framebuffer } from "@luma.gl/core";
import type { ForceParams, LayoutGraph } from "../force.js";
import { buildCSR } from "../graph.js";
import { atlasWidth, pingPong, readbackFloatFboReuse, packUintTexture } from "./textures.js";
import { IntegratePass } from "./passes/integrate.js";
import { AttractionPass } from "./passes/attraction.js";
import { RepulsionAllPairsPass } from "./passes/repulsion-allpairs.js";
import { RepulsionPyramidPass } from "./passes/repulsion-pyramid.js";
import { GridPyramid } from "./passes/grid-pyramid.js";
import { CentroidReducePass, CenteringPass, makeSumTarget } from "./passes/centering.js";

/** Damping applied to velocity each integration step (mirrors CPU force.ts). */
const DAMPING = 0.9;

/**
 * Node-count threshold for the repulsion algorithm. At or below this many nodes
 * the exact all-pairs O(n²) pass runs (cheap at small N and bit-for-bit the
 * correctness/parity baseline every existing test relies on); above it the
 * Barnes-Hut grid-pyramid pass (O(n log n)) runs. 4096 keeps the all-pairs cost
 * bounded (~16.7M pair terms) while covering all current tiny-N tests.
 */
export const GPU_REPULSION_ALLPAIRS_MAX = 4096;

/** Optional overrides for {@link GpuForceLayout} (test/tuning hooks). */
export interface GpuForceLayoutOptions {
  /**
   * Force a repulsion algorithm regardless of node count:
   *   "allpairs" — exact O(n²);  "pyramid" — Barnes-Hut grid pyramid.
   * Omitted → auto-select by {@link GPU_REPULSION_ALLPAIRS_MAX}.
   */
  repulsionMode?: "allpairs" | "pyramid";
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
  private readonly attractionPass: AttractionPass;
  private readonly repulsionPass: RepulsionAllPairsPass;
  private readonly centroidReducePass: CentroidReducePass;
  private readonly centeringPass: CenteringPass;

  /**
   * Barnes-Hut repulsion — used when {@link usePyramid} is true. The pyramid
   * (regular-quadtree COM/mass) is rebuilt each tick before the force pass; the
   * pyramid repulsion pass then traverses it per node. Both are pre-created in
   * the constructor (all their textures/FBOs too) so ticking allocates nothing.
   */
  private readonly pyramid: GridPyramid;
  private readonly repulsionPyramidPass: RepulsionPyramidPass;
  /** Whether this layout uses the BH pyramid (else exact all-pairs). */
  private readonly usePyramid: boolean;

  /**
   * Span-based maximum displacement per tick.  Mirrors force.ts's `span0 * 4`
   * clamp to prevent layout explosion on pathological force configurations.
   * Set once at construction from the initial position bounding box.
   */
  private readonly maxStep: number;

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
   * step (beginRenderPass with clearColor:[0,0,0,0]).  Force passes render into
   * it with additive blend.  Pre-created in the constructor per the no-per-tick-
   * alloc rule.
   */
  private readonly forceFbo: Framebuffer;

  /**
   * 1×1 rg32float texture that accumulates Σpos over all nodes during the
   * centroid reduction.  Pre-created in the constructor — no per-tick alloc.
   */
  private readonly sumTex: Texture;
  /**
   * Pre-created FBO wrapping `sumTex`.  Cleared to zero before each centroid
   * reduction, then CentroidReducePass scatters all node positions into it via
   * additive blend.
   */
  private readonly sumFbo: Framebuffer;

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
   * Per-node pinned-flag texture (r8unorm, one byte per node; 255 = held, 0 = free) — the GPU
   * mirror of {@link ForceLayout}'s `pinned` array (#183 drag reheat). Sampled by the integrate
   * pass: a held node is skipped by integration (held in place, velocity zeroed) but still acts
   * on its neighbours through the force passes. Pre-created zeroed in the constructor and updated
   * by {@link setPinned} via sub-uploads (no per-tick / per-move allocation).
   */
  private readonly pinnedTex: Texture;
  /** The currently-pinned ids (so {@link setPinned} can clear them before applying the next set). */
  private pinnedIds: Uint32Array | null = null;
  /** Scratch for a single-texel flag sub-upload (r8unorm: 255 = held, 0 = free). */
  private readonly flagScratch = new Uint8Array(1);
  /** Scratch for a single-texel (x, y) position sub-upload into the read-side position texture. */
  private readonly heldScratch = new Float32Array(2);

  /** CSR offset texture (r32uint): offsets[0..nodeCount] packed into an atlas. */
  private readonly offsetsTex: Texture;
  /** CSR neighbors texture (r32uint): the flat neighbor list packed into an atlas. */
  private readonly neighborsTex: Texture;
  /** Atlas width of the offsets texture. */
  private readonly offWidth: number;
  /** Atlas width of the neighbors texture. */
  private readonly nbrWidth: number;

  constructor(
    device: Device,
    graph: LayoutGraph,
    params: ForceParams,
    options: GpuForceLayoutOptions = {},
  ) {
    this.device = device;
    this.count = graph.nodeCount;
    this.params = params;

    // Choose the repulsion algorithm: explicit override, else auto by node count.
    this.usePyramid =
      options.repulsionMode === "pyramid"
        ? true
        : options.repulsionMode === "allpairs"
          ? false
          : this.count > GPU_REPULSION_ALLPAIRS_MAX;

    const width = atlasWidth(this.count);
    const height = Math.ceil(this.count / width);
    this.width = width;
    this.height = height;

    // Compute initial layout span from positions to set a span-based maxStep.
    // Mirrors force.ts: span0 = max(2 * rootHalf(), 1) where rootHalf ≈ half-extent.
    // We approximate by taking the max of x/y extents.  The clamp prevents layout
    // explosion on the first few ticks (same rationale as the CPU integrator).
    // TODO(N8.5): if the GPU layout with BH pyramid (Task 5) uses a different span
    // definition, revisit.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < graph.nodeCount; i++) {
      const x = graph.positions[i * 2]!;
      const y = graph.positions[i * 2 + 1]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const span0 = Math.max((maxX - minX), (maxY - minY), 1);
    this.maxStep = span0 * 4;

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

    // Build symmetric (undirected) CSR from the graph's directed edge list.
    // LayoutGraph has source/target; buildCSR inserts both directions, so the
    // GPU gather over csr.neighbors reproduces force.ts's attraction exactly.
    const csr = buildCSR(graph.nodeCount, graph.source, graph.target);

    // Upload CSR offset and neighbor arrays as r32uint textures — done ONCE in
    // the constructor, reused every tick.
    const offResult = packUintTexture(device, csr.offsets);
    this.offsetsTex = offResult.texture;
    this.offWidth = offResult.width;

    // neighbors may be empty (no edges) — packUintTexture handles length 0 by
    // creating a 1×1 zeroed texture, which is never actually fetched.
    const nbrData = csr.neighbors.length > 0
      ? csr.neighbors
      : new Uint32Array(1);
    const nbrResult = packUintTexture(device, nbrData);
    this.neighborsTex = nbrResult.texture;
    this.nbrWidth = nbrResult.width;

    // Pre-create the 1×1 sum texture and its FBO for the centroid reduction.
    // No per-tick allocation — keep the createFramebuffer spy test green.
    const sumTarget = makeSumTarget(device);
    this.sumTex = sumTarget.sumTex;
    this.sumFbo = sumTarget.sumFbo;

    this.integratePass = new IntegratePass(device);
    this.attractionPass = new AttractionPass(device);
    this.repulsionPass = new RepulsionAllPairsPass(device);
    this.centroidReducePass = new CentroidReducePass(device);
    this.centeringPass = new CenteringPass(device);

    // Barnes-Hut pyramid + traversal pass. Pre-created in the constructor
    // (all its level textures + FBOs + bbox target) so no per-tick allocation,
    // whether or not this layout uses it — cheap for small N and keeps the code
    // path uniform. The traversal pass is compiled for the pyramid's fixed
    // levelCount so its stack is a fixed-size array.
    this.pyramid = new GridPyramid(device, this.count);
    this.repulsionPyramidPass = new RepulsionPyramidPass(device, this.pyramid.levelCount);
  }

  /** Execute `ticks` integrate steps on the GPU. */
  runFrame(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      this._tick();
    }
  }

  private _tick(): void {
    // ── 1. Centroid reduction ─────────────────────────────────────────────────
    // Clear the 1×1 sum texture to zero, then scatter all node positions into it
    // via additive blend (CentroidReducePass).  The resulting single texel holds
    // Σpos; dividing by nodeCount in CenteringPass gives the centroid.  This is a
    // separate render pass (different FBO size) that must complete before the
    // force pass below reads sumTex.
    const sumPass = this.device.beginRenderPass({
      framebuffer: this.sumFbo,
      clearColor: [0, 0, 0, 0],
    });
    this.centroidReducePass.run(sumPass, this.pos.readTex, {
      count: this.count,
      width: this.width,
    });
    sumPass.end();
    this.device.submit();

    // ── 1b. Build the Barnes-Hut pyramid (only when this layout uses it) ──────
    // Rebuilds the regular-quadtree COM/mass pyramid over the current positions.
    // Runs its own render passes (different FBO sizes) and submits internally,
    // so it must complete before the force pass below reads its level textures.
    // Skipped entirely on the all-pairs path.
    if (this.usePyramid) {
      this.pyramid.build({
        posTex: this.pos.readTex,
        count: this.count,
        width: this.width,
      });
    }

    // ── 2. Clear force texture to zero ────────────────────────────────────────
    // Open a render pass on the force FBO with clearColor:[0,0,0,0] — this zeros
    // all texels so each force pass starts from a known blank slate.
    const forcePass = this.device.beginRenderPass({
      framebuffer: this.forceFbo,
      clearColor: [0, 0, 0, 0],
    });

    // ── 3. Force passes (additive blend, write into forceTex) ─────────────────
    // Order among force passes doesn't matter — additive blend accumulates them.

    // Attraction (spring gather over CSR neighbors).
    this.attractionPass.run(
      forcePass,
      this.pos.readTex,
      this.offsetsTex,
      this.neighborsTex,
      {
        count: this.count,
        width: this.width,
        offWidth: this.offWidth,
        nbrWidth: this.nbrWidth,
        attraction: this.params.attraction,
      },
    );

    // Repulsion. Exact all-pairs O(n²) at/below the threshold (the parity
    // baseline); Barnes-Hut grid-pyramid O(n log n) above it. Both additive-blend
    // their per-node force into forceTex.
    if (this.usePyramid) {
      this.repulsionPyramidPass.run(forcePass, this.pos.readTex, this.pyramid, {
        count: this.count,
        width: this.width,
        repulsion: this.params.repulsion,
        theta: this.params.theta,
      });
    } else {
      this.repulsionPass.run(forcePass, this.pos.readTex, {
        count: this.count,
        width: this.width,
        repulsion: this.params.repulsion,
      });
    }

    // Centering: pull every node toward the centroid (Σpos / count computed above).
    this.centeringPass.run(forcePass, this.pos.readTex, this.sumTex, {
      count: this.count,
      width: this.width,
      centering: this.params.centering,
    });

    forcePass.end();
    this.device.submit();

    // ── 3. Integrate pass (reads force, writes pos+vel MRT) ───────────────────
    // Select the pre-created MRT framebuffer whose attachments are the current
    // write textures — no per-tick createFramebuffer.
    const fbo = this.fbos[this.parity]!;

    const renderPass = this.device.beginRenderPass({
      framebuffer: fbo,
      // Don't clear — every texel is written by the shader (padded texels get
      // vec2(0) from the `id >= u_count` branch).
      clearColor: false,
    });

    this.integratePass.run(renderPass, this.pos.readTex, this.vel.readTex, this.forceTex, this.pinnedTex, {
      count: this.count,
      width: this.width,
      alpha: this.params.alpha,
      damping: DAMPING,
      // Span-based clamp mirrors force.ts's `span0 * 4` to prevent layout
      // explosion on pathological forces. See constructor for span0 derivation.
      maxStep: this.maxStep,
    });

    renderPass.end();
    this.device.submit();

    // Swap both ping-pongs so the freshly-written textures become the read
    // sources for the next tick, and flip parity so the next tick writes into
    // the OTHER pre-created FBO (which wraps those next write textures).
    this.pos.swap();
    this.vel.swap();
    this.parity ^= 1;
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
   * Read the current node positions back to the CPU.
   * Writes `count * 2` floats into `out` starting at index 0.
   */
  readPositions(out: Float32Array): void {
    // Reuse the pre-created readback FBO for the current read-side texture (no per-call alloc).
    const pixels = readbackFloatFboReuse(this.device, this.readFbos[this.parity]!, this.width, this.count);
    out.set(pixels);
  }

  destroy(): void {
    this.pos.destroy();
    this.vel.destroy();
    this.forceTex.destroy();
    this.forceFbo.destroy();
    this.pinnedTex.destroy();
    this.sumTex.destroy();
    this.sumFbo.destroy();
    this.fbos[0].destroy();
    this.fbos[1].destroy();
    this.readFbos[0].destroy();
    this.readFbos[1].destroy();
    this.offsetsTex.destroy();
    this.neighborsTex.destroy();
    this.integratePass.destroy();
    this.attractionPass.destroy();
    this.repulsionPass.destroy();
    this.centroidReducePass.destroy();
    this.centeringPass.destroy();
    this.pyramid.destroy();
    this.repulsionPyramidPass.destroy();
  }
}
