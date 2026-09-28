/**
 * Per-frame regression tripwire for the GPU force layout (pyramid path).
 *
 * PURPOSE
 * -------
 * This test is a catastrophic-regression tripwire, NOT a performance benchmark.
 * It catches an accidental O(n²) re-introduction or super-linear growth in the
 * pyramid tick path (e.g. rebuilding textures per frame, a nested loop regression).
 * The ceiling is set to ~10× the observed minimum on SwiftShader, which is generous
 * enough to be non-flaky while tight enough to catch an order-of-magnitude drop.
 *
 * SCOPE NOTES
 * -----------
 * (a) Absolute real-GPU ~1M frame-budget is validated MANUALLY on real hardware
 *     (human verification / the website example), since SwiftShader software-GL
 *     timings are not representative of real GPU performance.
 * (b) "Both reduction states (LOD on/off)" from AGENTS.md §5 is a RENDER-path
 *     concept. The layout solver processes all nodes regardless of LOD, so the
 *     LOD on/off distinction does not apply here.
 *
 * DETERMINISTIC SIGNATURES (#349)
 * -------------------------------
 * The wall-clock ceiling cannot see the regression #349 removed: two point-list
 * scatters of all N nodes into ONE texel (centroid ADD, bbox MAX), whose blend
 * serialised on that texel — 17-19 ms each at 325k on a real GPU, yet only ~2×
 * a whole SwiftShader tick at 30k. So the guard also asserts its signature
 * directly: no draw of ≥ N vertices (instances counted, any mode, any of the five
 * WebGL2 draw calls) into a 1×1 viewport, per tick (the grid-pyramid scatter, a
 * POINTS draw of N vertices into a G×G viewport, is the non-vacuity control, and a
 * spy self-test proves every draw entry point is seen); and zero texture /
 * framebuffer / buffer creation per tick.
 *
 * TILE PYRAMID (#354)
 * -------------------
 * The pyramid's levels are packed into three textures (L0 / Podd / Peven), so a
 * reduce pass renders into a texture that also holds other levels. Its signature:
 * per tick, ONE scatter into the L0 atlas and ONE reduce per coarser level, each
 * rasterising exactly its level's rectangle — Σ_{ℓ≥1} (A>>ℓ)(H>>ℓ) < A·H/3
 * fragments, the same pass count and fragment count as one texture per level. A
 * reduce that lost its viewport would rasterise its whole packed texture (and
 * overwrite the other levels there).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { makeTestDevice } from "./_device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { buildCSR, buildGraph } from "../../graph.js";
import { MIN_SETTLE_TICKS, type LayoutGraph } from "../../force.js";
import { buildHubChunks, SPRING_CHUNK } from "../hub-chunks.js";
import { FLAT_TILE_MIN_SIDE, flatSegments, packTiles, type PyramidTexture } from "../segments.js";
import { GridPyramid } from "../passes/grid-pyramid.js";
import { STOP_STOPPED } from "../stop-latch.js";
import { atlasWidth } from "../textures.js";
import { perfBudget, perfN } from "../../../__tests__/perf-budget.js";

/** One draw call as the spy saw it: primitive mode, vertices × instances, and the viewport size. */
interface SpiedDraw {
  mode: GLenum;
  vertices: number;
  width: number;
  height: number;
}

/**
 * Records every draw — all five WebGL2 draw entry points, instances folded into the vertex count —
 * with the viewport it rasterises into (read from the context at draw time). Patches the
 * prototype — cast-free — and restores it.
 */
class DrawSpy {
  readonly draws: SpiedDraw[] = [];
  private readonly origArrays: WebGL2RenderingContext["drawArrays"];
  private readonly origArraysInstanced: WebGL2RenderingContext["drawArraysInstanced"];
  private readonly origElements: WebGL2RenderingContext["drawElements"];
  private readonly origElementsInstanced: WebGL2RenderingContext["drawElementsInstanced"];
  private readonly origRangeElements: WebGL2RenderingContext["drawRangeElements"];

  constructor() {
    const proto = WebGL2RenderingContext.prototype;
    this.origArrays = proto.drawArrays;
    this.origArraysInstanced = proto.drawArraysInstanced;
    this.origElements = proto.drawElements;
    this.origElementsInstanced = proto.drawElementsInstanced;
    this.origRangeElements = proto.drawRangeElements;
    const spy = this;
    proto.drawArrays = function (this: WebGL2RenderingContext, mode: GLenum, first: GLint, count: GLsizei): void {
      spy.record(this, mode, count);
      spy.origArrays.call(this, mode, first, count);
    };
    proto.drawArraysInstanced = function (
      this: WebGL2RenderingContext, mode: GLenum, first: GLint, count: GLsizei, instances: GLsizei,
    ): void {
      spy.record(this, mode, count * instances);
      spy.origArraysInstanced.call(this, mode, first, count, instances);
    };
    proto.drawElements = function (
      this: WebGL2RenderingContext, mode: GLenum, count: GLsizei, type: GLenum, offset: GLintptr,
    ): void {
      spy.record(this, mode, count);
      spy.origElements.call(this, mode, count, type, offset);
    };
    proto.drawElementsInstanced = function (
      this: WebGL2RenderingContext, mode: GLenum, count: GLsizei, type: GLenum, offset: GLintptr, instances: GLsizei,
    ): void {
      spy.record(this, mode, count * instances);
      spy.origElementsInstanced.call(this, mode, count, type, offset, instances);
    };
    proto.drawRangeElements = function (
      this: WebGL2RenderingContext, mode: GLenum, start: GLuint, end: GLuint, count: GLsizei, type: GLenum,
      offset: GLintptr,
    ): void {
      spy.record(this, mode, count);
      spy.origRangeElements.call(this, mode, start, end, count, type, offset);
    };
  }

  private record(gl: WebGL2RenderingContext, mode: GLenum, vertices: number): void {
    const viewport: Int32Array = gl.getParameter(gl.VIEWPORT);
    this.draws.push({ mode, vertices, width: viewport[2] ?? 0, height: viewport[3] ?? 0 });
  }

  restore(): void {
    const proto = WebGL2RenderingContext.prototype;
    proto.drawArrays = this.origArrays;
    proto.drawArraysInstanced = this.origArraysInstanced;
    proto.drawElements = this.origElements;
    proto.drawElementsInstanced = this.origElementsInstanced;
    proto.drawRangeElements = this.origRangeElements;
  }
}

/** Minimal seeded LCG PRNG — self-contained, no deps. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(1664525, s) + 1013904223;
    return (s >>> 0) / 0x100000000;
  };
}

/**
 * Build a clustered graph of `count` nodes distributed across `communities`
 * communities with intra-community edges; a realistic force-layout input.
 */
function makeClusteredGraph(count: number, communities: number, seed: number): LayoutGraph {
  const rng = makePrng(seed);
  const src: number[] = [];
  const tgt: number[] = [];
  // ~1.5 edges per node on average: mostly intra-community, a few cross-community.
  for (let i = 0; i < count; i++) {
    const myComm = Math.floor((i / count) * communities);
    // intra-community edge
    const commStart = Math.floor((myComm / communities) * count);
    const commEnd = Math.floor(((myComm + 1) / communities) * count);
    const peer = commStart + Math.floor(rng() * Math.max(1, commEnd - commStart));
    src.push(i);
    tgt.push(peer % count);
    // ~25% chance of a cross-community edge
    if (rng() < 0.25) {
      src.push(i);
      tgt.push(Math.floor(rng() * count));
    }
  }
  const g = buildGraph({ nodeCount: count, source: src, target: tgt });
  for (let i = 0; i < count; i++) {
    g.positions[i * 2] = (rng() - 0.5) * 2000;
    g.positions[i * 2 + 1] = (rng() - 0.5) * 2000;
  }
  return g;
}

/** web-NotreDame's five hubs above the old 4096 cap (the rows it truncated, #350). */
const CAPPED_HUBS = [10_721, 7_636, 7_026, 4_321, 4_283];
/** web-NotreDame's hub rows (> SPRING_CHUNK entries) per node: 1,705 of 325,729. */
const HUB_ROW_SHARE = 1_705 / 325_729;

/**
 * Hub row degrees in web-NotreDame's shape, scaled to `n` nodes: {@link CAPPED_HUBS} plus enough rows
 * between 257 and 4096 entries to make 0.52% of the rows hubs. Those follow a truncated power law
 * (CCDF exponent 2.9, sampled at stratified quantiles, so deterministic) whose mean, ~390 entries,
 * matches web-NotreDame's 1,700 such rows (667,655 entries, mean 393). So the chunk count K grows with N
 * as it does there (K ≈ N/29 on web-NotreDame).
 */
function hubDegrees(n: number): number[] {
  const rows = Math.max(CAPPED_HUBS.length, Math.round(n * HUB_ROW_SHARE));
  const lo = SPRING_CHUNK + 1;
  const hi = 4_096;
  const beta = 2.9;
  const t = 1 - (lo / hi) ** beta;
  const m = rows - CAPPED_HUBS.length;
  const tail = Array.from({ length: m }, (_, i) => Math.round(lo * (1 - ((i + 0.5) / m) * t) ** (-1 / beta)));
  return [...CAPPED_HUBS, ...tail].map((d) => Math.min(d, n - 1));
}

/**
 * `base` plus hub rows in web-NotreDame's shape ({@link hubDegrees}): each hub is linked to `degree`
 * distinct random nodes. Same node count, so the pyramid (and every other pass) is the same as `base`'s.
 *
 * With `spread`, the same leaf endpoints are linked to random nodes instead of to the hubs: the same
 * edge count and CSR size, but no row near {@link SPRING_CHUNK}. That twin is the ratio leg's control,
 * so the ratio isolates the hub path (chunk pass + partial gather) from the extra springs themselves.
 */
function withHubs(base: LayoutGraph, seed: number, spread = false): LayoutGraph {
  const rng = makePrng(seed);
  // Its own stream, so the twin keeps the same hub offsets, hence the same leaves and edge count.
  const spreadRng = makePrng(seed ^ 0x9e3779b9);
  const n = base.nodeCount;
  const degrees = hubDegrees(n);
  const src = Array.from(base.source);
  const tgt = Array.from(base.target);
  // A stride walk with a stride coprime to n visits `degree` distinct nodes.
  let stride = 7919;
  while (gcd(stride, n) !== 1) stride += 2;
  degrees.forEach((degree, h) => {
    const hub = Math.floor(((h + 0.5) * n) / degrees.length);
    const offset = Math.floor(rng() * n);
    for (let k = 0; k < degree; k++) {
      const leaf = (offset + k * stride) % n;
      if (leaf === hub) continue;
      const other = spread ? Math.floor(spreadRng() * n) : hub;
      src.push(other === leaf ? (leaf + 1) % n : other);
      tgt.push(leaf);
    }
  });
  return {
    nodeCount: n,
    edgeCount: src.length,
    source: Uint32Array.from(src),
    target: Uint32Array.from(tgt),
    positions: base.positions.slice(),
  };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** The hub chunk count K of `graph`'s CSR (0 when no row is longer than SPRING_CHUNK). */
function chunkCount(graph: LayoutGraph): number {
  return buildHubChunks(buildCSR(graph.nodeCount, graph.source, graph.target).offsets).count;
}

/**
 * The draws of one tick of `layout`, as the size each draw rasterises — its pass's viewport, else the
 * framebuffer it renders into: the fragments a full-screen pass covers (sorted, so two ticks compare as
 * multisets). The viewport matters for the tile pyramid's packed levels (#354), whose reduces each write
 * their level's rectangle of a larger texture. Every GPU layout pass draws through luma's `Model.draw`.
 */
function tickDraws(layout: GpuForceLayout): string[] {
  const spy = vi.spyOn(Model.prototype, "draw");
  try {
    layout.runFrame(1);
    return spy.mock.calls
      .map(([pass]) => {
        const vp = pass.props.parameters?.viewport;
        if (vp) return `${vp[2] ?? 0}x${vp[3] ?? 0}`;
        const fbo = pass.props.framebuffer;
        return fbo ? `${fbo.width}x${fbo.height}` : "canvas";
      })
      .sort();
  } finally {
    spy.mockRestore();
  }
}

describe("GPU frame budget — pyramid path (per-tick regression tripwire)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("a single pyramid tick stays under the catastrophic-regression ceiling", () => {
    // N=30000 nodes, 80 communities, pyramid repulsion (forced via repulsionMode).
    // SwiftShader is software GL, so absolute timings are slow but the relative
    // signature of a regression (order-of-magnitude slower) is still detectable.
    //
    // Ceiling rationale (recalibrated for #349): the measured tick (one tick + the position readback
    // fence, min of 3) on local headless SwiftShader, under a load average of ~25, is
    //   30k: 84-97 ms · 100k: 342-343 ms · 200k: 680-686 ms  (3 interleaved rounds)
    // i.e. linear at ~3.4 ms per 1k nodes with an intercept indistinguishable from 0. The ceiling is
    // ~10× that — enough headroom for a 2× contended run, tight enough that an order-of-magnitude
    // slowdown (an O(n²) re-introduction, per-tick texture rebuilds) trips it. It cannot see a
    // reintroduced 1-texel scatter, which only doubles a SwiftShader tick: the draw spy below does.
    // The browser tier can raise N via PERF_BROWSER_N (#262). Capped: this file constructs the
    // layout several times over and a 1M tick is ~30× a 30k one, which would spend the tier's whole
    // 300s per-file budget here — the file would be killed rather than report a ceiling.
    const LOCAL_N = 30_000; // the N the ceiling is calibrated at
    const N = perfN(LOCAL_N, { max: 200_000 });
    // Split into a constant and a linear term (AGENTS "Scaling a browser guard"): 1.2 s at LOCAL_N,
    // 3.5 s at 100k, 6.9 s at 200k. The measured intercept is ~0, so the constant is only a floor
    // against scheduler jitter; the linear term is 10× the measured slope. The only super-linear term
    // is the pyramid's level count, and chooseGrid clamps G at 1024, so L moves just 9→11 across
    // 30k→1M — inside the linear term's headroom.
    const CEILING_MS = perfBudget(200 + 1_000 * (N / LOCAL_N));
    const REPEATS = N > 100_000 ? 2 : 3;

    const g = makeClusteredGraph(N, 80, 0xdeadbeef);
    const params = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };
    const out = new Float32Array(N * 2);

    // Warm-up: construct + one tick (shader compile / first-use costs excluded from timing).
    const warmup = new GpuForceLayout(device, g, params, { repulsionMode: "pyramid" });
    warmup.runFrame(1);
    warmup.readPositions(out); // GPU sync fence
    warmup.destroy();

    // Measure: min over REPEATS fresh layouts (fresh positions each time).
    let minMs = Infinity;
    for (let r = 0; r < REPEATS; r++) {
      const gg: LayoutGraph = {
        nodeCount: g.nodeCount,
        edgeCount: g.edgeCount,
        source: g.source,
        target: g.target,
        positions: g.positions.slice(),
      };
      const layout = new GpuForceLayout(device, gg, params, { repulsionMode: "pyramid" });
      layout.runFrame(1); // warm-up tick for this instance
      const t0 = performance.now();
      layout.runFrame(1);
      layout.readPositions(out); // GPU sync fence — ensures GPU work is complete before stopping the clock
      const dt = performance.now() - t0;
      layout.destroy();
      if (dt < minMs) minMs = dt;
    }

    console.log(
      `  GPU frame budget: N=${N} pyramid, min-of-${REPEATS}=${minMs.toFixed(1)}ms` +
      ` (ceiling=${CEILING_MS}ms on SwiftShader; real-GPU ~1M validated manually)`,
    );

    expect(minMs).toBeLessThan(CEILING_MS);
  });

  it("the draw spy sees every WebGL2 draw entry point, instanced or indexed", () => {
    // Non-vacuity for the #349 signature below: a 1-texel scatter written as an instanced or an
    // indexed draw must be recorded too, with instances folded into the vertex count. No program is
    // bound, so GL rejects each draw (INVALID_OPERATION) after the spy has seen it.
    const gl = document.createElement("canvas").getContext("webgl2");
    expect(gl).not.toBeNull();
    if (gl === null) return;
    gl.viewport(0, 0, 1, 1);
    const spy = new DrawSpy();
    try {
      gl.drawArrays(gl.POINTS, 0, 7);
      gl.drawArraysInstanced(gl.POINTS, 0, 1, 11);
      gl.drawElements(gl.POINTS, 13, gl.UNSIGNED_INT, 0);
      gl.drawElementsInstanced(gl.TRIANGLES, 3, gl.UNSIGNED_INT, 0, 17);
      gl.drawRangeElements(gl.POINTS, 0, 18, 19, gl.UNSIGNED_INT, 0);
    } finally {
      spy.restore();
    }
    expect(spy.draws).toEqual([
      { mode: gl.POINTS, vertices: 7, width: 1, height: 1 },
      { mode: gl.POINTS, vertices: 11, width: 1, height: 1 },
      { mode: gl.POINTS, vertices: 13, width: 1, height: 1 },
      { mode: gl.TRIANGLES, vertices: 51, width: 1, height: 1 },
      { mode: gl.POINTS, vertices: 19, width: 1, height: 1 },
    ]);
  });

  it("no tick scatters N points into one texel (the #349 1-px reduction signature)", () => {
    const N = perfN(30_000, { max: 200_000 });
    const g = makeClusteredGraph(N, 80, 0x1e9e1);
    const params = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };
    const layout = new GpuForceLayout(device, g, params, { repulsionMode: "pyramid" });
    const spy = new DrawSpy();
    const points = WebGL2RenderingContext.POINTS;
    try {
      layout.runFrame(3);
      const out = new Float32Array(N * 2);
      layout.readPositions(out);
    } finally {
      spy.restore();
      layout.destroy();
    }
    // Any mode, any entry point: N instanced quads blended into one texel serialise just the same.
    const onePixel = spy.draws.filter((d) => d.vertices >= N && d.width * d.height === 1);
    const scatters = spy.draws.filter((d) => d.mode === points && d.vertices >= N && d.width * d.height > 1);
    expect(onePixel, "draws of ≥ N vertices into a 1×1 viewport").toEqual([]);
    // Non-vacuity: the spy does see the grid-pyramid scatter (N points into a G×G grid), once a tick.
    expect(scatters.length).toBe(3);
  });

  // Every seeded GPU layout (#353, the default) ticks the graph's level on a solver built with `multilevel`,
  // whose reduction, pyramid scatter, all-pairs and traversal programs carry the mass branch: the per-tick
  // signatures below run on both kinds of solver.
  it.each([false, true])("pyramid ticking at N=30000 allocates no framebuffers or textures (all pre-created), multilevel %s", (multilevel) => {
    // Re-affirms the "updated in place, not recreated per frame" AGENTS.md §5 signature
    // at scale on the pyramid path. Mirrors the same assertion from gpu-pyramid.browser.test.ts
    // but at a larger N representative of the hot path.
    const N = 30_000;
    const g = makeClusteredGraph(N, 80, 0xcafe1234);
    const params = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };

    const layout = new GpuForceLayout(device, g, params, { repulsionMode: "pyramid", multilevel });

    // Reset spies AFTER construction (construction legitimately allocates).
    const fboSpy = vi.spyOn(device, "createFramebuffer");
    const texSpy = vi.spyOn(device, "createTexture");
    const bufSpy = vi.spyOn(device, "createBuffer");
    // Warm-up tick also post-construction to rule out lazy init.
    layout.runFrame(1);
    // Reset counts (warm-up must also be zero, but reset here to be explicit).
    fboSpy.mockClear();
    texSpy.mockClear();
    bufSpy.mockClear();

    layout.runFrame(5);

    expect(fboSpy).toHaveBeenCalledTimes(0);
    expect(texSpy).toHaveBeenCalledTimes(0);
    expect(bufSpy).toHaveBeenCalledTimes(0);

    fboSpy.mockRestore();
    texSpy.mockRestore();
    bufSpy.mockRestore();
    layout.destroy();
  });

  it.each([false, true])("a tick sliced into row bands (#352) is bitwise the unsliced tick, and allocates nothing per band, multilevel %s", (multilevel) => {
    // The streaming transport encodes the force pass one row band at a time (scissored), so one tick's GPU
    // work can span frames. Bands write disjoint texels and each texel gets springs → repulsion →
    // centering in the same order whatever B is, so the result must be BITWISE equal (same program, same
    // inputs). A band that missed its scissor would add a node's force twice; one that skipped rows would
    // drop it — either breaks the equality. Pyramid path, hub rows included (their chunk pass is in P).
    const N = perfN(30_000, { max: 200_000 });
    const g = withHubs(makeClusteredGraph(N, 80, 0xba4d5), 0x51);
    const params = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };
    const TICKS = 3;
    const whole = new GpuForceLayout(device, { ...g, positions: g.positions.slice() }, params, { repulsionMode: "pyramid", multilevel });
    const sliced = new GpuForceLayout(device, { ...g, positions: g.positions.slice() }, params, { repulsionMode: "pyramid", multilevel });
    const a = new Float32Array(N * 2);
    const b = new Float32Array(N * 2);
    try {
      whole.runFrame(TICKS);
      whole.readPositions(a);
      sliced.runFrame(0);
      const fboSpy = vi.spyOn(device, "createFramebuffer");
      const texSpy = vi.spyOn(device, "createTexture");
      const bufSpy = vi.spyOn(device, "createBuffer");
      const draws = vi.spyOn(Model.prototype, "draw");
      for (let t = 0; t < TICKS; t++) {
        sliced.beginTick();
        for (let band = 0; band < 4; band++) sliced.forceBand(band, 4);
        sliced.integrate();
      }
      expect(fboSpy).toHaveBeenCalledTimes(0);
      expect(texSpy).toHaveBeenCalledTimes(0);
      expect(bufSpy).toHaveBeenCalledTimes(0);
      // Each band draws the three force passes (springs, repulsion, centering), each over its rows only.
      const forceDraws = draws.mock.calls.filter(([pass]) => pass.props.parameters?.scissorRect !== undefined);
      expect(forceDraws.length).toBe(TICKS * 4 * 3);
      fboSpy.mockRestore();
      texSpy.mockRestore();
      bufSpy.mockRestore();
      draws.mockRestore();
      sliced.readPositions(b);
    } finally {
      whole.destroy();
      sliced.destroy();
    }
    let mismatches = 0;
    for (let i = 0; i < N * 2; i++) if (!Object.is(a[i], b[i])) mismatches++;
    expect(mismatches).toBe(0);
    // Non-vacuity: the ticks moved the layout.
    let moved = 0;
    for (let i = 0; i < N * 2; i++) if (a[i] !== g.positions[i]) moved++;
    expect(moved).toBeGreaterThan(N);
  });

  it("a multilevel solver's ticks of the graph's level are bitwise a flat solver's (#353: the mass branch multiplies by 1)", () => {
    // After a seed the run ticks the graph's level on the multilevel solver: its reduction, scatter and
    // all-pairs programs take the unit-mass branch and the traversal's root level is a uniform. That must change
    // no bit of the flat tick, on the pyramid path (hub rows included) and on the all-pairs path.
    const params = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };
    const TICKS = 3;
    const cases: { mode: "pyramid" | "allpairs"; g: LayoutGraph }[] = [
      { mode: "pyramid", g: withHubs(makeClusteredGraph(perfN(30_000, { max: 200_000 }), 80, 0xf1a7), 0x52) },
      { mode: "allpairs", g: makeClusteredGraph(3_000, 20, 0xa11) },
    ];
    for (const { mode, g } of cases) {
      const n = g.nodeCount;
      const flat = new GpuForceLayout(device, { ...g, positions: g.positions.slice() }, params, { repulsionMode: mode });
      const multi = new GpuForceLayout(device, { ...g, positions: g.positions.slice() }, params, { repulsionMode: mode, multilevel: true });
      const a = new Float32Array(n * 2);
      const b = new Float32Array(n * 2);
      try {
        flat.runFrame(TICKS);
        flat.readPositions(a);
        multi.runFrame(TICKS);
        multi.readPositions(b);
      } finally {
        flat.destroy();
        multi.destroy();
      }
      let mismatches = 0;
      for (let i = 0; i < n * 2; i++) if (!Object.is(a[i], b[i])) mismatches++;
      expect(mismatches, `${mode}: positions differing from the flat solver's`).toBe(0);
      let moved = 0;
      for (let i = 0; i < n * 2; i++) if (a[i] !== g.positions[i]) moved++;
      expect(moved, `${mode}: the ticks did not move the layout`).toBeGreaterThan(n);
    }
  });

  it("hub springs (#350): a tick with web-NotreDame-shaped hub rows stays under the same ceiling and near its hub-free twin", () => {
    // Same N and the same clustered base as the no-hub leg above, plus hub rows in web-NotreDame's shape,
    // scaled with N (hubDegrees): 0.52% of the rows, its five > 4096 hubs, and the rest between 257 and
    // 4096 entries, so the chunk count K grows with N as there (asserted below, K ≥ N/30). That puts
    // about a third of the CSR entries on hub rows (web-NotreDame: 23%), and at the tier's 200k cap the
    // fixture has ~1.4M half-edges. The control is the same edges with the hub endpoints spread over
    // random nodes, so both ticks gather the same CSR and only the hub path (chunk pass + partial gather)
    // differs.
    //
    // The ratio is the assertion with teeth: the absolute ceiling is 10× headroom, but a hub branch that
    // runs away on some texels costs a multiple of the whole tick. Measured with the five hubs alone: a
    // uint wrap on padded texels (ANGLE/Metal keeps executing after `discard`) made this tick 5-7× the
    // no-hub one (348-611 ms vs 49-82 ms, M1 Max); fixed, the two are within noise.
    const LOCAL_N = 30_000;
    const N = perfN(LOCAL_N, { max: 200_000 });
    const CEILING_MS = perfBudget(200 + 1_000 * (N / LOCAL_N)); // the no-hub leg's ceiling (#349 recalibration)
    const REPEATS = N > 100_000 ? 2 : 3;
    const base = makeClusteredGraph(N, 80, 0xdeadbeef);
    const hubbed = withHubs(base, 0x4ab);
    const plain = withHubs(base, 0x4ab, true);
    expect(plain.edgeCount).toBe(hubbed.edgeCount);
    const K = chunkCount(hubbed);
    expect(chunkCount(plain)).toBe(0);
    expect(K).toBeGreaterThanOrEqual(N / 30);
    const params = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };
    const out = new Float32Array(N * 2);

    const minTick = (g: LayoutGraph): number => {
      let minMs = Infinity;
      for (let r = 0; r < REPEATS; r++) {
        const layout = new GpuForceLayout(device, { ...g, positions: g.positions.slice() }, params, { repulsionMode: "pyramid" });
        layout.runFrame(1); // warm-up tick (shader compile, first use)
        layout.readPositions(out);
        const t0 = performance.now();
        layout.runFrame(1);
        layout.readPositions(out); // GPU sync fence
        const dt = performance.now() - t0;
        layout.destroy();
        if (dt < minMs) minMs = dt;
      }
      return minMs;
    };
    const plainMs = minTick(plain);
    const hubMs = minTick(hubbed);
    console.log(
      `  GPU frame budget (hubs): N=${N} E=${hubbed.edgeCount} (${hubDegrees(N).length} hub rows, K=${K}), ` +
      `min-of-${REPEATS} ${hubMs.toFixed(1)}ms vs ${plainMs.toFixed(1)}ms hub-free twin (ceiling=${CEILING_MS}ms)`,
    );
    expect(hubMs).toBeLessThan(CEILING_MS);
    expect(hubMs).toBeLessThan(2 * plainMs + perfBudget(10));
  });

  it("hub springs (#350): the only per-tick addition is ONE chunk draw over K fragments, allocating nothing", () => {
    // The deterministic signature behind "O(2E), and the no-hub case pays nothing": at the same N the
    // hub graph's tick issues exactly the no-hub tick's draws plus one, and that one covers the
    // chunk atlas (K chunks), not the N-node atlas. A graph without hubs compiles no hub branch and
    // encodes no chunk pass (gpu-springs.browser.test.ts pins that at the pass level).
    const N = 30_000;
    const plain = makeClusteredGraph(N, 80, 0xcafe1234);
    const hubbed = withHubs(plain, 0x77);
    const K = chunkCount(hubbed);
    expect(chunkCount(plain)).toBe(0);
    expect(K).toBeGreaterThanOrEqual(N / 30);
    const params = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };

    const plainLayout = new GpuForceLayout(device, plain, params, { repulsionMode: "pyramid" });
    plainLayout.runFrame(1); // warm-up
    const plainDraws = tickDraws(plainLayout);
    plainLayout.destroy();

    const layout = new GpuForceLayout(device, hubbed, params, { repulsionMode: "pyramid" });
    layout.runFrame(1); // warm-up (lazy init must not allocate either, but keep the phases apart)
    const fboSpy = vi.spyOn(device, "createFramebuffer");
    const texSpy = vi.spyOn(device, "createTexture");
    const bufSpy = vi.spyOn(device, "createBuffer");
    const hubDraws = tickDraws(layout);
    layout.runFrame(4);
    expect(fboSpy).toHaveBeenCalledTimes(0);
    expect(texSpy).toHaveBeenCalledTimes(0);
    expect(bufSpy).toHaveBeenCalledTimes(0);
    fboSpy.mockRestore();
    texSpy.mockRestore();
    bufSpy.mockRestore();
    layout.destroy();

    const w = atlasWidth(K);
    const extra = hubDraws.slice();
    for (const d of plainDraws) {
      const at = extra.indexOf(d);
      expect(at).toBeGreaterThanOrEqual(0);
      extra.splice(at, 1);
    }
    expect(extra).toEqual([`${w}x${Math.ceil(K / w)}`]);
  });

  it("tile pyramid (#354): one L0 scatter and one reduce per level, each over exactly its level's rectangle", () => {
    const N = perfN(30_000, { max: 200_000 });
    const g = makeClusteredGraph(N, 80, 0x7117);
    const params = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };
    const atlas = packTiles(flatSegments(N), 0, FLAT_TILE_MIN_SIDE);

    const layout = new GpuForceLayout(device, g, params, { repulsionMode: "pyramid" });
    layout.runFrame(1); // warm-up
    // A draw is attributed to the pyramid texture it renders into by texture IDENTITY, never by size:
    // for N in (W² − W, W²] with W a power of two, the slot atlas is W × W, exactly the size of L0.
    const buildSpy = vi.spyOn(GridPyramid.prototype, "build");
    const spy = vi.spyOn(Model.prototype, "draw");
    const TICKS = 2;
    let draws: { target: PyramidTexture | "other"; viewport: string; fragments: number }[];
    try {
      layout.runFrame(TICKS);
      const pyramid = buildSpy.mock.contexts[0];
      if (!(pyramid instanceof GridPyramid)) throw new Error("the tick did not build the grid pyramid");
      const names: readonly PyramidTexture[] = ["l0", "odd", "even"];
      draws = spy.mock.calls.map(([pass]) => {
        const views = pass.props.framebuffer?.colorAttachments ?? [];
        const target = names.find((name) => views.some((view) => view.texture === pyramid.textures[name])) ?? "other";
        const vp = pass.props.parameters?.viewport;
        const fb = pass.props.framebuffer;
        // What the draw rasterises: its viewport, or the whole attachment without one.
        const fragments = vp ? (vp[2] ?? 0) * (vp[3] ?? 0) : (fb?.width ?? 0) * (fb?.height ?? 0);
        return { target, viewport: vp ? vp.join(",") : "full", fragments };
      });
    } finally {
      spy.mockRestore();
      buildSpy.mockRestore();
      layout.destroy();
    }

    const scatters = draws.filter((d) => d.target === "l0");
    expect(scatters.map(({ target, viewport }) => ({ target, viewport }))).toEqual(
      Array.from({ length: TICKS }, () => ({ target: "l0", viewport: "full" })),
    );
    const reduces = draws.filter((d) => d.target === "odd" || d.target === "even");
    const expected = atlas.levels.slice(1).map((lvl) => ({
      target: lvl.texture,
      viewport: [lvl.x, lvl.y, lvl.width, lvl.height].join(","),
    }));
    expect(reduces.map(({ target, viewport }) => ({ target, viewport }))).toEqual([...expected, ...expected]);
    // The reduces of one tick rasterise Σ_{ℓ≥1} (A>>ℓ)(H>>ℓ) < A·H/3 fragments, counted from the draws'
    // own viewports: independent of packTiles, so a level layout that grew its rectangles fails here.
    const fragmentsPerTick = reduces.reduce((n, d) => n + d.fragments, 0) / TICKS;
    expect(fragmentsPerTick).toBeLessThan((atlas.width * atlas.height) / 3);
  });

  it("the stop latch (#376): one 1-fragment draw per tick and the same draw list unarmed, latching and frozen, allocating nothing", () => {
    // The convergence stop is decided per tick in ONE fragment (the latch), after the range query, and the
    // integrate reads its texel. So a tick draws into 1×1 targets exactly three times — the pyramid's root
    // level, the range query into the segment table, and the latch — and its draw list is the same whether
    // the stop is unarmed, armed and latching in this tick, or latched (a frozen tick: the integrate passes
    // through in-shader). A latch run per band, per level or per slot would show here, and a readback of the
    // step, per tick or on the stop, would allocate.
    const N = perfN(30_000, { max: 200_000 });
    const g = makeClusteredGraph(N, 80, 0x5709);
    const params = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };
    const layout = new GpuForceLayout(device, g, params, { repulsionMode: "pyramid" });
    const state = new Float32Array(4);
    try {
      // Zero heat from rest: nothing moves, so every step is exactly 0 and the latch sets at the first prep
      // it is armed at. The draw list does not depend on the heat.
      layout.hold(0);
      layout.runFrame(1); // warm-up
      const unarmed = tickDraws(layout);
      layout.stopOnConvergence = true;
      layout.hold(0); // a new schedule: armed once it is MIN_SETTLE_TICKS ticks old
      layout.runFrame(MIN_SETTLE_TICKS);
      layout.readStopState(state);
      expect(state[3]).toBe(0);
      const fboSpy = vi.spyOn(device, "createFramebuffer");
      const texSpy = vi.spyOn(device, "createTexture");
      const bufSpy = vi.spyOn(device, "createBuffer");
      const latching = tickDraws(layout); // armed: the latch sets in this tick's prep and freezes its integrate
      const frozen = tickDraws(layout);
      layout.runFrame(4);
      expect(fboSpy).toHaveBeenCalledTimes(0);
      expect(texSpy).toHaveBeenCalledTimes(0);
      expect(bufSpy).toHaveBeenCalledTimes(0);
      fboSpy.mockRestore();
      texSpy.mockRestore();
      bufSpy.mockRestore();
      // Not vacuous: the stop latched at the prep of the tick measured as `latching`.
      layout.readStopState(state);
      expect(state[3]).toBe(STOP_STOPPED);
      expect(state[1]).toBe(MIN_SETTLE_TICKS + 2);
      expect(unarmed.filter((d) => d === "1x1")).toHaveLength(3);
      expect(latching).toEqual(unarmed);
      expect(frozen).toEqual(unarmed);
    } finally {
      layout.destroy();
    }
  }, 120_000);
});
