import type { Device, Framebuffer, SamplerProps, Texture } from "@luma.gl/core";
import type { LayoutGraph } from "../force.js";
import { NESTED, WARM_ALPHA, nestedAlphaDecay } from "../nested-layout.js";
import { atlasWidth, pingPong, type PingPong } from "./textures.js";
import { beginPass, type PassUniforms } from "./passes/fullscreen.js";
import { SegmentedReduce, type RangeTarget, type ReduceMap } from "./passes/segmented-reduce.js";
import { GridPyramid } from "./passes/grid-pyramid.js";
import { RepulsionPass } from "./passes/repulsion.js";
import { NestedIntegratePass, NestedPredictPass, type NestedSlotInputs } from "./passes/nested.js";
import { COLLISION_STEPS, CollisionGrid } from "./passes/collision.js";
import { NestedComposePass } from "./passes/nested-compose.js";
import { GpuSprings } from "./springs.js";
import type { NestedSpringInputs } from "./passes/attraction.js";
import { SegmentTable, type SegmentRow } from "./segment-table.js";
import { TILE_MIN_SIDE, assertAtlasFits, packTiles, segmentSoftening, slotSegments, type SlotRange } from "./segments.js";
import type { PackedPositions } from "./async-readback.js";
import type { StreamSolver } from "./gpu-stream.js";
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
// | item | organise phase (first 60% of the ticks)            | compact phase (the rest)               |
// |------|-----------------------------------------------------|----------------------------------------|
// | P    | reductions (box) → pyramid; clear the force texture | clear the force texture                |
// | F_b  | repulsion of band b (tile traversal / exact loop)   | —                                      |
// | I    | predict v*; springs at x + v* (zero rest); integrate | the same with rest lengths; then 2 collision steps |
//
// The composition (`passes/nested-compose.ts`) maps the local solutions into world discs and packs leaf
// positions and module discs in node order, for the streaming readback ({@link prepareReadback}).
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

  /** Ticks done, the organise → compact switch, and each start's alpha and decay. */
  private tick = 0;
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
    this.pos = pingPong(device, width, height, slotData(slots, topo.seed, 2));
    this.vel = pingPong(device, width, height);
    const posFbo = (): Framebuffer => device.createFramebuffer({ width, height, colorAttachments: [this.pos.readTex] });
    const posA = posFbo();
    this.pos.swap();
    const posB = posFbo();
    this.pos.swap();
    this.posFbos = [posA, posB];
    // MRT pairs [pos write, vel write] for each (pos parity, vel parity): the write side of parity p is
    // the texture NOT read at p — B at 0, A at 1.
    const mrt = (): Framebuffer => device.createFramebuffer({ width, height, colorAttachments: [this.pos.writeTex, this.vel.writeTex] });
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

    const tex2 = (): Texture => device.createTexture({ width, height, format: "rg32float", mipLevels: 1, sampler: NEAREST });
    this.vstar = tex2();
    this.vstarFbo = device.createFramebuffer({ width, height, colorAttachments: [this.vstar] });
    this.force = tex2();
    this.forceFbo = device.createFramebuffer({ width, height, colorAttachments: [this.force] });
    this.radius = device.createTexture({ width, height, format: "r32float", data: slotData(slots, topo.radius, 1), mipLevels: 1, sampler: NEAREST });
    const seg = new Uint32Array(width * height);
    seg.set(slotSegments(segments, slots));
    this.slotSeg = device.createTexture({ width, height, format: "r32uint", data: seg, mipLevels: 1, sampler: NEAREST });

    this.segments = new SegmentTable(device, rows);
    const tw = this.segments.width;
    const th = Math.ceil(rows.length / tw);
    const nested = new Float32Array(tw * th * 4);
    for (let s = 0; s < S; s++) {
      nested[s * 4] = topo.segR9[s] ?? 0;
      nested[s * 4 + 1] = topo.segOwner[s] ?? -1;
    }
    nested[S * 4 + 1] = -1;
    this.segNested = device.createTexture({ width: tw, height: th, format: "rgba32float", data: nested, mipLevels: 1, sampler: NEAREST });
    const largeWidth = atlasWidth(2 * rows.length);
    const largeRows = Math.ceil((2 * rows.length) / largeWidth);
    const large = new Uint32Array(largeWidth * largeRows * 4).fill(0xffffffff);
    for (let i = 0; i < S * NESTED_LARGE_MAX; i++) {
      const slot = topo.segLarge[i] ?? -1;
      if (slot >= 0) large[i] = slot;
    }
    this.segLarge = device.createTexture({ width: largeWidth, height: largeRows, format: "rgba32uint", data: large, mipLevels: 1, sampler: NEAREST });
    const extentTex = (): Texture => device.createTexture({ width: tw, height: th, format: "rgba32float", mipLevels: 1, sampler: NEAREST });
    const extentStats = extentTex();
    const extentBox = extentTex();
    this.extent = {
      stats: extentStats,
      box: extentBox,
      target: {
        target: device.createFramebuffer({ width: tw, height: th, colorAttachments: [extentStats, extentBox] }),
        width: tw,
        size: rows.length,
        info: this.segments.info,
      },
    };

    this.reduce = new SegmentedReduce(device, slots, NESTED_REDUCE_MAP);
    this.reduceBindings = [
      { u_slotSeg: this.slotSeg, u_rad: this.radius, u_segSum: this.extent.stats },
      { u_slotSeg: this.slotSeg, u_rad: this.radius, u_segSum: this.segments.stats },
    ];
    this.reduceUniforms["u_segTableWidth"] = tw;
    this.pyramid = atlas.levels.length > 0 ? new GridPyramid(device, atlas, false) : null;
    this.repulsion = new RepulsionPass(device, { singleSegment: false, levelCount: atlas.levels.length, exact: true });

    const links: LayoutGraph = {
      nodeCount: slots,
      edgeCount: topo.linkSource.length,
      source: topo.linkSource,
      target: topo.linkTarget,
      springWeight: topo.linkWeight,
      positions: new Float32Array(0),
    };
    this.springs = new GpuSprings(device, links, { nested: true });
    this.predict = new NestedPredictPass(device);
    this.integratePass = new NestedIntegratePass(device, 1 - NESTED.DECAY);
    this.collision = new CollisionGrid(device, width, height, atlas.width >> 1, atlas.height >> 1, largeWidth);
    this.compose = new NestedComposePass(device, topo.nodeSlot, topo.leafCount, topo.depth, NESTED.FILL, NESTED.ONLY_CHILD);
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

  /** Ticks integrated so far. */
  get ticks(): number {
    return this.tick;
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

  /**
   * Work item **P**: in the organise phase the reductions (for the boxes) and the tile pyramid the
   * repulsion bands traverse; in both phases the clear of the force accumulator.
   */
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
    }
    this.clearForce();
  }

  /** Work item **F_b**: the repulsion of atlas rows of band `band` (organise phase only). */
  forceBand(band: number, bands: number): void {
    if (!this.organising) return;
    const r0 = Math.floor((band * this.height) / bands);
    const r1 = Math.floor(((band + 1) * this.height) / bands);
    if (r1 <= r0) return;
    const pass = beginPass(this.device, {
      framebuffer: this.forceFbo,
      clear: false,
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
   * Work item **I**: predict v*, gather the springs at x + v*, integrate (MRT), then — in the compact phase
   * — one collision step; then advance the alpha schedules.
   */
  integrate(): void {
    const organising = this.organising;
    const input = this.slotInputs;
    input.alphaCold = this.alphaCold;
    input.alphaWarm = this.alphaWarm;

    let pass = beginPass(this.device, { framebuffer: this.vstarFbo, clear: false });
    this.predict.run(pass, this.pos.readTex, this.vel.readTex, this.force, organising, input);
    pass.end();
    this.device.submit();

    this.clearForce();
    const springs = this.springInputs;
    springs.rest = organising ? 0 : 1;
    this.springs.prepare(this.pos.readTex, this.width, springs);
    pass = beginPass(this.device, { framebuffer: this.forceFbo, clear: false });
    this.springs.draw(pass, this.pos.readTex, { count: this.slots, width: this.width, attraction: 1 }, springs);
    pass.end();
    this.device.submit();

    const [atPos0, atPos1] = this.integrateFbos;
    const pair = this.posParity === 0 ? atPos0 : atPos1;
    const fbo = this.velParity === 0 ? pair[0] : pair[1];
    pass = beginPass(this.device, { framebuffer: fbo, clear: false });
    this.integratePass.run(pass, this.pos.readTex, this.vstar, this.force, input);
    pass.end();
    this.device.submit();
    this.swapPos();
    this.vel.swap();
    this.velParity ^= 1;

    for (let c = 0; c < (organising ? 0 : COLLISION_STEPS); c++) {
      this.runReduce(1, this.segments);
      this.collision.step({
        pos: this.pos.readTex,
        target: this.posFbo(this.posParity ^ 1),
        radius: this.radius,
        slotSeg: this.slotSeg,
        segments: this.segments,
        segNested: this.segNested,
        segLarge: this.segLarge,
        count: this.slots,
        width: this.width,
        pad: NESTED.PAD,
      });
      this.swapPos();
    }

    this.alphaCold -= this.alphaCold * this.decayCold;
    this.alphaWarm -= this.alphaWarm * this.decayWarm;
    this.tick++;
  }

  /**
   * Compose the current local positions into world positions and discs, packed in node order for the
   * readback: the weighted centroids and boxes (mode 1, whose whole-slot range the harvest checks for
   * finiteness), the extents (mode 2), then the composition. Positions change only in {@link integrate},
   * so this is safe at any point of a tick; it recomputes the reductions itself either way.
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

  /** Bytes of GPU memory the layout holds (textures and render targets; excludes the readback's PBOs). */
  get gpuBytes(): number {
    const slotTexels = this.width * this.height;
    const perSlot = slotTexels * (4 * 8 + 8 + 8 + 4 + 4); // pos ×2, vel ×2, v*, force, radius, slotSeg
    const pyramid = this.pyramid
      ? this.pyramid.atlas.width * this.pyramid.atlas.height * 16 +
        (this.pyramid.atlas.odd.width * this.pyramid.atlas.odd.height + this.pyramid.atlas.even.width * this.pyramid.atlas.even.height) * 16
      : 0;
    return perSlot + pyramid + this.collision.gpuBytes + this.compose.gpuBytes;
  }

  destroy(): void {
    this.pos.destroy();
    this.vel.destroy();
    for (const pair of this.integrateFbos) for (const fbo of pair) fbo.destroy();
    this.posFbos[0].destroy();
    this.posFbos[1].destroy();
    this.vstarFbo.destroy();
    this.vstar.destroy();
    this.forceFbo.destroy();
    this.force.destroy();
    this.radius.destroy();
    this.slotSeg.destroy();
    this.segNested.destroy();
    this.segLarge.destroy();
    this.extent.target.target.destroy();
    this.extent.stats.destroy();
    this.extent.box.destroy();
    this.segments.destroy();
    this.reduce.destroy();
    this.pyramid?.destroy();
    this.repulsion.destroy();
    this.springs.destroy();
    this.predict.destroy();
    this.integratePass.destroy();
    this.collision.destroy();
    this.compose.destroy();
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
