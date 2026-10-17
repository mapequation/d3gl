import { describe, it, expect } from "vitest";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildModuleLODTree } from "../modules.js";
import { computeLODPositions, computeLODStyle, type LODTree } from "../lod.js";
import { resolveNodeBorder, resolveNodeColors, frontierCircles, nodeCircles, BORDER_DARKEN, type ConstBorder } from "../glyphs.js";

/**
 * Per-frame regression guard for #506 (docs/agents/performance.md): a node border with no colour given
 * darkens each glyph's own fill in the glyph build, on the two builds that run per frame —
 * `frontierCircles` (every LOD frame) and `nodeCircles` (every LOD-off position frame: a layout tick or a
 * drag). The explicit-colour border is the baseline: it fills one repeated colour.
 *
 * Signature (deterministic): the darkened build returns the same arrays as the baseline — a `Float32Array`
 * ring width and one RGBA byte quad per glyph, 8 B per glyph, nothing else — and its ring colours are the
 * glyph colours darkened, in an array of their own (the fill is not written). Wall clock: the darkened
 * frame stays within a small multiple of the baseline's, on every regime — every leaf in view (reductions
 * cannot shrink the set: ≈N glyphs with LOD on), every bottom module collapsed, and LOD off (all N nodes).
 *
 * 100k in the normal suite; the at-scale leg runs at `BENCH_NODE_BORDER_SHADE_N` (the CI tier sets `PERF_N`):
 *   BENCH_NODE_BORDER_SHADE=1 BENCH_NODE_BORDER_SHADE_N=1000000 npx vitest run packages/d3gl/src/network/__tests__/node-border-shade-perf.test.ts
 */
const BENCH = !!process.env.BENCH_NODE_BORDER_SHADE;
const BENCH_N = Number(process.env.BENCH_NODE_BORDER_SHADE_N) || 1_000_000;
const BENCH_LABEL = process.env.BENCH_NODE_BORDER_SHADE_LABEL ?? "";
const ASSERT = !!process.env.PERF_ASSERT;
// MEASURED (M-series laptop, load ~7-9, median of 15 frames, darkened vs explicit colour) at 1M: all leaves
// 16-18 vs 19 ms, every bottom module collapsed 0.25-0.29 vs 0.53-0.57 ms, LOD off 6.6-6.8 vs 6.5-6.7 ms (the
// darkened ring is adopted, so it skips the baseline's colour copy). Ratio ceiling 1.5× + a jitter constant;
// absolute ceiling ~15× the measured 1M frame, linear in N.
const RATIO = Number(process.env.PERF_NODE_BORDER_SHADE_RATIO) || 1.5;
const FRAME_MS_PER_M = Number(process.env.PERF_NODE_BORDER_SHADE_MS_PER_M) || 300;

/** A regular three-level module map (fill-by-metric-perf's): bottom modules of 64 leaves, 16 per mid, 16 mids per top. */
function fixture(n: number): { graph: NetworkGraph; tree: LODTree; bottomModules: Uint32Array; colors: Uint8Array; radii: Float32Array } {
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
  const graph = buildGraph({ nodeCount: n, source: [], target: [], directed: false });
  graph.positions.set(positions);
  const palette = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b"];
  const colors = resolveNodeColors(graph, (i) => palette[Math.floor(i / 64) % palette.length]!);
  const radii = Float32Array.from({ length: n }, (_, i) => 3 + (i % 5));
  const tree = buildModuleLODTree(n, records);
  computeLODPositions(tree, graph.positions);
  computeLODStyle(tree, radii, new Float32Array(n).fill(1), undefined, colors);
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
  return { graph, tree, bottomModules: Uint32Array.from(bottom), colors, radii };
}

interface Built { count: number; colors: Uint8Array; borders?: Float32Array; borderColors?: Uint8Array }

function sweep(n: number, frames: number) {
  const { graph, tree, bottomModules, colors, radii } = fixture(n);
  const allLeaves = Uint32Array.from({ length: n }, (_, i) => i);
  const shade = resolveNodeBorder({ width: 1 }, "#000");
  const white = resolveNodeBorder({ width: 1, color: "#fff" }, "#000");
  const checks: Built[] = [];
  /** The median frame: steadier than the worst under host load, and the steady per-frame cost a user sees. */
  const time = (build: () => Built): number => {
    const ms: number[] = [];
    let last: Built | undefined;
    for (let f = 0; f < frames; f++) {
      const t0 = performance.now();
      last = build();
      ms.push(performance.now() - t0);
    }
    if (last) checks.push(last);
    ms.sort((a, b) => a - b);
    return ms[ms.length >> 1]!;
  };
  const lod = (frontier: Uint32Array, constBorder: ConstBorder) => () =>
    frontierCircles(tree, frontier, { nodeFill: "#000", aggregateFill: "#000", useTreeColor: true, constBorder });
  const full = (constBorder: ConstBorder) => () => nodeCircles(graph, { radii, fill: "#000", colors, constBorder });
  // Interleaved (baseline, darkened) per regime, so host load drifts over both alike.
  const legs = {
    leavesBase: time(lod(allLeaves, white)),
    leavesShade: time(lod(allLeaves, shade)),
    modulesBase: time(lod(bottomModules, white)),
    modulesShade: time(lod(bottomModules, shade)),
    fullBase: time(full(white)),
    fullShade: time(full(shade)),
  };
  return { n, bottom: bottomModules.length, legs, checks };
}

/** Bytes of the ring arrays a build hands out. */
const ringBytes = (b: Built): number => (b.borders?.byteLength ?? 0) + (b.borderColors?.byteLength ?? 0);

function assertSignature(r: ReturnType<typeof sweep>): void {
  // checks: [leavesBase, leavesShade, modulesBase, modulesShade, fullBase, fullShade]
  for (let k = 0; k < r.checks.length; k += 2) {
    const base = r.checks[k]!;
    const shade = r.checks[k + 1]!;
    expect(shade.count, "non-vacuity").toBeGreaterThan(0);
    // The same arrays as the baseline: 8 B of ring per glyph, nothing more.
    expect(ringBytes(shade), "ring bytes vs the explicit-colour baseline").toBe(ringBytes(base));
    expect(ringBytes(shade)).toBe(8 * shade.count);
    // Its own ring array, the glyph colours darkened; the fill untouched.
    const ring = shade.borderColors!;
    expect(ring.buffer).not.toBe(shade.colors.buffer);
    for (let i = 0; i < shade.count; i += Math.max(1, Math.floor(shade.count / 997))) {
      for (let c = 0; c < 3; c++) expect(ring[i * 4 + c]).toBe(Math.round(shade.colors[i * 4 + c]! * BORDER_DARKEN));
      expect(ring[i * 4 + 3]).toBe(shade.colors[i * 4 + 3]);
    }
  }
}

const report = (r: ReturnType<typeof sweep>): string =>
  `N=${r.n} all leaves ${r.legs.leavesShade.toFixed(1)}ms (baseline ${r.legs.leavesBase.toFixed(1)}ms), ` +
  `bottom modules (${r.bottom}) ${r.legs.modulesShade.toFixed(2)}ms (baseline ${r.legs.modulesBase.toFixed(2)}ms), ` +
  `LOD off ${r.legs.fullShade.toFixed(1)}ms (baseline ${r.legs.fullBase.toFixed(1)}ms)`;

describe("#506 node border shade: per-frame glyph build", () => {
  it("darkens in the arrays the baseline builds, within a small multiple of its frame (100k)", () => {
    const r = sweep(100_000, 15);
    assertSignature(r);
    const slack = 5; // ms of jitter headroom on the ratio, for the sub-ms module regime
    const msg = report(r);
    expect(r.legs.leavesShade, msg).toBeLessThan(RATIO * r.legs.leavesBase + slack);
    expect(r.legs.modulesShade, msg).toBeLessThan(RATIO * r.legs.modulesBase + slack);
    expect(r.legs.fullShade, msg).toBeLessThan(RATIO * r.legs.fullBase + slack);
  }, 120_000);

  (BENCH ? it : it.skip)(`bench: at ${BENCH_N.toLocaleString()} nodes`, () => {
    const r = sweep(BENCH_N, 15);
    assertSignature(r); // contention-immune: asserted whenever the bench runs
    process.stdout.write(`[node-border-shade-perf${BENCH_LABEL ? ` ${BENCH_LABEL}` : ""}] ${report(r)}\n`);
    if (ASSERT) {
      expect(r.legs.leavesShade).toBeLessThan(RATIO * r.legs.leavesBase + 20);
      expect(r.legs.leavesShade).toBeLessThan((FRAME_MS_PER_M * r.n) / 1_000_000);
      expect(r.legs.modulesShade).toBeLessThan(RATIO * r.legs.modulesBase + 5);
      expect(r.legs.fullShade).toBeLessThan(RATIO * r.legs.fullBase + 20);
      expect(r.legs.fullShade).toBeLessThan((FRAME_MS_PER_M * r.n) / 1_000_000);
    }
  }, 300_000);
});
