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
import { buildCSR, buildGraph } from "../../graph.js";
import type { LayoutGraph } from "../../force.js";
import { buildHubChunks } from "../hub-chunks.js";
import { atlasWidth } from "../textures.js";
import { perfBudget, perfN } from "../../../__tests__/perf-budget.js";

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

/**
 * `base` plus web-NotreDame's five > 4096 hubs (degrees 10,721, 7,636, 7,026, 4,321, 4,283), each linked
 * to that many distinct random nodes — the rows the old gather capped at 4096 (#350). Same node count,
 * so the pyramid (and every other pass) is the same as `base`'s; only the springs differ.
 */
function withHubs(base: LayoutGraph, seed: number): LayoutGraph {
  const rng = makePrng(seed);
  const n = base.nodeCount;
  const hubDegrees = [10_721, 7_636, 7_026, 4_321, 4_283].map((d) => Math.min(d, n - 6));
  const src = Array.from(base.source);
  const tgt = Array.from(base.target);
  hubDegrees.forEach((degree, h) => {
    const offset = Math.floor(rng() * n);
    // A stride walk with a stride coprime to n visits `degree` distinct nodes.
    let stride = 7919;
    while (gcd(stride, n) !== 1) stride += 2;
    for (let k = 0; k < degree; k++) {
      const leaf = (offset + k * stride) % n;
      if (leaf === h) continue;
      src.push(h);
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

/** Counts `drawArrays` calls and records each one's viewport size (the fragments a full-screen pass covers). */
class DrawSpy {
  readonly viewports: string[] = [];
  private readonly orig: WebGL2RenderingContext["drawArrays"];

  constructor() {
    const proto = WebGL2RenderingContext.prototype;
    this.orig = proto.drawArrays;
    const spy = this;
    proto.drawArrays = function (this: WebGL2RenderingContext, mode: GLenum, first: GLint, count: GLsizei): void {
      // luma's context-state tracker answers VIEWPORT from its cache (a plain array); raw WebGL gives an
      // Int32Array.
      const vp: unknown = this.getParameter(this.VIEWPORT);
      spy.viewports.push(vp instanceof Int32Array || Array.isArray(vp) ? `${vp[2]}x${vp[3]}` : "?");
      spy.orig.call(this, mode, first, count);
    };
  }

  restore(): void {
    WebGL2RenderingContext.prototype.drawArrays = this.orig;
  }
}

/** The draws of one tick of `layout`, as viewport sizes (sorted, so two ticks compare as multisets). */
function tickDraws(layout: GpuForceLayout): string[] {
  const spy = new DrawSpy();
  try {
    layout.runFrame(1);
  } finally {
    spy.restore();
  }
  return spy.viewports.slice().sort();
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
    // Linear in N. The only super-linear term is the pyramid's level count, and chooseGrid clamps G
    // at 1024, so L moves just 9→11 across 30k→1M — well inside the ceiling's deliberate 10× headroom.
    const CEILING_MS = perfBudget(10_000 * (N / LOCAL_N));
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

  it("hub springs (#350): a tick with web-NotreDame's > 4096 hubs stays under the same ceiling and near the no-hub tick", () => {
    // Same N and the same clustered base as the no-hub leg above, plus the five hubs (~34k more edges,
    // about half of all CSR entries on hub rows, twice web-NotreDame's 23%). Every hub entry is now
    // gathered — O(2E) — through ≤ HUB_CHUNK-entry chunks, so the tick keeps the no-hub ceiling (the
    // chunk pass is K ≈ 530 fragments here, next to the N-fragment passes).
    //
    // The ratio leg is the one with teeth: the absolute ceiling is 10× headroom, but a hub branch that
    // runs away on some texels costs a multiple of the whole tick. Measured: a uint wrap on padded
    // texels (ANGLE/Metal keeps executing after `discard`) made this tick 5-7× the no-hub one (348-611 ms
    // vs 49-82 ms, M1 Max); fixed, the two are within noise (springs are a small share of a tick).
    const LOCAL_N = 30_000;
    const N = perfN(LOCAL_N, { max: 200_000 });
    const CEILING_MS = perfBudget(10_000 * (N / LOCAL_N));
    const REPEATS = N > 100_000 ? 2 : 3;
    const plain = makeClusteredGraph(N, 80, 0xdeadbeef);
    const hubbed = withHubs(plain, 0x4ab);
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
      `  GPU frame budget (hubs): N=${N} E=${hubbed.edgeCount} vs ${plain.edgeCount}, ` +
      `min-of-${REPEATS} ${hubMs.toFixed(1)}ms vs ${plainMs.toFixed(1)}ms without hubs (ceiling=${CEILING_MS}ms)`,
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
    const K = buildHubChunks(buildCSR(N, hubbed.source, hubbed.target).offsets).count;
    expect(buildHubChunks(buildCSR(N, plain.source, plain.target).offsets).count).toBe(0);
    expect(K).toBeGreaterThan(0);
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
});
