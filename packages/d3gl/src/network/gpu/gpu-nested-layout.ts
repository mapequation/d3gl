import type { Device, Framebuffer, SamplerProps, Texture } from "@luma.gl/core";
import type { LayoutGraph } from "../force.js";
import { NESTED, WARM_ALPHA, nestedAlphaDecay } from "../nested-layout.js";
import { atlasWidth, pingPong, type PingPong } from "./textures.js";
import { beginPass, type PassTarget, type PassUniforms } from "./passes/fullscreen.js";
import { SegmentedReduce, rangeRows, type RangeTarget, type ReduceInput, type ReduceMap } from "./passes/segmented-reduce.js";
import { GridPyramid, type PyramidBuildInput } from "./passes/grid-pyramid.js";
import { RepulsionPass, type RepulsionInput } from "./passes/repulsion.js";
import { NestedIntegratePass, NestedPredictPass, type NestedSlotInputs } from "./passes/nested.js";
import { COLLISION_STEPS, CollisionGrid, type CollisionGatherInput, type CollisionPrepareInput } from "./passes/collision.js";
import { NestedComposePass, type ComposeInput } from "./passes/nested-compose.js";
import { GpuSprings } from "./springs.js";
import type { NestedSpringInputs } from "./passes/attraction.js";
import { SegmentTable, type SegmentRow } from "./segment-table.js";
import { TILE_MIN_SIDE, assertAtlasFits, bandRows, packTiles, segmentSoftening, slotSegments, type SlotRange } from "./segments.js";
import type { PackedPositions } from "./async-readback.js";
import type { StreamSolver } from "./gpu-stream.js";
import type { StreamStage } from "./stream-schedule.js";
import { largestModule, nestedPlan, type NestedPlanSizes, type NestedStep } from "./nested-plan.js";
import { NESTED_LARGE_MAX, type NestedSolverTopology } from "./nested-topology.js";
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
// A solve tick is one stream tick in the organise phase and one per collision step in the compact phase.
// A stream tick is a sequence of passes ({@link StreamStage}s), and the streaming transport cuts every one
// of them into row bands sized to the frame budget (#382) — so no work item exceeds half the budget at any
// N (the budget, for the gather, whose every band waits for its longest fragment), and neither does a frame
// that reads positions back: the composition is sliced the same way, as items of their own
// (`nested-plan.ts` has the passes and their cost model):
//
// | stream tick                 | passes, in order                                                                  |
// |-----------------------------|-----------------------------------------------------------------------------------|
// | organise (first 60%)        | reduction (tree, query) → pyramid (scatter, levels) → repulsion → predict v* → [hub chunks] → springs at x + v* (zero rest) + integrate |
// | compact, collision step 1   | predict → [hub chunks] → springs (rest lengths) + integrate → reduction → collision cells → count → rounds 0…7 → gather |
// | compact, collision step 2   | reduction → collision cells → count → rounds 0…7 → gather                          |
// | readback                    | reduction (weighted centroids) → reduction (extents) → composition                 |
//
// Each pass reads only what the passes before it wrote, and each band writes its own rows (or scatters its
// own slots, in submission order), so the solve is bitwise the same for any band counts. An accumulator is
// cleared by the first band of the pass that fills it, and the positions swap after the last band of the
// pass that writes them (the integrate, the gather).
//
// The composition (`passes/nested-compose.ts`) maps the local solutions into world discs and packs leaf
// positions and module discs in node order, for the streaming readback ({@link readbackStages}). It has
// its own reduction scratch and sums, so it can run between any two work items of a tick without
// disturbing the tick's state.
//
// A large module whose radii are heavy-tailed makes both the gather and the collision scatters grow as k²
// (every grid slot on the exact loop; the count and round scatters contending at hundreds of discs per
// cell): one 60,000-child module takes a 55 ms gather. The cost model sees the gather's longest fragment —
// a slot that loops over its whole module, which every band waits for — but not the k² total; when items
// still miss, the frame budget's fences grow the bands of every pass (up to 8×). Past a module of ~12,000
// children at 120 Hz (~25,000 at 60 Hz), one band of the gather alone exceeds the budget whatever the
// slicing. A radius-class grid is the fix (#380).
//
// Not the CPU's: Jacobi instead of Gauss-Seidel links and collision pairs (every term reads one state),
// and grid-pyramid Barnes-Hut instead of the CPU's adaptive quadtree for segments above 32 children (the
// flat layout's approximation). Everything else — radii, seeds, links, forces, the integration constants,
// the alpha schedule per segment, the composition — is the CPU's (spec §11.1, Q6).

const NEAREST: SamplerProps = { minFilter: "nearest", magFilter: "nearest" };

/** Barnes-Hut opening angle of the CPU nested solve's `repel()`. */
const NESTED_THETA = 0.9;

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

/** Options of {@link GpuNestedLayout}. */
export interface GpuNestedLayoutOptions {
  /** The root disc's centre, world units. Default (0, 0) (a cold layout's; a warm one is placed after). */
  rootX?: number;
  rootY?: number;
  /** Test hook: ticks of the organise phase (default `⌈0.6 · iterations⌉`, the CPU's). */
  organise?: number;
}

/**
 * The batched GPU nested layout — see the file header. Built once per layout from a
 * {@link NestedSolverTopology}; every texture, framebuffer and program is created here, so ticking and
 * reading back allocate nothing. A {@link StreamSolver}: the streaming transport encodes its work items
 * within the frame budget and reads the composed positions back through a fenced PBO.
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
  /** Per segment `(r₉, owner slot, 0, 0)`. */
  private readonly segNested: Texture;
  /** Per segment its large slots (2 `rgba32uint` texels). */
  private readonly segLarge: Texture;
  /** The segment table — S segments plus one range over every slot (the readback's finiteness check). */
  private readonly segments: SegmentTable;
  /** The composition's own mode-1 target: each range's weighted-centroid sums and box, of the positions it composes. */
  private readonly sums: { readonly stats: Texture; readonly box: Texture; readonly target: RangeTarget };
  /** The composition's mode-2 target: each range's extent about its centroid (box x). */
  private readonly extent: { readonly stats: Texture; readonly box: Texture; readonly target: RangeTarget };
  /** The solve's reduction (into the segment table) and the composition's own (tree scratch of its own). */
  private readonly reduce: SegmentedReduce;
  private readonly composeReduce: SegmentedReduce;
  private readonly pyramid: GridPyramid | null;
  private readonly repulsion: RepulsionPass;
  private readonly springs: GpuSprings;
  private readonly predict: NestedPredictPass;
  private readonly integratePass: NestedIntegratePass;
  private readonly collision: CollisionGrid;
  private readonly compose: NestedComposePass;
  private readonly slotInputs: NestedSlotInputs;
  private readonly gatherInput: CollisionGatherInput;
  private readonly prepareInput: CollisionPrepareInput;
  /** The other passes' inputs, created once; each band only points them at the current positions. */
  private readonly reduceInputs: ReduceInput;
  private readonly pyramidInputs: PyramidBuildInput;
  private readonly repulsionInputs: RepulsionInput;
  private readonly composeInputs: ComposeInput;
  private readonly springInputs: NestedSpringInputs;
  /**
   * The nested map's textures per mode. Mode 2 reads mode 1's sums (the composition's `sums.stats`); mode 1
   * renders into a table's `stats`, so it binds a stand-in there — a texture bound for sampling while it is
   * the render target is a feedback loop, and WebGL drops the draw, whether the shader reads it or not.
   */
  private readonly reduceBindings: readonly [Record<string, Texture>, Record<string, Texture>];
  /**
   * The sizes its passes are cut over, read off the textures it built — what `nestedPlanSizes` derives from
   * the topology alone, for checking the frame budget at a scale without a GPU.
   */
  readonly planSizes: NestedPlanSizes;
  /** The passes of each kind of stream tick, and of a readback (see the file header). */
  private readonly organisePlan: readonly StreamStage[];
  private readonly compactPlans: readonly [readonly StreamStage[], readonly StreamStage[]];
  private readonly readbackPlan: readonly StreamStage[];
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

  constructor(device: Device, topo: NestedSolverTopology, options: GpuNestedLayoutOptions = {}) {
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
      if (slots >= 1 << 24) throw new Error("GpuNestedLayout: slot ids must stay exact in float32 (below 2^24)");
      this.slots = slots;
      this.rootX = options.rootX ?? 0;
      this.rootY = options.rootY ?? 0;
      const width = atlasWidth(slots);
      const height = Math.ceil(slots / width);
      this.width = width;
      this.height = height;
      const T = topo.iterations;
      this.organise = options.organise ?? Math.ceil(T * NESTED.ORGANISE);
      this.decayCold = nestedAlphaDecay(1, T);
      this.decayWarm = nestedAlphaDecay(WARM_ALPHA, T);

      // Segments + one whole-slot range; tiles for segments above EXACT_MAX (the CPU's exact threshold).
      const S = topo.segStart.length;
      const segments: SlotRange[] = [];
      for (let s = 0; s < S; s++) segments.push({ start: topo.segStart[s] ?? 0, count: topo.segCount[s] ?? 0 });
      const atlas = packTiles(segments, EXACT_MAX, TILE_MIN_SIDE);
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
      for (let s = 0; s < S; s++) {
        nested[s * 4] = topo.segR9[s] ?? 0;
        nested[s * 4 + 1] = topo.segOwner[s] ?? -1;
      }
      nested[S * 4 + 1] = -1;
      this.segNested = own(device.createTexture({ width: tw, height: th, format: "rgba32float", data: nested, mipLevels: 1, sampler: NEAREST }));
      const largeWidth = atlasWidth(2 * rows.length);
      const largeRows = Math.ceil((2 * rows.length) / largeWidth);
      const large = new Uint32Array(largeWidth * largeRows * 4).fill(0xffffffff);
      for (let i = 0; i < S * NESTED_LARGE_MAX; i++) {
        const slot = topo.segLarge[i] ?? -1;
        if (slot >= 0) large[i] = slot;
      }
      this.segLarge = own(device.createTexture({ width: largeWidth, height: largeRows, format: "rgba32uint", data: large, mipLevels: 1, sampler: NEAREST }));
      // A range target over the segment table's ranges: (stats, box) per range, by MRT.
      const rangeTarget = (): { stats: Texture; box: Texture; target: RangeTarget } => {
        const tex = (): Texture => own(device.createTexture({ width: tw, height: th, format: "rgba32float", mipLevels: 1, sampler: NEAREST }));
        const stats = tex();
        const box = tex();
        const target = own(device.createFramebuffer({ width: tw, height: th, colorAttachments: [stats, box] }));
        return { stats, box, target: { target, width: tw, size: rows.length, info: this.segments.info } };
      };
      this.sums = rangeTarget();
      this.extent = rangeTarget();

      this.reduce = own(new SegmentedReduce(device, slots, NESTED_REDUCE_MAP));
      this.composeReduce = own(new SegmentedReduce(device, slots, NESTED_REDUCE_MAP));
      this.reduceBindings = [
        { u_slotSeg: this.slotSeg, u_rad: this.radius, u_segSum: this.extent.stats },
        { u_slotSeg: this.slotSeg, u_rad: this.radius, u_segSum: this.sums.stats },
      ];
      this.reduceUniforms["u_segTableWidth"] = tw;
      this.pyramid = atlas.levels.length > 0 ? own(new GridPyramid(device, atlas, false)) : null;
      this.repulsion = own(new RepulsionPass(device, { singleSegment: false, levelCount: atlas.levels.length, exact: true }));

      const links: LayoutGraph = {
        nodeCount: slots,
        edgeCount: topo.linkSource.length,
        source: topo.linkSource,
        target: topo.linkTarget,
        springWeight: topo.linkWeight,
        positions: new Float32Array(0),
      };
      this.springs = own(new GpuSprings(device, links, { nested: true }));
      this.predict = own(new NestedPredictPass(device));
      this.integratePass = own(new NestedIntegratePass(device, 1 - NESTED.DECAY));
      this.collision = own(new CollisionGrid(device, width, height, atlas.width >> 1, atlas.height >> 1, largeWidth));
      this.compose = own(new NestedComposePass(device, topo.nodeSlot, topo.leafCount, topo.depth, NESTED.FILL, NESTED.ONLY_CHILD));
      this.packed = { framebuffer: this.compose.framebuffer, width: this.compose.width, height: this.compose.height, extraFloats: this.compose.extraFloats };

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
        segLarge: this.segLarge,
        count: slots,
        width,
        rows: height,
        pad: NESTED.PAD,
      };
      this.prepareInput = {
        pos: this.pos.readTex,
        radius: this.radius,
        slotSeg: this.slotSeg,
        segments: this.segments,
        segNested: this.segNested,
        count: slots,
        width,
        pad: NESTED.PAD,
      };
      this.reduceInputs = { pos: this.pos.readTex, posWidth: width, count: slots };
      this.pyramidInputs = { posTex: this.pos.readTex, width, count: slots, segments: this.segments, slotSeg: this.slotSeg };
      this.repulsionInputs = {
        posTex: this.pos.readTex,
        count: slots,
        width,
        theta: NESTED_THETA,
        segments: this.segments,
        pyramid: this.pyramid,
        slotSeg: this.slotSeg,
      };
      this.composeInputs = {
        pos: this.pos.readTex,
        radius: this.radius,
        slotSeg: this.slotSeg,
        width,
        segments: this.segments,
        segSum: this.sums.stats,
        segExtent: this.extent.box,
        segNested: this.segNested,
        rootX: this.rootX,
        rootY: this.rootY,
        rootRadius: topo.rootRadius,
      };

      // ── The passes of each stream tick and of a readback (see the file header) ──
      this.planSizes = {
        leaves: topo.leafCount,
        slotRows: height,
        treeRows: this.reduce.level1Rows,
        tableRows: rangeRows(this.segments),
        levelRows: this.pyramid?.levelRows ?? 0,
        hubRows: this.springs.hubRows,
        composeRows: this.compose.height,
        largestModule: largestModule(topo),
      };
      const plan = nestedPlan(this.planSizes);
      const bind = (steps: readonly NestedStep[]): StreamStage[] =>
        steps.map((step) => ({ costMs: step.costMs, fixedMs: step.fixedMs, rows: step.rows, run: this.passOf(step) }));
      this.organisePlan = bind(plan.organise);
      this.compactPlans = [bind(plan.compact[0]), bind(plan.compact[1])];
      this.readbackPlan = bind(plan.readback);
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

  /** Rows of the slot atlas — the domain most passes' bands cut. */
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

  /** The passes of the stream tick the solve is at (see the file header); the last one's last band ends it. */
  tickStages(): readonly StreamStage[] {
    if (this.organising) return this.organisePlan;
    return this.step === 0 ? this.compactPlans[0] : this.compactPlans[1];
  }

  /**
   * The passes of a readback: the weighted centroids and boxes (whose whole-slot range the harvest checks
   * for finiteness), the extents, then the composition into the staging texture. They read the positions
   * and write only the composition's own state, so they may run between any two work items of a tick.
   */
  readbackStages(): readonly StreamStage[] {
    return this.readbackPlan;
  }

  /** The composition ran as {@link readbackStages}: nothing is left to do before the copy. */
  prepareReadback(): void {}

  /** Run `ticks` whole solve ticks, every pass unsliced — for tests and one-off solves. */
  runTicks(ticks: number): void {
    const until = this.tick + ticks;
    while (this.tick < until) {
      for (const stage of this.tickStages()) stage.run(0, 1);
    }
  }

  /**
   * Compose the current local positions into world positions and discs, packed in node order in the
   * staging texture — every readback pass, unsliced (tests and one-off reads; the stream slices them).
   */
  composeReadback(): void {
    for (const stage of this.readbackPlan) stage.run(0, 1);
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

  /** The composition's weighted-centroid sums and boxes: a readback carries their whole-slot range. */
  get segmentStats(): { readonly stats: Texture; readonly box: Texture } {
    return this.sums;
  }

  /** The whole-slot range (the last row of the table): its stats refuse a non-finite readback. */
  get statsTexel(): readonly [number, number] {
    const s = this.topo.segStart.length;
    return [s % this.segments.width, Math.floor(s / this.segments.width)];
  }

  private get organising(): boolean {
    return this.tick < this.organise;
  }

  /**
   * Compose and read back synchronously — for tests and one-off reads; the streaming transport never
   * calls it (it reads through a fenced PBO). `positions` gets the leaves' world positions (`2 · leaves`
   * floats), `discs` (optional) every module's world disc as `(cx, cy, r, 0)` (`4 · modules` floats).
   */
  readComposed(positions: Float32Array, discs?: Float32Array): void {
    this.composeReadback();
    const { width, height, framebuffer } = this.compose;
    const pixels = this.device.readPixelsToArrayWebGL(framebuffer, { sourceWidth: width, sourceHeight: height });
    if (!(pixels instanceof Float32Array)) throw new Error("GpuNestedLayout: expected a float readback");
    positions.set(pixels.subarray(0, 2 * this.topo.leafCount));
    if (discs) {
      const from = 4 * Math.ceil(this.topo.leafCount / 2);
      discs.set(pixels.subarray(from, from + Math.min(discs.length, this.compose.extraFloats)));
    }
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

  // ── The passes (each over its rows of band `band` of `bands`) ─────────────────

  /** The pass a step of the plan runs, as a band function. */
  private passOf(step: NestedStep): (band: number, bands: number) => void {
    const { organising, index } = step;
    const mode = index === 2 ? 2 : 1;
    switch (step.pass) {
      case "tree":
        return step.readback ? (band, bands) => this.composeTree(mode, band, bands) : (band, bands) => this.solveTree(band, bands);
      case "query":
        return step.readback ? (band, bands) => this.composeQuery(mode, band, bands) : (band, bands) => this.solveQuery(band, bands);
      case "scatter":
        return (band, bands) => this.pyramid?.scatter(this.pyramidInput(), band, bands);
      case "levels":
        return (band, bands) => this.pyramid?.reduceLevels(band, bands);
      case "repulsion":
        return (band, bands) => this.repulsionBand(band, bands);
      case "predict":
        return (band, bands) => this.predictBand(organising, band, bands);
      case "hubs":
        return (band, bands) => this.hubsBand(organising, band, bands);
      case "springs":
        return (band, bands) => this.springsBand(organising, band, bands);
      case "cells":
        return (band, bands) => this.collision.cells(this.collisionInput(), band, bands);
      case "count":
        return (band, bands) => this.collision.count(this.collisionInput(), band, bands);
      case "round":
        return (band, bands) => this.collision.round(index, this.collisionInput(), band, bands);
      case "gather":
        return (band, bands) => this.gatherBand(band, bands);
      case "compose":
        return (band, bands) => this.composeBand(band, bands);
    }
  }

  /** The solve's reduction, tree level 1: each segment's weighted centroid and box (the pyramid's and the grid's geometry). */
  private solveTree(band: number, bands: number): void {
    this.reduceUniforms["u_mode"] = 1;
    this.reduce.buildLevel1(this.reduceInput(), this.reduceBindings[0], this.reduceUniforms, band, bands);
  }

  /** The solve's reduction: levels 2…L (first band), then the range query into the segment table. */
  private solveQuery(band: number, bands: number): void {
    this.reduceUniforms["u_mode"] = 1;
    if (band === 0) this.reduce.buildUpper();
    this.reduce.query(this.reduceInput(), this.segments, this.reduceBindings[0], this.reduceUniforms, band, bands);
  }

  /** The composition's reduction, tree level 1: mode 1 (weighted centroids, boxes) or mode 2 (extents). */
  private composeTree(mode: 1 | 2, band: number, bands: number): void {
    this.reduceUniforms["u_mode"] = mode;
    this.composeReduce.buildLevel1(this.reduceInput(), this.reduceBindings[mode - 1], this.reduceUniforms, band, bands);
  }

  /** The composition's reduction: levels 2…L (first band), then the range query into its own sums (mode 1) or the extents (mode 2). */
  private composeQuery(mode: 1 | 2, band: number, bands: number): void {
    this.reduceUniforms["u_mode"] = mode;
    if (band === 0) this.composeReduce.buildUpper();
    const table = mode === 1 ? this.sums.target : this.extent.target;
    this.composeReduce.query(this.reduceInput(), table, this.reduceBindings[mode - 1], this.reduceUniforms, band, bands);
  }

  /** The composition + pack into the staging texture, from the composition's sums and extents. */
  private composeBand(band: number, bands: number): void {
    const input = this.composeInputs;
    input.pos = this.pos.readTex;
    this.compose.run(input, band, bands);
  }

  /** Repulsion into the force accumulator, which the first band clears. */
  private repulsionBand(band: number, bands: number): void {
    if (band === 0) this.clearForce();
    const [r0, r1] = bandRows(band, bands, this.height);
    if (r1 <= r0) return;
    const pass = beginPass(this.device, this.slotTarget(this.forceFbo, band, bands));
    const input = this.repulsionInputs;
    input.posTex = this.pos.readTex;
    this.repulsion.run(pass, input);
    pass.end();
    this.device.submit();
  }

  /** PREDICT v* — adding the repulsion sum while `organising`. */
  private predictBand(organising: boolean, band: number, bands: number): void {
    const input = this.slotInputs;
    input.alphaCold = this.alphaCold;
    input.alphaWarm = this.alphaWarm;
    const pass = beginPass(this.device, this.slotTarget(this.vstarFbo, band, bands));
    this.predict.run(pass, this.pos.readTex, this.vel.readTex, this.force, organising, input);
    pass.end();
    this.device.submit();
  }

  /** The springs' hub chunk partials at x + v* (zero rest while organising), over the chunk atlas rows. */
  private hubsBand(organising: boolean, band: number, bands: number): void {
    const springs = this.springInputs;
    springs.rest = organising ? 0 : 1;
    this.springs.prepare(this.pos.readTex, this.width, springs, band, bands);
  }

  /**
   * The springs at x + v* (zero rest while organising) into the force accumulator — which the first band
   * clears — then the integrate of the same rows (MRT), which reads only its own texel. The last band swaps
   * to the new positions and velocities; in the organise phase that ends the solve tick.
   */
  private springsBand(organising: boolean, band: number, bands: number): void {
    const input = this.slotInputs;
    input.alphaCold = this.alphaCold;
    input.alphaWarm = this.alphaWarm;
    const springs = this.springInputs;
    springs.rest = organising ? 0 : 1;
    if (band === 0) this.clearForce();
    let pass = beginPass(this.device, this.slotTarget(this.forceFbo, band, bands));
    this.springs.draw(pass, this.pos.readTex, { count: this.slots, width: this.width, attraction: 1 }, springs);
    pass.end();
    this.device.submit();

    const [atPos0, atPos1] = this.integrateFbos;
    const pair = this.posParity === 0 ? atPos0 : atPos1;
    const fbo = this.velParity === 0 ? pair[0] : pair[1];
    pass = beginPass(this.device, this.slotTarget(fbo, band, bands));
    this.integratePass.run(pass, this.pos.readTex, this.vstar, this.force, input);
    pass.end();
    this.device.submit();
    if (band < bands - 1) return;
    this.swapPos();
    this.vel.swap();
    this.velParity ^= 1;
    if (organising) this.endTick();
  }

  /**
   * The collision gather into the other position texture. The last band swaps to the collided positions
   * and ends the collision step — and after {@link COLLISION_STEPS} of them, the solve tick.
   */
  private gatherBand(band: number, bands: number): void {
    this.collision.gather(this.posFbo(this.posParity ^ 1), this.gatherInput, band, bands);
    if (band < bands - 1) return;
    this.swapPos(); // the gather bands wrote every slot of the other position texture
    this.step++;
    if (this.step >= COLLISION_STEPS) {
      this.step = 0;
      this.endTick();
    }
  }

  /** A solve tick is complete: advance the alpha schedules. */
  private endTick(): void {
    this.alphaCold -= this.alphaCold * this.decayCold;
    this.alphaWarm -= this.alphaWarm * this.decayWarm;
    this.tick++;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** A pass into a slot-atlas framebuffer over the rows of band `band` of `bands` (a scissor; none when whole). */
  private slotTarget(framebuffer: Framebuffer, band: number, bands: number): PassTarget {
    if (bands <= 1) return { framebuffer, clear: false };
    const [r0, r1] = bandRows(band, bands, this.height);
    return { framebuffer, clear: false, scissor: [0, r0, this.width, r1 - r0] };
  }

  /** The reductions' input, at the current positions. */
  private reduceInput(): ReduceInput {
    const input = this.reduceInputs;
    input.pos = this.pos.readTex;
    return input;
  }

  /** The pyramid scatter's input, at the current positions. */
  private pyramidInput(): PyramidBuildInput {
    const input = this.pyramidInputs;
    input.posTex = this.pos.readTex;
    return input;
  }

  /** The collision passes' inputs, at the current positions. */
  private collisionInput(): CollisionPrepareInput {
    const input = this.prepareInput;
    input.pos = this.pos.readTex;
    return input;
  }

  private clearForce(): void {
    const pass = beginPass(this.device, { framebuffer: this.forceFbo, clear: [0, 0, 0, 0] });
    pass.end();
    this.device.submit();
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
