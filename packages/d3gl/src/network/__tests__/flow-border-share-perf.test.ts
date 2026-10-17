import { describe, it, expect } from "vitest";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildModuleLODTree } from "../modules.js";
import { computeLODPositions, computeLODStyle, lodStylePasses, type LODTree } from "../lod.js";
import { resolveFlowBorder, frontierCircles, nodeCircles, type ResolvedFlowBorder } from "../glyphs.js";

/**
 * Per-frame regression guard for #510 (docs/agents/performance.md): the share mode of the flow border. The
 * share's denominator, the node flow, is summed onto the tree with the style (`computeLODStyle`, O(tree) once
 * per style), and the per-cut glyph build (`frontierCircles`, run on every zoom frame) only reads the two
 * summed values per drawn glyph, as the absolute mode reads one through its scale.
 *
 * Signatures asserted deterministically: no style pass runs over the frame sweep (the flow is never re-summed
 * per frame), a repeated style pass reuses the tree's `borderFlow` array, and the drawn share is the summed
 * exit flow over the summed flow. Wall clock: the share mode's frame costs a small multiple of the absolute mode's, with
 * reductions ON — every leaf visible (≈N glyphs: LOD cannot shrink the set) and every bottom module collapsed —
 * and OFF (the full-detail `nodeCircles` over every node).
 *
 * 100k in the normal suite; the at-scale leg runs at `BENCH_FLOW_BORDER_SHARE_N` (the CI tier sets `PERF_N`):
 *   BENCH_FLOW_BORDER_SHARE=1 BENCH_FLOW_BORDER_SHARE_N=1000000 npx vitest run packages/d3gl/src/network/__tests__/flow-border-share-perf.test.ts
 */
const BENCH = !!process.env.BENCH_FLOW_BORDER_SHARE;
const BENCH_N = Number(process.env.BENCH_FLOW_BORDER_SHARE_N) || 1_000_000;
const BENCH_LABEL = process.env.BENCH_FLOW_BORDER_SHARE_LABEL ?? "";
const ASSERT = !!process.env.PERF_ASSERT;
const RATIO = Number(process.env.PERF_FLOW_BORDER_SHARE_RATIO) || 2;
// Measured (M-series laptop, median frame, host load 6-11): at 1M, all leaves 33 ms in both modes, every bottom
// module collapsed ~1 ms, LOD off 25 ms vs 23 ms. Ratio ceiling 2× + a jitter constant; the absolute ceiling
// is ~10× the measured 1M frame, scaled linearly in N.
const FRAME_MS_PER_M = Number(process.env.PERF_FLOW_BORDER_SHARE_MS_PER_M) || 350;

/** A regular three-level module map: bottom modules of 64 leaves, 16 per mid module, mid modules 16 per top. */
function fixture(n: number): { graph: NetworkGraph; tree: LODTree; bottomModules: Uint32Array } {
  const records = new Array<{ id: number; path: number[] }>(n);
  const positions = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const b = Math.floor(i / 64);
    const mid = b % 16;
    const top = Math.floor(b / 16);
    records[i] = { id: i, path: [top + 1, mid + 1, (i % 64) + 1] };
    positions[2 * i] = top * 400 + (mid % 4) * 90 + (i % 8) * 10;
    positions[2 * i + 1] = Math.floor(mid / 4) * 90 + Math.floor((i % 64) / 8) * 10;
  }
  const nodeFlow = Float32Array.from({ length: n }, (_, i) => (1 + (i % 7)) / n);
  const graph = buildGraph({ nodeCount: n, source: [], target: [], directed: true, nodeFlow });
  graph.positions.set(positions);
  const tree = buildModuleLODTree(n, records);
  computeLODPositions(tree, graph.positions);
  const parent = tree.parent!;
  const seen = new Uint8Array(tree.size);
  const bottom: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = parent[i]!;
    if (!seen[p]) {
      seen[p] = 1;
      bottom.push(p);
    }
  }
  return { graph, tree, bottomModules: Uint32Array.from(bottom) };
}

function sweep(n: number, frames: number) {
  const { graph, tree, bottomModules } = fixture(n);
  const exit = Float32Array.from({ length: n }, (_, i) => ((i % 5) / 4) * graph.flow![i]!);
  const radii = new Float32Array(n).fill(4);
  const weight = new Float32Array(n).fill(1);
  const absolute: ResolvedFlowBorder = resolveFlowBorder(graph, { flow: exit, scale: (v) => Math.sqrt(v * n), color: "#333" }, "#000");
  const share: ResolvedFlowBorder = resolveFlowBorder(graph, { share: true, flow: exit, color: "#333" }, "#000");
  // Style time, as the engine does per `style()`: the absolute tree holds no flow, the share tree sums it.
  computeLODStyle(tree, radii, weight, share.metric, undefined, undefined, undefined, share.flow);
  const borderFlow = tree.borderFlow;
  computeLODStyle(tree, radii, weight, share.metric, undefined, undefined, undefined, share.flow);
  const reused = tree.borderFlow === borderFlow;
  const passesBefore = lodStylePasses;

  const allLeaves = Uint32Array.from({ length: n }, (_, i) => i);
  // The median frame: a GC pause or a busy host lands on either mode's worst frame alike, so the ratio compares
  // medians; the absolute ceiling (~10× the measured frame) takes the median too.
  const time = (build: () => number, expected: number): number => {
    const ms: number[] = [];
    for (let f = 0; f < frames; f++) {
      const t0 = performance.now();
      const count = build();
      ms.push(performance.now() - t0);
      expect(count).toBe(expected);
    }
    ms.sort((a, b) => a - b);
    return ms[ms.length >> 1]!;
  };
  const common = { nodeFill: "#00f", aggregateFill: "#999" };
  const style = { radii, fill: "#00f" };
  const legs = {
    leavesAbs: time(() => frontierCircles(tree, allLeaves, { ...common, border: absolute }).count, n),
    leavesShare: time(() => frontierCircles(tree, allLeaves, { ...common, border: share }).count, n),
    modulesAbs: time(() => frontierCircles(tree, bottomModules, { ...common, border: absolute }).count, bottomModules.length),
    modulesShare: time(() => frontierCircles(tree, bottomModules, { ...common, border: share }).count, bottomModules.length),
    offAbs: time(() => nodeCircles(graph, { ...style, border: absolute }).count, n),
    offShare: time(() => nodeCircles(graph, { ...style, border: share }).count, n),
  };
  const passesPerSweep = lodStylePasses - passesBefore;
  // A spot check that the share is what was drawn: bottom module 0 sums leaves 0..63.
  let se = 0;
  let sf = 0;
  for (let i = 0; i < 64; i++) {
    se += exit[i]!;
    sf += graph.flow![i]!;
  }
  const first = frontierCircles(tree, bottomModules, { ...common, border: share }).borders![0]!;
  return { n, bottom: bottomModules.length, reused, passesPerSweep, first, expectedFirst: 1 - Math.sqrt(1 - se / sf), legs };
}

function assertSignature(r: ReturnType<typeof sweep>): void {
  expect(r.passesPerSweep, "style passes over the frame sweep").toBe(0);
  expect(r.reused, "a repeated style pass reuses the tree's borderFlow").toBe(true);
  expect(r.first).toBeCloseTo(r.expectedFirst, 4);
}

describe("#510 share-mode flow border: per-frame cost", () => {
  it("sums the flow once per style, and the frame build costs about what the absolute mode's does (100k)", () => {
    const r = sweep(100_000, 13);
    assertSignature(r);
    const slack = 5; // ms of jitter headroom on the ratio, for the sub-ms module regime
    const { legs } = r;
    expect(legs.leavesShare, `all-leaves frame ${legs.leavesShare.toFixed(1)}ms vs ${legs.leavesAbs.toFixed(1)}ms absolute`).toBeLessThan(RATIO * legs.leavesAbs + slack);
    expect(legs.modulesShare, `bottom-module frame ${legs.modulesShare.toFixed(2)}ms vs ${legs.modulesAbs.toFixed(2)}ms absolute`).toBeLessThan(RATIO * legs.modulesAbs + slack);
    expect(legs.offShare, `LOD-off build ${legs.offShare.toFixed(1)}ms vs ${legs.offAbs.toFixed(1)}ms absolute`).toBeLessThan(RATIO * legs.offAbs + slack);
  }, 120_000);

  (BENCH ? it : it.skip)(`bench: at ${BENCH_N.toLocaleString()} leaves`, () => {
    const r = sweep(BENCH_N, 9);
    assertSignature(r); // contention-immune: asserted whenever the bench runs
    const { legs } = r;
    process.stdout.write(
      `[flow-border-share-perf${BENCH_LABEL ? ` ${BENCH_LABEL}` : ""}] N=${r.n} ` +
        `LOD on, all leaves ${legs.leavesShare.toFixed(1)}ms (absolute ${legs.leavesAbs.toFixed(1)}ms), ` +
        `bottom modules (${r.bottom}) ${legs.modulesShare.toFixed(2)}ms (absolute ${legs.modulesAbs.toFixed(2)}ms), ` +
        `LOD off ${legs.offShare.toFixed(1)}ms (absolute ${legs.offAbs.toFixed(1)}ms)\n`,
    );
    if (ASSERT) {
      expect(legs.leavesShare).toBeLessThan(RATIO * legs.leavesAbs + 20);
      expect(legs.leavesShare).toBeLessThan((FRAME_MS_PER_M * r.n) / 1_000_000);
      expect(legs.modulesShare).toBeLessThan(RATIO * legs.modulesAbs + 5);
      expect(legs.offShare).toBeLessThan(RATIO * legs.offAbs + 20);
      expect(legs.offShare).toBeLessThan((FRAME_MS_PER_M * r.n) / 1_000_000);
    }
  }, 300_000);
});
