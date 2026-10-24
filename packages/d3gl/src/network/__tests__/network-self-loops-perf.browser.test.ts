import { describe, it, expect, afterAll } from "vitest";
import { network, type Network } from "../network.js";
import { buildGraph } from "../graph.js";
import { keptLoopStats, selfLoopStats } from "../self-loops.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost, zoomSteps } from "../../__tests__/engine-sweep.js";

/**
 * Self-link loops (#505) at ≈1M nodes (docs/agents/performance.md), LOD off and on, on WebGL, through the real
 * triggers: a `setTransform` zoom sweep and position frames (`layout({ backend: "positions" })`).
 *
 * Asserted (counts, never scaled):
 * - a graph WITHOUT self-links pays nothing for them: no loop update, no loop instance written, no LOD loop
 *   listing, on any frame, with LOD off or on;
 * - LOD off, with S self-links: a zoom frame does no loop work and creates or destroys no GPU buffer (the
 *   loops' columns stay resident), a position frame rewrites exactly the S loops, in place;
 * - LOD on, with S self-links: each frame lists its kept leaves' loops in at most min(S, frontier) reads and
 *   writes at most that many loop instances: O(visible), never O(S) when the frontier is smaller.
 * - LOD on, a looped hub of degree HUB_DEGREE (never scaled): a zoom frame reads none of its neighbours — its loop's
 *   angle is solved at most once per position change, then copied (the Σ degree term is off the zoom path).
 * - LOD off, at a fixed small N (never scaled): what the loops add to a position frame — draw calls, vertices
 *   drawn, loop instances written — is the same per loop at N and 2N, so a superlinear step (a per-loop draw or
 *   upload, an O(S²) vertex count) shows at 5k–10k without a 100k run. Counts, so the machine's load cannot move it.
 * The full-detail zoom frame also keeps the static ceiling of `network-selection-sweep-1m-perf`.
 */

const N = perfN(1_000_000, { max: 1_000_000 });
/** One node in LOOP_EVERY has a self-link. */
const LOOP_EVERY = 10;
const S = Math.ceil(N / LOOP_EVERY);
const W = 640;
const H = 400;
const FRAME_MS_STATIC = perfBudget(4 + (4 * N) / 50_000);
const POSITION_FRAMES = 3;

/**
 * Wait for the GPU to finish the leg's queued draws (a 1×1 read-back), so the next leg's first synchronous GL
 * call (a shader link at its registration) does not pay this leg's backlog. Without it, the leg after a 100k
 * leg looked superlinear on SwiftShader (#505: 150 s for the S-loops leg after the no-loop leg, 10 s alone).
 */
function drainGpu(host: HTMLElement): void {
  const gl = host.querySelector("canvas")?.getContext("webgl2");
  gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
}

/** A binary tree on a square grid (as the selection sweep's), with a self-link on every LOOP_EVERY-th node. */
function fixture(n: number, loops: boolean): { graph: ReturnType<typeof buildGraph>; positions: Float32Array } {
  const cols = Math.max(1, Math.round(Math.sqrt(n)));
  const positions = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    positions[i * 2] = (i % cols) * 8;
    positions[i * 2 + 1] = Math.floor(i / cols) * 8;
  }
  const m = n - 1 + (loops ? Math.ceil(n / LOOP_EVERY) : 0);
  const source = new Int32Array(m);
  const target = new Int32Array(m);
  let e = 0;
  for (let i = 1; i < n; i++) {
    source[e] = i;
    target[e++] = Math.floor(i / 2);
  }
  if (loops)
    for (let i = 0; i < n; i += LOOP_EVERY) {
      source[e] = i;
      target[e++] = i;
    }
  return { graph: buildGraph({ nodeCount: n, source, target, directed: false }), positions };
}

interface Leg {
  zoomFrames: number;
  worstZoomMs: number;
  zoomLoopUpdates: number;
  zoomLoopInstances: number;
  zoomCreated: number;
  zoomDeleted: number;
  /** Per zoom frame (LOD on): loop entries read, loop instances written, and the frontier the cut thinned. */
  perFrame: { reads: number; instances: number; glyphs: number }[];
  listedFrames: number;
  positionUpdates: number;
  positionInstances: number;
  registered: number;
}

async function runLeg(loops: boolean, lod: boolean): Promise<Leg> {
  const host = perfHost(W, H);
  const net: Network = network(host, { width: W, height: H, backend: "webgl" });
  const spy = new GlBufferSpy();
  try {
    await net.whenReady();
    const { graph, positions } = fixture(N, loops);
    const atStart = spy.mark();
    net
      .data(graph)
      .style({ nodeRadius: 3, sizeMode: "screen", linkStroke: "rgb(100,116,139)" })
      .lod(lod ? {} : false)
      .layout({ backend: "positions", positions });
    net.setTransform({ k: 1, x: 0, y: 0 }); // settle the registration's first frame outside the sweep
    const registered = spy.since(atStart).uploadedBytes;
    const u0 = selfLoopStats.updates;
    const i0 = selfLoopStats.instances;
    const f0 = keptLoopStats.frames;
    const before = spy.mark();
    const perFrame: Leg["perFrame"] = [];
    let worstZoomMs = 0;
    const steps = zoomSteps(W, H);
    for (const t of [...steps, ...steps.slice().reverse()]) {
      const r = keptLoopStats.reads;
      const inst = selfLoopStats.instances;
      const t0 = performance.now();
      net.setTransform(t);
      worstZoomMs = Math.max(worstZoomMs, performance.now() - t0);
      perFrame.push({ reads: keptLoopStats.reads - r, instances: selfLoopStats.instances - inst, glyphs: net.declutterStats?.glyphs ?? N });
    }
    const used = spy.since(before);
    const zoomLoopUpdates = selfLoopStats.updates - u0;
    const zoomLoopInstances = selfLoopStats.instances - i0;
    const listedFrames = keptLoopStats.frames - f0;
    // Position frames: the layout moves every node a little, at the fit view.
    net.setTransform({ k: 1, x: 0, y: 0 });
    const pu = selfLoopStats.updates;
    const pi = selfLoopStats.instances;
    const moved = new Float32Array(positions.length);
    // LOD legs skip them: the guard asserts LOD's zoom frames, and each LOD position frame rebuilds a 1M-leaf tree.
    for (let f = 1; f <= (lod ? 0 : POSITION_FRAMES); f++) {
      for (let i = 0; i < positions.length; i++) moved[i] = (positions[i] ?? 0) + f;
      net.layout({ backend: "positions", positions: moved.slice() });
      net.render();
    }
    return {
      zoomFrames: perFrame.length,
      worstZoomMs,
      zoomLoopUpdates,
      zoomLoopInstances,
      zoomCreated: used.created,
      zoomDeleted: used.deleted,
      perFrame,
      listedFrames,
      positionUpdates: selfLoopStats.updates - pu,
      positionInstances: selfLoopStats.instances - pi,
      registered,
    };
  } finally {
    drainGpu(host);
    spy.restore();
    net.destroy();
    host.remove();
  }
}

const TIMEOUT = perfBudget(180_000 + N / 2);

/** The looped hub's degree: a star whose centre has a self-link (fixed, ≥ 10⁵: the degree is what is guarded). */
const HUB_DEGREE = 100_000;

/** Per zoom frame of an LOD-on sweep over the looped hub: the loop instances written, the neighbours read. */
async function hubLeg(): Promise<{ perFrame: { instances: number; neighbours: number }[]; row: number }> {
  const host = perfHost(W, H);
  const net: Network = network(host, { width: W, height: H, backend: "webgl" });
  try {
    await net.whenReady();
    // The hub at the zoom centre (the sweep zooms about the viewport's middle), between the grid points its leaves
    // sit on (8 apart, as the main fixture's), so the deepest zooms keep it as a leaf.
    const n = HUB_DEGREE + 1;
    const cols = Math.ceil(Math.sqrt(HUB_DEGREE));
    const positions = new Float32Array(2 * n);
    positions[0] = W / 2 + 4;
    positions[1] = H / 2 + 4;
    for (let i = 1; i < n; i++) {
      positions[2 * i] = ((i - 1) % cols) * 8;
      positions[2 * i + 1] = Math.floor((i - 1) / cols) * 8;
    }
    const source = new Int32Array(n);
    const target = new Int32Array(n);
    for (let i = 1; i < n; i++) target[i - 1] = i; // source 0: the hub
    // The last edge, source = target = 0: the hub's self-link.
    const graph = buildGraph({ nodeCount: n, source, target, directed: false });
    net
      .data(graph)
      .style({ nodeRadius: 3, sizeMode: "screen", linkStroke: "rgb(100,116,139)" })
      .lod({})
      .layout({ backend: "positions", positions });
    net.setTransform({ k: 1, x: 0, y: 0 });
    const perFrame: { instances: number; neighbours: number }[] = [];
    const steps = zoomSteps(W, H);
    for (const t of [...steps, ...steps.slice().reverse()]) {
      const inst = selfLoopStats.instances;
      const nb = selfLoopStats.neighbours;
      net.setTransform(t);
      perFrame.push({ instances: selfLoopStats.instances - inst, neighbours: selfLoopStats.neighbours - nb });
    }
    // One solve of the hub's angle reads its CSR row: its HUB_DEGREE neighbours and its self-link (skipped).
    return { perFrame, row: (graph.csr.offsets[1] ?? 0) - (graph.csr.offsets[0] ?? 0) };
  } finally {
    drainGpu(host);
    net.destroy();
    host.remove();
  }
}

/** Draw calls and vertices (instances × vertices per instance) the WebGL2 context issues while installed. */
class GlDrawSpy {
  calls = 0;
  vertices = 0;
  private readonly proto = WebGL2RenderingContext.prototype;
  private readonly arrays = this.proto.drawArrays;
  private readonly elements = this.proto.drawElements;
  private readonly arraysInstanced = this.proto.drawArraysInstanced;
  private readonly elementsInstanced = this.proto.drawElementsInstanced;

  constructor() {
    const spy = this;
    this.proto.drawArrays = function (this: WebGL2RenderingContext, mode: GLenum, first: GLint, count: GLsizei) {
      spy.calls++;
      spy.vertices += count;
      spy.arrays.call(this, mode, first, count);
    };
    this.proto.drawElements = function (this: WebGL2RenderingContext, mode: GLenum, count: GLsizei, type: GLenum, offset: GLintptr) {
      spy.calls++;
      spy.vertices += count;
      spy.elements.call(this, mode, count, type, offset);
    };
    this.proto.drawArraysInstanced = function (this: WebGL2RenderingContext, mode: GLenum, first: GLint, count: GLsizei, instances: GLsizei) {
      spy.calls++;
      spy.vertices += count * instances;
      spy.arraysInstanced.call(this, mode, first, count, instances);
    };
    this.proto.drawElementsInstanced = function (this: WebGL2RenderingContext, mode: GLenum, count: GLsizei, type: GLenum, offset: GLintptr, instances: GLsizei) {
      spy.calls++;
      spy.vertices += count * instances;
      spy.elementsInstanced.call(this, mode, count, type, offset, instances);
    };
  }

  restore(): void {
    this.proto.drawArrays = this.arrays;
    this.proto.drawElements = this.elements;
    this.proto.drawArraysInstanced = this.arraysInstanced;
    this.proto.drawElementsInstanced = this.elementsInstanced;
  }
}

interface FrameWork {
  calls: number;
  vertices: number;
  instances: number;
}

/** The draw work and loop instances of one LOD-off position frame at `n` nodes (mean of POSITION_FRAMES). */
async function positionFrameWork(n: number, loops: boolean): Promise<FrameWork> {
  const host = perfHost(W, H);
  const net: Network = network(host, { width: W, height: H, backend: "webgl" });
  const spy = new GlDrawSpy();
  try {
    await net.whenReady();
    const { graph, positions } = fixture(n, loops);
    net
      .data(graph)
      .style({ nodeRadius: 3, sizeMode: "screen", linkStroke: "rgb(100,116,139)" })
      .lod(false)
      .layout({ backend: "positions", positions });
    net.setTransform({ k: 1, x: 0, y: 0 });
    const c0 = spy.calls;
    const v0 = spy.vertices;
    const i0 = selfLoopStats.instances;
    const moved = new Float32Array(positions.length);
    for (let f = 1; f <= POSITION_FRAMES; f++) {
      for (let i = 0; i < positions.length; i++) moved[i] = (positions[i] ?? 0) + f;
      net.layout({ backend: "positions", positions: moved.slice() });
      net.render();
    }
    return {
      calls: (spy.calls - c0) / POSITION_FRAMES,
      vertices: (spy.vertices - v0) / POSITION_FRAMES,
      instances: (selfLoopStats.instances - i0) / POSITION_FRAMES,
    };
  } finally {
    drainGpu(host);
    spy.restore();
    net.destroy();
    host.remove();
  }
}

/** What S loops add to a position frame at `n` nodes: the frame with them minus the frame without. */
async function loopFrameWork(n: number): Promise<FrameWork> {
  const without = await positionFrameWork(n, false);
  const withLoops = await positionFrameWork(n, true);
  return { calls: withLoops.calls - without.calls, vertices: withLoops.vertices - without.vertices, instances: withLoops.instances - without.instances };
}

describe(`self-link loops per frame (#505) at N=${N.toLocaleString()}, S=${S.toLocaleString()}`, () => {
  afterAll(() => document.body.replaceChildren());

  it(
    "LOD off, no self-links: no loop work on a zoom or a position frame",
    async () => {
      const leg = await runLeg(false, false);
      expect(leg.registered, "registration uploaded nothing — the spy is not observing the live context").toBeGreaterThan(0);
      expect(leg.zoomLoopUpdates + leg.zoomLoopInstances + leg.listedFrames).toBe(0);
      expect(leg.positionUpdates + leg.positionInstances).toBe(0);
      console.log(`  LOD off, no self-links: worst zoom frame ${leg.worstZoomMs.toFixed(2)} ms`);
    },
    TIMEOUT,
  );

  it(
    "LOD off, S self-links: a zoom frame does no loop work and churns no buffer; a position frame rewrites the S loops",
    async () => {
      const leg = await runLeg(true, false);
      expect(leg.zoomLoopUpdates, "a zoom frame updated the loops").toBe(0);
      expect(leg.zoomLoopInstances, "a zoom frame wrote loop instances").toBe(0);
      expect(leg.zoomCreated, "GPU buffers created during the sweep").toBe(0);
      expect(leg.zoomDeleted, "GPU buffers destroyed during the sweep").toBe(0);
      expect(leg.positionUpdates, "the position frames never reached the loops (non-vacuity)").toBeGreaterThan(0);
      expect(leg.positionUpdates, "more than one loop update per position frame").toBeLessThanOrEqual(POSITION_FRAMES);
      expect(leg.positionInstances, "a loop update wrote other than the S loops").toBe(leg.positionUpdates * S);
      expect(leg.worstZoomMs, `worst zoom frame ${leg.worstZoomMs.toFixed(2)} ms`).toBeLessThan(FRAME_MS_STATIC);
      console.log(`  LOD off, S=${S}: worst zoom frame ${leg.worstZoomMs.toFixed(2)} ms, ${leg.positionUpdates} loop updates over ${POSITION_FRAMES} position frames`);
    },
    TIMEOUT,
  );

  it(
    "LOD off: what S loops add to a position frame is linear in S (5k vs 10k nodes, never scaled)",
    async () => {
      const small = await loopFrameWork(5_000);
      const large = await loopFrameWork(10_000);
      const sSmall = Math.ceil(5_000 / LOOP_EVERY);
      const sLarge = Math.ceil(10_000 / LOOP_EVERY);
      expect(small.instances, "the position frames never reached the loops (non-vacuity)").toBe(sSmall);
      expect(large.instances).toBe(sLarge);
      expect(small.vertices, "the loops drew nothing (non-vacuity)").toBeGreaterThan(0);
      expect(large.calls, `loop draw calls per frame grew with S: ${small.calls} at S=${sSmall}, ${large.calls} at S=${sLarge}`).toBe(small.calls);
      expect(large.vertices / sLarge, `vertices drawn per loop grew with S: ${small.vertices / sSmall} at S=${sSmall}`).toBeLessThanOrEqual(small.vertices / sSmall);
      console.log(`  LOD off, per position frame the loops add ${small.calls} draws, ${small.vertices / sSmall} vertices per loop`);
    },
    perfBudget(180_000),
  );

  it(
    "LOD on, no self-links: no LOD frame lists or writes a loop",
    async () => {
      const leg = await runLeg(false, true);
      expect(leg.listedFrames, "an LOD frame listed loops of a graph without self-links").toBe(0);
      expect(leg.zoomLoopInstances + leg.positionInstances).toBe(0);
      console.log(`  LOD on, no self-links: worst zoom frame ${leg.worstZoomMs.toFixed(2)} ms`);
    },
    TIMEOUT,
  );

  it(
    "LOD on, S self-links: each frame reads at most min(S, frontier) entries and writes at most that many loops",
    async () => {
      const leg = await runLeg(true, true);
      expect(leg.listedFrames, "no LOD frame listed the kept leaves' loops (non-vacuity)").toBeGreaterThan(0);
      expect(leg.perFrame.some((f) => f.instances > 0), "no frame drew a loop: the sweep never reached the leaves").toBe(true);
      for (const [k, f] of leg.perFrame.entries()) {
        const bound = Math.min(S, f.glyphs);
        expect(f.reads, `frame ${k}: ${f.reads} reads, frontier ${f.glyphs}, S ${S}`).toBeLessThanOrEqual(bound);
        expect(f.instances, `frame ${k}: ${f.instances} loops written`).toBeLessThanOrEqual(f.reads);
      }
      const worst = Math.max(...leg.perFrame.map((f) => f.reads));
      console.log(`  LOD on, S=${S}: worst zoom frame ${leg.worstZoomMs.toFixed(2)} ms, at most ${worst} loop entries read per frame, frontiers ${leg.perFrame.map((f) => f.glyphs).join("/")}`);
    },
    TIMEOUT,
  );

  it(
    `LOD on, a looped hub of degree ${HUB_DEGREE.toLocaleString()}: a zoom frame reads none of its neighbours`,
    async () => {
      const { perFrame, row } = await hubLeg();
      expect(row).toBeGreaterThanOrEqual(HUB_DEGREE);
      const drawn = perFrame.filter((f) => f.instances > 0).length;
      expect(drawn, "fewer than two zoom frames drew the hub's loop: the guard cannot tell a cached angle from a solved one").toBeGreaterThanOrEqual(2);
      // Positions never move during the sweep, so the hub's angle is solved at most once (by the first frame that
      // draws it, unless the registration's frame already did), and every other frame copies it.
      const total = perFrame.reduce((a, f) => a + f.neighbours, 0);
      expect(total, `neighbours read over the sweep, per frame ${perFrame.map((f) => f.neighbours).join("/")}`).toBeLessThanOrEqual(row);
      console.log(`  LOD on, hub of degree ${HUB_DEGREE}: loop drawn on ${drawn}/${perFrame.length} zoom frames, ${total} neighbours read`);
    },
    perfBudget(180_000),
  );
});
