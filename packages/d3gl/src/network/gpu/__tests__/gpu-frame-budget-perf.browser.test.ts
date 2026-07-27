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
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { buildGraph } from "../../graph.js";
import type { LayoutGraph } from "../../force.js";
import { perfBudget } from "../../../__tests__/perf-budget.js";

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

  it("single pyramid tick at N=30000 stays under the catastrophic-regression ceiling", () => {
    // N=30000 nodes, 80 communities, pyramid repulsion (forced via repulsionMode).
    // SwiftShader is software GL, so absolute timings are slow but the relative
    // signature of a regression (order-of-magnitude slower) is still detectable.
    //
    // Ceiling rationale: observed min-of-3 per-tick on SwiftShader is ~300–600ms at
    // N=30k. We set the ceiling at 10000ms (~10× the expected worst-case minimum)
    // so a genuine regression (e.g. O(n²) re-introduction adding another ~30× cost)
    // trips the assertion while normal run-to-run variance never does.
    const N = 30_000;
    const CEILING_MS = perfBudget(10_000);
    const REPEATS = 3;

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
    // Warm-up tick also post-construction to rule out lazy init.
    layout.runFrame(1);
    // Reset counts (warm-up must also be zero, but reset here to be explicit).
    fboSpy.mockClear();
    texSpy.mockClear();

    layout.runFrame(5);

    expect(fboSpy).toHaveBeenCalledTimes(0);
    expect(texSpy).toHaveBeenCalledTimes(0);

    fboSpy.mockRestore();
    texSpy.mockRestore();
    layout.destroy();
  });
});
