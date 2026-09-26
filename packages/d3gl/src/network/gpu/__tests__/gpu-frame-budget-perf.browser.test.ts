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
 * directly: no POINTS draw of ≥ N vertices into a 1×1 viewport, per tick (the
 * grid-pyramid scatter, a POINTS draw of N vertices into a G×G viewport, is the
 * non-vacuity control); and zero texture / framebuffer / buffer creation per tick.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { buildGraph } from "../../graph.js";
import type { LayoutGraph } from "../../force.js";
import { perfBudget, perfN } from "../../../__tests__/perf-budget.js";

/**
 * Records every `POINTS` `drawArrays` with its vertex count and the viewport it rasterises into
 * (read from the context at draw time). Patches the prototype — cast-free — and restores it.
 */
class PointDrawSpy {
  readonly draws: Array<{ count: number; width: number; height: number }> = [];
  private readonly orig: WebGL2RenderingContext["drawArrays"];

  constructor() {
    const proto = WebGL2RenderingContext.prototype;
    this.orig = proto.drawArrays;
    const spy = this;
    proto.drawArrays = function (this: WebGL2RenderingContext, mode: GLenum, first: GLint, count: GLsizei): void {
      if (mode === this.POINTS) {
        const viewport: Int32Array = this.getParameter(this.VIEWPORT);
        spy.draws.push({ count, width: viewport[2] ?? 0, height: viewport[3] ?? 0 });
      }
      spy.orig.call(this, mode, first, count);
    };
  }

  restore(): void {
    WebGL2RenderingContext.prototype.drawArrays = this.orig;
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

describe("GPU frame budget — pyramid path (per-tick regression tripwire)", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("a single pyramid tick stays under the catastrophic-regression ceiling", () => {
    // N=30000 nodes, 80 communities, pyramid repulsion (forced via repulsionMode).
    // SwiftShader is software GL, so absolute timings are slow but the relative
    // signature of a regression (order-of-magnitude slower) is still detectable.
    //
    // Ceiling rationale: observed min-of-3 per-tick on SwiftShader is ~300–600ms at
    // N=30k. We set the ceiling at 10000ms (~10× the expected worst-case minimum)
    // so a genuine regression (e.g. O(n²) re-introduction adding another ~30× cost)
    // trips the assertion while normal run-to-run variance never does.
    // The browser tier can raise N via PERF_BROWSER_N (#262). Capped: this file constructs the
    // layout several times over and a 1M tick is ~30× a 30k one, which would spend the tier's whole
    // 300s per-file budget here — the file would be killed rather than report a ceiling.
    const LOCAL_N = 30_000; // the N the 10s ceiling was calibrated at
    const N = perfN(LOCAL_N, { max: 200_000 });
    // Split into a constant and a linear term (AGENTS "Scaling a browser guard"), reducing to exactly
    // the calibrated 10s at LOCAL_N. The constant covers the per-tick pass encode + the pyramid's
    // G-sized reduce levels; the only super-linear term is the pyramid's level count, and chooseGrid
    // clamps G at 1024, so L moves just 9→11 across 30k→1M — inside the linear term's headroom.
    // (#349: the tick measured 225 → 103 ms here on SwiftShader when the 1-px reductions went.)
    const CEILING_MS = perfBudget(2_000 + 8_000 * (N / LOCAL_N));
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

  it("no tick scatters N points into one texel (the #349 1-px reduction signature)", () => {
    const N = perfN(30_000, { max: 200_000 });
    const g = makeClusteredGraph(N, 80, 0x1e9e1);
    const params = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };
    const layout = new GpuForceLayout(device, g, params, { repulsionMode: "pyramid" });
    const spy = new PointDrawSpy();
    try {
      layout.runFrame(3);
      const out = new Float32Array(N * 2);
      layout.readPositions(out);
    } finally {
      spy.restore();
      layout.destroy();
    }
    const onePixel = spy.draws.filter((d) => d.count >= N && d.width * d.height === 1);
    const scatters = spy.draws.filter((d) => d.count >= N && d.width * d.height > 1);
    expect(onePixel, "POINTS draws of ≥ N vertices into a 1×1 viewport").toEqual([]);
    // Non-vacuity: the spy does see the grid-pyramid scatter (N points into a G×G grid), once a tick.
    expect(scatters.length).toBe(3);
  });

  it("pyramid ticking at N=30000 allocates no framebuffers or textures (all pre-created)", () => {
    // Re-affirms the "updated in place, not recreated per frame" AGENTS.md §5 signature
    // at scale on the pyramid path. Mirrors the same assertion from gpu-pyramid.browser.test.ts
    // but at a larger N representative of the hot path.
    const N = 30_000;
    const g = makeClusteredGraph(N, 80, 0xcafe1234);
    const params = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };

    const layout = new GpuForceLayout(device, g, params, { repulsionMode: "pyramid" });

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
});
