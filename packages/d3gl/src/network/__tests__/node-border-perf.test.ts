import { describe, it, expect } from "vitest";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildModuleLODTree } from "../modules.js";
import { computeLODPositions, computeLODStyle, type LODTree } from "../lod.js";
import { nodeCircles, frontierCircles, resolveFlowBorder, MAX_BORDER_FRACTION, type ResolvedFlowBorder } from "../glyphs.js";
import type { InstancedCirclesData } from "../../core/index.js";

/**
 * Per-frame regression guard for #506 (docs/agents/performance.md): the cap on a node's border width (a
 * third of its radius) runs where the per-instance border fraction is built, `buildBorders`, on both
 * per-frame paths that build it:
 *
 * - **LOD off** (full detail): `nodeCircles` over **every** node, re-run with each layer emit (a layout
 *   tick, a drag frame), for a node border (`nodeBorder`) and a flow border (`flowBorder`);
 * - **LOD on**: `frontierCircles` over the cut, re-run at each re-cut of a zoom, here over an
 *   **all-leaves frontier** (every node visible: LOD does not shrink the set).
 *
 * Half the radii are small enough to hit the cap, half are not. Deterministic signature: the flow border's
 * scale is still called once per drawn node per build (the cap adds no accessor calls), every fraction is
 * within the cap, and the node radii buffer is shared, not copied. Wall-clock: a border build stays under a
 * jitter constant plus a per-node ceiling. (A ratio to the border-less builder is reported, not asserted: that
 * builder allocates no border arrays, so the ratio measures the border arrays, which predate the cap.)
 *
 * 100k in the normal suite; the at-scale leg runs at `BENCH_NODE_BORDER_N` (the CI tier sets `PERF_N`):
 *   BENCH_NODE_BORDER=1 BENCH_NODE_BORDER_N=1000000 npx vitest run packages/d3gl/src/network/__tests__/node-border-perf.test.ts
 */
const BENCH = !!process.env.BENCH_NODE_BORDER;
const BENCH_N = Number(process.env.BENCH_NODE_BORDER_N) || 1_000_000;
const BENCH_LABEL = process.env.BENCH_NODE_BORDER_LABEL ?? "";
const ASSERT = !!process.env.PERF_ASSERT;
// Measured (M-series laptop under load ~8, worst of 8 builds, 1M nodes): 19-24 ms for every border leg, LOD
// off and on, the same as before the cap (19-22 ms). The ceiling is ~7× that, linear in N, plus a constant.
const BUILD_MS_PER_M = Number(process.env.PERF_NODE_BORDER_MS_PER_M) || 150;

/** `n` nodes in bottom modules of 64; radii alternate between capped (0.25-0.75) and uncapped (4-7) for a border 1 wide. */
function fixture(n: number): { graph: NetworkGraph; tree: LODTree; radii: Float32Array; flow: ResolvedFlowBorder; calls: { scale: number } } {
  const records = new Array<{ id: number; path: number[] }>(n);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    const b = Math.floor(i / 64);
    records[i] = { id: i, path: [Math.floor(b / 16) + 1, (b % 16) + 1, (i % 64) + 1] };
    source.push(i);
    target.push(b * 64 + ((i + 1) % 64) < n ? b * 64 + ((i + 1) % 64) : i);
  }
  const graph = buildGraph({ nodeCount: n, source, target });
  for (let i = 0; i < n; i++) {
    graph.positions[2 * i] = (i % 1000) * 10;
    graph.positions[2 * i + 1] = Math.floor(i / 1000) * 10;
  }
  const radii = Float32Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0.25 + (i % 3) * 0.25 : 4 + (i % 4)));
  const tree = buildModuleLODTree(n, records);
  computeLODPositions(tree, graph.positions);
  const calls = { scale: 0 };
  const flow = resolveFlowBorder(graph, { flow: new Float32Array(n).fill(1), scale: (v) => (calls.scale++, v), color: "#ffffff" }, "#000");
  computeLODStyle(tree, radii, new Float32Array(n).fill(1), flow.metric);
  return { graph, tree, radii, flow, calls };
}

const NODE_BORDER = { width: 1, color: [255, 255, 255, 255] as [number, number, number, number] };

function sweep(n: number, frames: number) {
  const { graph, tree, radii, flow, calls } = fixture(n);
  const leaves = Uint32Array.from({ length: n }, (_, i) => i);
  const time = (build: () => InstancedCirclesData): { ms: number; out: InstancedCirclesData } => {
    let worst = 0;
    let out = build();
    for (let f = 0; f < frames; f++) {
      const t0 = performance.now();
      out = build();
      worst = Math.max(worst, performance.now() - t0);
    }
    return { ms: worst, out };
  };
  const off = {
    base: time(() => nodeCircles(graph, { radii, fill: "#00f" })),
    node: time(() => nodeCircles(graph, { radii, fill: "#00f", constBorder: NODE_BORDER })),
    flow: time(() => nodeCircles(graph, { radii, fill: "#00f", border: flow })),
  };
  const before = calls.scale;
  nodeCircles(graph, { radii, fill: "#00f", border: flow });
  const scalePerBuildOff = calls.scale - before;
  const common = { nodeFill: "#00f", aggregateFill: "#999" };
  const on = {
    base: time(() => frontierCircles(tree, leaves, common)),
    node: time(() => frontierCircles(tree, leaves, { ...common, constBorder: NODE_BORDER })),
    flow: time(() => frontierCircles(tree, leaves, { ...common, border: { ...flow, metric: new Float32Array(0) } })),
  };
  const mid = calls.scale;
  frontierCircles(tree, leaves, { ...common, border: { ...flow, metric: new Float32Array(0) } });
  const scalePerBuildOn = calls.scale - mid;
  return { n, radii, off, on, scalePerBuildOff, scalePerBuildOn };
}

function assertSignature(r: ReturnType<typeof sweep>): void {
  // The flow border's scale: once per drawn node per build, no more.
  expect(r.scalePerBuildOff, "flow border scale calls per LOD-off build").toBe(r.n);
  expect(r.scalePerBuildOn, "flow border scale calls per all-leaves build").toBe(r.n);
  // The node radii buffer is shared with the GPU lane, not copied (LOD off).
  expect(r.off.node.out.radii).toBe(r.radii);
  // Every fraction within the cap; a capped node at the cap, an uncapped one unchanged (border 1 / radius).
  const cap = Math.fround(MAX_BORDER_FRACTION);
  for (const leg of [r.off.node, r.off.flow, r.on.node, r.on.flow]) {
    const b = leg.out.borders ?? new Float32Array(0);
    expect(b.length).toBe(r.n);
    let over = 0;
    for (const v of b) if (v > cap) over++;
    expect(over, "fractions over the cap").toBe(0);
    expect(b[0]).toBe(cap); // radius 0.25
    expect(b[1]).toBe(Math.fround(1 / 5)); // radius 5
  }
}

function report(r: ReturnType<typeof sweep>): string {
  const f = (x: { ms: number }) => x.ms.toFixed(1);
  return (
    `N=${r.n} LOD off: node border ${f(r.off.node)}ms, flow border ${f(r.off.flow)}ms (no border ${f(r.off.base)}ms); ` +
    `LOD on, all leaves: node border ${f(r.on.node)}ms, flow border ${f(r.on.flow)}ms (no border ${f(r.on.base)}ms)`
  );
}

function assertBudget(r: ReturnType<typeof sweep>, slack: number): void {
  for (const [name, legs] of [["LOD off", r.off], ["LOD on", r.on]] as const) {
    for (const kind of ["node", "flow"] as const) {
      const ms = legs[kind].ms;
      expect(ms, `${name} ${kind} border build ${ms.toFixed(1)}ms (${legs.base.ms.toFixed(1)}ms without a border)`).toBeLessThan(slack + (BUILD_MS_PER_M * r.n) / 1_000_000);
    }
  }
}

describe("#506 node border cap: per-frame cost of the border build", () => {
  it("caps every border within one pass, with no extra accessor calls, LOD off and on (100k)", () => {
    const r = sweep(100_000, 12);
    assertSignature(r);
    assertBudget(r, 5);
  }, 120_000);

  (BENCH ? it : it.skip)(`bench: at ${BENCH_N.toLocaleString()} nodes`, () => {
    const r = sweep(BENCH_N, 8);
    process.stdout.write(`[node-border-perf${BENCH_LABEL ? ` ${BENCH_LABEL}` : ""}] ${report(r)}\n`);
    assertSignature(r); // contention-immune: asserted whenever the bench runs
    if (ASSERT) assertBudget(r, 20);
  }, 300_000);
});
