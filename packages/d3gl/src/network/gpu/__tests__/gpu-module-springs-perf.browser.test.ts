/**
 * Per-tick guard for the GPU module springs (#455, AGENTS.md lifecycle §5). A GPU flat tick — every streamed
 * layout frame's, and a drag reheat's — adds the module springs' passes: the centroid reduction over the
 * leaves in tree order (its gather levels and one range query over the endpoints), the endpoint centroids,
 * the endpoint springs, and one hand-down pass over the leaves in the force pass. The layout moves every node
 * whatever the LOD state, so there is no reduced regime.
 *
 * Asserted:
 *   1. deterministically: the tick with module springs issues exactly those extra draws — a constant
 *      number of passes, never one per module or per link — and allocates no texture, framebuffer or buffer;
 *   2. wall clock: the tick with module springs within a ratio of the same graph's tick without them, at
 *      `PERF_BROWSER_N` (default 30k, capped at 200k as the GPU frame-budget guard is).
 *
 * Calibration (local headless SwiftShader, M1 Max, load average ~20), min of 3 (2 at 200k), tick + sync fence:
 * 30k leaves / 13k module links 42.9 ms with, 45.9 ms without; 200k / 89k links 329 ms with, 338 ms without —
 * the added passes are inside the noise of the tick.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { makeTestDevice } from "./_device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { reduceLayout } from "../segments.js";
import { seedPositions, type LayoutGraph } from "../../force.js";
import { withModuleSprings } from "../../worker-transport.js";
import { largeModuleFixture } from "../../__tests__/module-springs-fixture-large.js";
import { perfBudget, perfN } from "../../../__tests__/perf-budget.js";

const PARAMS = { repulsion: 200, attraction: 0.05, centering: 0.2, alpha: 0.05, theta: 0.7 };

describe("GPU module springs per-tick cost (#455)", () => {
  let device: Device;
  beforeAll(async () => {
    device = await makeTestDevice();
  });

  it("adds a constant number of passes per tick and allocates nothing", () => {
    const n = 30_000;
    const { graph, springs } = largeModuleFixture(n);
    seedPositions(graph, 1280, 800, { force: {} });
    const draws = (g: LayoutGraph): number => {
      const layout = new GpuForceLayout(device, { ...g, positions: g.positions.slice() }, PARAMS, { repulsionMode: "pyramid" });
      layout.runFrame(1); // warm-up
      const draw = vi.spyOn(Model.prototype, "draw");
      const fbo = vi.spyOn(device, "createFramebuffer");
      const tex = vi.spyOn(device, "createTexture");
      const buf = vi.spyOn(device, "createBuffer");
      layout.runFrame(1);
      const count = draw.mock.calls.length;
      layout.runFrame(3);
      expect(fbo).toHaveBeenCalledTimes(0);
      expect(tex).toHaveBeenCalledTimes(0);
      expect(buf).toHaveBeenCalledTimes(0);
      vi.restoreAllMocks();
      layout.destroy();
      return count;
    };
    const plain = draws(graph);
    const withSprings = draws(withModuleSprings(graph, springs));
    // The centroid reduction's gather levels + its range query, the centroids, the endpoint springs (no
    // endpoint here has more springs than one row gathers, so no hub chunk pass), the hand-down.
    expect(withSprings - plain).toBe(reduceLayout(n).levels.length + 4);
  });

  it("a tick with module springs costs about what it does without", () => {
    const LOCAL_N = 30_000;
    const n = perfN(LOCAL_N, { max: 200_000 });
    const { graph, springs } = largeModuleFixture(n);
    seedPositions(graph, 1280, 800, { force: {} });
    const out = new Float32Array(n * 2);
    const REPEATS = n > 100_000 ? 2 : 3;
    const minTick = (g: LayoutGraph): number => {
      let best = Infinity;
      for (let r = 0; r < REPEATS; r++) {
        const layout = new GpuForceLayout(device, { ...g, positions: g.positions.slice() }, PARAMS, { repulsionMode: "pyramid" });
        layout.runFrame(1); // warm-up (compile, first use)
        layout.readPositions(out);
        const t0 = performance.now();
        layout.runFrame(1);
        layout.readPositions(out); // GPU sync fence
        best = Math.min(best, performance.now() - t0);
        layout.destroy();
      }
      return best;
    };
    const plainMs = minTick(graph);
    const springMs = minTick(withModuleSprings(graph, springs));
    console.log(`  GPU module springs: N=${n} links=${springs.source.length}, min-of-${REPEATS} ${springMs.toFixed(1)} ms vs ${plainMs.toFixed(1)} ms without`);
    // The flat tick's own ceiling (gpu-frame-budget-perf), and at most half again the tick without springs.
    expect(springMs).toBeLessThan(perfBudget(200 + 1_000 * (n / LOCAL_N)));
    expect(springMs).toBeLessThan(1.5 * plainMs + perfBudget(10));
  });
});
