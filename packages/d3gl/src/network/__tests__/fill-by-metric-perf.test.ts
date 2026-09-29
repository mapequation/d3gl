import { describe, it, expect } from "vitest";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildModuleLODTree } from "../modules.js";
import { computeLODPositions, computeLODStyle, type LODTree } from "../lod.js";
import { resolveNodeFill, resolveFlowBorder, moduleBorderValues, applyModuleBorder, treeBorderColors, frontierCircles, type ResolvedFlowBorder } from "../glyphs.js";

/**
 * Per-frame regression guard for #445 (AGENTS.md lifecycle §5): `nodeFill: { by, scale }`, a
 * `flowBorder.color` accessor and `flowBorder.moduleFlow` are resolved **once per style** — O(nodes) scale
 * calls for the leaves, O(modules) for the aggregates — and the per-cut glyph build (`frontierCircles`, run
 * on every zoom frame) only indexes the resolved tables.
 *
 * Signature asserted deterministically: over a sweep of frontier builds, the scale, colour accessor and
 * `moduleFlow` are called **zero** times; at style time each is called exactly once per node / aggregate.
 * Wall clock: the new style's frame costs a small multiple of the baseline's (a constant ring colour, a
 * categorical fill), on both frontier regimes — every leaf visible (reductions can't shrink the set) and
 * every bottom module collapsed.
 *
 * 100k in the normal suite; the at-scale leg runs at `BENCH_FILL_BY_METRIC_N` (the CI tier sets `PERF_N`):
 *   BENCH_FILL_BY_METRIC=1 BENCH_FILL_BY_METRIC_N=1000000 npx vitest run packages/d3gl/src/network/__tests__/fill-by-metric-perf.test.ts
 */
const BENCH = !!process.env.BENCH_FILL_BY_METRIC;
const BENCH_N = Number(process.env.BENCH_FILL_BY_METRIC_N) || 1_000_000;
const BENCH_LABEL = process.env.BENCH_FILL_BY_METRIC_LABEL ?? "";
const ASSERT = !!process.env.PERF_ASSERT;
// Measured (M-series laptop, worst of 8 frames): all leaves 3.5 ms vs 3.0 ms baseline at 100k, 34.7 ms vs
// 32.1 ms at 1M; every bottom module collapsed 0.06 / 0.54 ms (both styles). Ratio ceiling 2× + a jitter
// constant; the absolute ceiling is ~10× the measured 1M frame, scaled linearly in N.
const RATIO = Number(process.env.PERF_FILL_BY_METRIC_RATIO) || 2;
const LEAVES_FRAME_MS_PER_M = Number(process.env.PERF_FILL_BY_METRIC_MS_PER_M) || 350;

/** A regular three-level module map: bottom modules of 64 leaves, 16 per mid module, mid modules 16 per top. */
function fixture(n: number): { graph: NetworkGraph; tree: LODTree; bottomModules: Uint32Array } {
  const records = new Array<{ id: number; path: number[] }>(n);
  const source: number[] = [];
  const target: number[] = [];
  const positions = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const b = Math.floor(i / 64);
    const mid = b % 16;
    const top = Math.floor(b / 16);
    records[i] = { id: i, path: [top + 1, mid + 1, (i % 64) + 1] };
    source.push(i);
    target.push(b * 64 + ((i + 1) % 64) < n ? b * 64 + ((i + 1) % 64) : i);
    positions[2 * i] = top * 400 + (mid % 4) * 90 + (i % 8) * 10;
    positions[2 * i + 1] = Math.floor(mid / 4) * 90 + Math.floor((i % 64) / 8) * 10;
  }
  const flow = Float32Array.from({ length: n }, (_, i) => (1 + (i % 7)) / n);
  const graph = buildGraph({ nodeCount: n, source, target, directed: true, nodeFlow: flow });
  graph.positions.set(positions);
  const tree = buildModuleLODTree(n, records);
  computeLODPositions(tree, graph.positions);
  // The bottom modules: every leaf's parent, once.
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

interface Calls { scale: number; color: number; moduleFlow: number }

/** Resolve both styles against the tree, as the engine does per `style()`: counting calls for the new one. */
function resolveStyles(graph: NetworkGraph, tree: LODTree, calls: Calls) {
  const n = graph.nodeCount;
  const enterExit = Float32Array.from({ length: n }, (_, i) => (i % 5) / n);
  const radii = new Float32Array(n).fill(4);
  const weight = new Float32Array(n).fill(1);
  const redOf = (v: number) => (calls.scale++, `rgb(${Math.min(255, Math.round(v * n * 10))}, 0, 0)`);
  const fill = resolveNodeFill(graph, { by: "flow", scale: redOf }, "#000");
  const border = resolveFlowBorder(graph, {
    flow: enterExit,
    scale: (v) => Math.sqrt(v * n),
    color: (v) => (calls.color++, `rgb(0, ${Math.min(255, Math.round(v * n * 10))}, 0)`),
    moduleFlow: (path) => (calls.moduleFlow++, path.length === 2 ? path[1]! / n : undefined),
  }, "#000");
  computeLODStyle(tree, radii, weight, border.metric, fill.nodeColors, undefined, fill.fillAggregate);
  applyModuleBorder(tree, moduleBorderValues(tree, border)!);
  const ringColors = treeBorderColors(tree, border);
  // Baseline: the same tree drawn with a categorical fill and a constant ring colour (no tables).
  const baseBorder: ResolvedFlowBorder = resolveFlowBorder(graph, { flow: enterExit, scale: (v) => Math.sqrt(v * n), color: "#333" }, "#000");
  return { border, ringColors, baseBorder };
}

function sweep(n: number, frames: number) {
  const { graph, tree, bottomModules } = fixture(n);
  const aggregates = tree.size - tree.leafCount;
  const calls: Calls = { scale: 0, color: 0, moduleFlow: 0 };
  const { border, ringColors, baseBorder } = resolveStyles(graph, tree, calls);
  const atStyle = { ...calls };
  const allLeaves = Uint32Array.from({ length: n }, (_, i) => i);
  const time = (frontier: Uint32Array, style: Parameters<typeof frontierCircles>[2]): number => {
    let worst = 0;
    for (let f = 0; f < frames; f++) {
      const t0 = performance.now();
      const c = frontierCircles(tree, frontier, style);
      worst = Math.max(worst, performance.now() - t0);
      expect(c.count).toBe(frontier.length);
    }
    return worst;
  };
  const common = { nodeFill: "#00f", aggregateFill: "#999", useTreeColor: true };
  const legs = {
    leavesBase: time(allLeaves, { ...common, border: baseBorder }),
    leavesNew: time(allLeaves, { ...common, border, borderColors: ringColors }),
    modulesBase: time(bottomModules, { ...common, border: baseBorder }),
    modulesNew: time(bottomModules, { ...common, border, borderColors: ringColors }),
  };
  const perFrame = { scale: calls.scale - atStyle.scale, color: calls.color - atStyle.color, moduleFlow: calls.moduleFlow - atStyle.moduleFlow };
  return { n, aggregates, bottom: bottomModules.length, atStyle, perFrame, legs };
}

function assertSignature(r: ReturnType<typeof sweep>): void {
  // Style time: once per node for the leaves, once per aggregate — O(data), no more.
  expect(r.atStyle.scale, "fill scale calls at style time").toBe(r.n + r.aggregates);
  expect(r.atStyle.moduleFlow, "moduleFlow calls at style time").toBe(r.aggregates);
  expect(r.atStyle.color, "ring colour calls at style time (+1: the representative)").toBe(r.n + 1 + r.aggregates);
  // Per frame: nothing is re-resolved.
  expect(r.perFrame).toEqual({ scale: 0, color: 0, moduleFlow: 0 });
}

describe("#445 fill-by-metric + module flow borders: per-frame cost", () => {
  it("resolves every accessor once per style, and the frontier build only indexes (100k)", () => {
    const r = sweep(100_000, 12);
    assertSignature(r);
    const slack = 5; // ms of jitter headroom on the ratio, for the sub-ms module regime
    expect(r.legs.leavesNew, `all-leaves frame ${r.legs.leavesNew.toFixed(1)}ms vs ${r.legs.leavesBase.toFixed(1)}ms baseline`).toBeLessThan(RATIO * r.legs.leavesBase + slack);
    expect(r.legs.modulesNew, `bottom-module frame ${r.legs.modulesNew.toFixed(2)}ms vs ${r.legs.modulesBase.toFixed(2)}ms baseline`).toBeLessThan(RATIO * r.legs.modulesBase + slack);
  }, 120_000);

  (BENCH ? it : it.skip)(`bench: at ${BENCH_N.toLocaleString()} leaves`, () => {
    const r = sweep(BENCH_N, 8);
    assertSignature(r); // contention-immune: asserted whenever the bench runs
    process.stdout.write(
      `[fill-by-metric-perf${BENCH_LABEL ? ` ${BENCH_LABEL}` : ""}] N=${r.n} aggregates=${r.aggregates} ` +
        `all-leaves ${r.legs.leavesNew.toFixed(1)}ms (baseline ${r.legs.leavesBase.toFixed(1)}ms), ` +
        `bottom modules (${r.bottom}) ${r.legs.modulesNew.toFixed(2)}ms (baseline ${r.legs.modulesBase.toFixed(2)}ms)\n`,
    );
    if (ASSERT) {
      expect(r.legs.leavesNew).toBeLessThan(RATIO * r.legs.leavesBase + 20);
      expect(r.legs.leavesNew).toBeLessThan((LEAVES_FRAME_MS_PER_M * r.n) / 1_000_000);
      expect(r.legs.modulesNew).toBeLessThan(RATIO * r.legs.modulesBase + 5);
    }
  }, 300_000);
});
