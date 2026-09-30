import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { DRAG_HEAT, ForceLayout, seedPositions } from "../force.js";
import { ModuleSpringForce } from "../module-springs.js";
import { withModuleSprings } from "../worker-transport.js";
import { largeModuleFixture } from "./module-springs-fixture-large.js";

/**
 * Per-tick guard for the module springs (#455, AGENTS.md lifecycle §5). Every flat force tick — a streamed
 * layout's, and a drag reheat's, one per animation frame on the main-thread `force` backend — adds one
 * {@link ModuleSpringForce.apply}: a pass up the module tree for the centroid sums, one over the module
 * links, one down the tree. O(leaves + modules + module links), whatever the LOD state (the solver moves every
 * node; reductions only shrink what is drawn), so there is no reduced regime to test separately.
 *
 * Asserted:
 *   1. the added work alone at ≈1M leaves (≈111k modules, ≈450k module links) under a wall-clock ceiling split
 *      into its constant and linear terms — always on, at full scale, since it is cheap;
 *   2. the drag frame (a pinned module, one tick) with module springs within a ratio of the same frame
 *      without them — 100k in the normal suite, `BENCH_MODULE_SPRINGS_NODES` (the CI tier's `$PERF_N`) under
 *      `BENCH_MODULE_SPRINGS` — so an added pass of Barnes-Hut scale, or an O(N · depth) walk, trips it.
 * Without module links the solver sees the graph itself and runs no module pass (`module-springs.test.ts`).
 *
 *   BENCH_MODULE_SPRINGS=1 BENCH_MODULE_SPRINGS_NODES=1000000 npx vitest run \
 *     packages/d3gl/src/network/__tests__/module-springs-perf.test.ts
 * Appends to /tmp/module-springs-perf.txt.
 */
const BENCH = !!process.env.BENCH_MODULE_SPRINGS;
const BENCH_N = Number(process.env.BENCH_MODULE_SPRINGS_NODES) || 1_000_000;
const ASSERT = !!process.env.PERF_ASSERT;
// Calibration (M1 Max, load average ~20 from other sessions): apply() at 1M leaves / 111k modules / 444k
// links, median of 5: 10.9-11.7 ms. The drag frame at 100k (44k links): 75-77 ms without springs, 80-87 ms
// with (ratio 1.07-1.13); at 1M: 1005 ms with, 1064 ms without (the ~11 ms of apply() is inside the noise).
// Ceilings: apply ~4.5× (a constant for GC/jitter + a linear term); the frame ratio at 1.5 catches an added
// pass of Barnes-Hut scale (which doubles the frame) with room for contention.
const APPLY_MS_CONST = 10;
const APPLY_MS_PER_M = Number(process.env.PERF_MODULE_SPRINGS_APPLY_MS) || 40;
const RATIO = Number(process.env.PERF_MODULE_SPRINGS_RATIO) || 1.5;
const FRAMES = 5;

const median = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

function applyMs(n: number): number {
  const { graph, springs } = largeModuleFixture(n);
  seedPositions(graph, 1280, 800, { force: {} });
  const force = new ModuleSpringForce(springs);
  const fx = new Float32Array(n);
  const fy = new Float32Array(n);
  force.apply(graph.positions, 0.05, fx, fy); // warm
  const times: number[] = [];
  for (let r = 0; r < FRAMES; r++) {
    const t0 = performance.now();
    force.apply(graph.positions, 0.05, fx, fy);
    times.push(performance.now() - t0);
  }
  return median(times);
}

/** Median drag frame (hold top module 0 at an offset, one tick) with and without the module springs, interleaved. */
function dragFrames(n: number): { withMs: number; withoutMs: number; springs: number } {
  const fixture = largeModuleFixture(n);
  const { graph, springs } = fixture;
  seedPositions(graph, 1280, 800, { force: {} });
  const start = graph.positions.slice();
  const held = fixture.topLeaves(0);
  const sims = [withModuleSprings(graph, springs), withModuleSprings({ ...graph, positions: start.slice() }, undefined)].map((view) => {
    const sim = new ForceLayout(view);
    sim.setPinned(held);
    sim.hold(DRAG_HEAT);
    return { view, sim, times: [] as number[] };
  });
  for (let f = 0; f < FRAMES + 1; f++) {
    for (const s of sims) {
      for (const i of held) s.view.positions[i * 2] = start[i * 2]! + 10 * (f + 1);
      const t0 = performance.now();
      s.sim.tick();
      if (f > 0) s.times.push(performance.now() - t0); // frame 0 warms
    }
  }
  return { withMs: median(sims[0]!.times), withoutMs: median(sims[1]!.times), springs: springs.source.length };
}

describe("module springs per-tick cost (#455)", () => {
  it("apply() at ≈1M leaves stays linear and cheap", () => {
    const n = 1_000_000;
    const ms = applyMs(n);
    const ceiling = APPLY_MS_CONST + APPLY_MS_PER_M * (n / 1_000_000);
    appendFileSync("/tmp/module-springs-perf.txt", `apply n=${n}: ${ms.toFixed(1)} ms (ceiling ${ceiling})\n`);
    expect(ms).toBeLessThan(ceiling);
  });

  it("a drag frame with module springs costs about what it does without (100k)", () => {
    const { withMs, withoutMs, springs } = dragFrames(100_000);
    appendFileSync("/tmp/module-springs-perf.txt", `drag n=100000 springs=${springs}: ${withMs.toFixed(1)} vs ${withoutMs.toFixed(1)} ms\n`);
    expect(withMs).toBeLessThan(RATIO * withoutMs + 2);
  });

  it.runIf(BENCH)(`at scale: a drag frame at ${BENCH_N} leaves`, () => {
    const { withMs, withoutMs, springs } = dragFrames(BENCH_N);
    const apply = applyMs(BENCH_N);
    const line = `[bench] module springs n=${BENCH_N} links=${springs}: drag ${withMs.toFixed(1)} vs ${withoutMs.toFixed(1)} ms, apply ${apply.toFixed(1)} ms`;
    console.log(line);
    appendFileSync("/tmp/module-springs-perf.txt", `${line}\n`);
    if (ASSERT) {
      expect(withMs).toBeLessThan(RATIO * withoutMs + 2);
      expect(apply).toBeLessThan(APPLY_MS_CONST + APPLY_MS_PER_M * (BENCH_N / 1_000_000));
    }
  }, 600_000);
});
