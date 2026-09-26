import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { scaleSqrt } from "d3-scale";
import { rgb } from "d3-color";
import { buildLODTree, computeLODGeometry, cut, makeCutScratch, declutterFrontier, makeDeclutterFrontierScratch, visibleWorldRect, type LODTree, type LODTransform } from "../lod.js";
import { multilevelSeed } from "../coarsen.js";
import { superEdges, makeSuperEdgesScratch, resolveLinkColorOf, linkLinesStyleAttrs, type SuperEdgeStyleResolved } from "../glyphs.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { declutterScreen, declutterScratch } from "../../core/declutter.js";

/**
 * Per-frame regression guard (AGENTS.md lifecycle §5) for the streamed-LOD-frame waste measured on
 * web-NotreDame (325k nodes, 1.5M edges) in the Network Navigator: ~52-66 ms of main thread per
 * streamed layout frame, most of it re-deriving what the previous frame already had.
 *
 *   1. **Super-edge colour** — the app's `linkStroke` is a d3 colour scale; every frame ran it and
 *      re-parsed its rgba() string once per DRAWN super-edge (82k per frame there; 70% of the
 *      super-edge gather). The resolved colour is now memoised per weight for the style, so a sweep
 *      resolves each distinct weight once. Signature: accessor calls after the first frame are a
 *      vanishing fraction of the edges drawn, and every colour byte equals the per-call parse.
 *   2. **Declutter with mixed radii** — one grid cell of 2·maxR (52 px with the 26 px aggregate cap)
 *      made every rejected 2-3 px leaf test the whole packed neighbourhood. Radius-class grids keep
 *      probes per glyph O(1). Signature: `scratch.probes` per frontier glyph, plus element identity
 *      with the single-grid reference.
 *
 * Both reduction states, as §5 asks:
 *   - **reductions ON** — the real cut → declutterFrontier → superEdges pipeline over a zoom sweep,
 *     plus an everything-present frontier (all leaves, so LOD cannot shrink the set).
 *   - **reductions OFF** — the full-detail draw resolves link colours at style registration over ALL
 *     edges (`linkLinesStyleAttrs`, #179 then reuses them every position frame): the same memo makes
 *     that O(distinct weights) accessor calls instead of O(edges).
 *
 * Always-on at 100k; the at-scale numbers come from the env-gated leg:
 *   BENCH_LOD_FRAME_WASTE=1 BENCH_LOD_FRAME_WASTE_N=1000000 npx vitest run packages/d3gl/src/network/__tests__/lod-frame-waste-perf.test.ts
 * Each bench run appends a labelled line to /tmp/lod-frame-waste-perf.txt (BENCH_LOD_FRAME_WASTE_LABEL).
 */
const BENCH = !!process.env.BENCH_LOD_FRAME_WASTE;
const BENCH_N = Number(process.env.BENCH_LOD_FRAME_WASTE_N) || 1_000_000;
const ASSERT = !!process.env.PERF_ASSERT;
// Wall-clock ceilings (PERF_ASSERT only). Measured on an M1 Max under heavy load (load average ~20):
// declutter of a dense mixed-radius screen 95 ms at 500k and 194-209 ms at 1M, against 695-708 ms at
// 1M for the single grid it replaces; sweep frame median 1.0-1.2 ms at 500k-1M. The declutter ceiling
// is linear in N (it is O(N)) and sits below the single-grid time at every N, so a fallback to one
// 2·maxR grid trips it as well as the probe count; the sweep ceiling is an order-of-magnitude backstop.
const DECLUTTER_MS_PER_M = Number(process.env.PERF_LOD_FRAME_WASTE_DECLUTTER_MS) || 400;
const SWEEP_FRAME_MS = Number(process.env.PERF_LOD_FRAME_WASTE_SWEEP_MS) || 20;
/** Probes per glyph the radius-class grid may spend (measured 3.2 on the dense fixture; the single
 *  grid spends 52 there). Deterministic — never scaled. */
const MAX_PROBES_PER_GLYPH = 8;
const W = 1280;
const H = 800;

/** The Network Navigator's link colour: an interpolated rgba() string per weight. */
const strokeScale = scaleSqrt<string>().domain([0, 64]).range(["rgba(90,100,120,0.12)", "rgba(60,70,90,0.85)"]).clamp(true);
const parsed = (css: string): [number, number, number, number] => {
  const c = rgb(css);
  return [Math.round(c.r) & 255, Math.round(c.g) & 255, Math.round(c.b) & 255, Math.round((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255) & 255];
};

/** Clustered ring + local chords (the super-edges-perf fixture), weighted from a small set so edge
 *  flows — and the super-edges' accumulated flows — take many but repeating values. */
function weightedClusteredGraph(n: number): NetworkGraph {
  let s = 7 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  const span = Math.min(50, Math.max(2, n - 2));
  for (let i = 0; i < n; i++) {
    source.push(i, i);
    target.push((i + 1) % n, (i + 1 + Math.floor(rng() * span)) % n);
    weight.push(1 + Math.floor(rng() * 4), 1 + Math.floor(rng() * 4));
  }
  const g = buildGraph({ nodeCount: n, source, target, weight, directed: true });
  multilevelSeed(g, { width: 2000, height: 2000 });
  return g;
}

function lodFixture(n: number): { graph: NetworkGraph; tree: LODTree; centroid: [number, number]; baseK: number } {
  const graph = weightedClusteredGraph(n);
  const tree = buildLODTree(graph, {});
  // Screen-sized 2-3 px leaves; aggregates grow by area and are capped at 26 px by the cut/declutter.
  const radii = new Float32Array(n);
  for (let i = 0; i < n; i++) radii[i] = 2 + (i % 3) * 0.5;
  computeLODGeometry(tree, graph, radii);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = graph.positions[i * 2]!, y = graph.positions[i * 2 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const baseK = 0.9 * Math.min(W / (maxX - minX), H / (maxY - minY));
  return { graph, tree, centroid: [(minX + maxX) / 2, (minY + maxY) / 2], baseK };
}

/** A dense mixed-radius screen (leaves 2-3 px, 5% aggregates up to 26 px), importance order. */
function mixedScreen(n: number): { sx: Float64Array; sy: Float64Array; radii: Float64Array; order: Uint32Array } {
  let s = 11 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const radii = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    sx[i] = rng() * (W + 60) - 30;
    sy[i] = rng() * (H + 60) - 30;
    radii[i] = rng() < 0.05 ? 5 + rng() * 21 : 2 + rng();
  }
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => (radii[b] ?? 0) - (radii[a] ?? 0));
  return { sx, sy, radii, order };
}

/** The pre-change single-grid kept set (cell = 2·spacing·maxR, 3×3 scan) — the identity reference. */
function singleGridKept(n: number, sx: Float64Array, sy: Float64Array, radii: Float64Array, order: Uint32Array): { kept: Uint8Array; probes: number } {
  let maxR = 1;
  for (let i = 0; i < n; i++) maxR = Math.max(maxR, radii[i] ?? 0);
  const cell = Math.max(2 * maxR, 1);
  const cols = Math.floor(W / cell) + 3;
  const rows = Math.floor(H / cell) + 3;
  const head = new Int32Array(cols * rows).fill(-1);
  const next = new Int32Array(n);
  const kept = new Uint8Array(n);
  let probes = 0;
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi] ?? 0;
    const x = sx[i] ?? 0;
    const y = sy[i] ?? 0;
    const r = radii[i] ?? 0;
    if (x < 0 || y < 0 || x > W || y > H) {
      kept[i] = 1;
      continue;
    }
    const cx = Math.floor(x / cell) + 1;
    const cy = Math.floor(y / cell) + 1;
    let hit = false;
    for (let gx = cx - 1; gx <= cx + 1 && !hit; gx++) {
      for (let gy = cy - 1; gy <= cy + 1 && !hit; gy++) {
        for (let p = head[gy * cols + gx] ?? -1; p !== -1; p = next[p] ?? -1) {
          probes++;
          const dx = (sx[p] ?? 0) - x;
          const dy = (sy[p] ?? 0) - y;
          const t = r + (radii[p] ?? 0);
          if (dx * dx + dy * dy < t * t) {
            hit = true;
            break;
          }
        }
      }
    }
    if (!hit) {
      kept[i] = 1;
      const c = cy * cols + cx;
      next[i] = head[c] ?? -1;
      head[c] = i;
    }
  }
  return { kept, probes };
}

function firstMismatch(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function median(ts: number[]): number {
  const s = [...ts].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

interface SweepResult {
  frames: number;
  drawnAfterFirst: number;
  callsAfterFirst: number;
  colourMismatch: string | null;
  medianMs: number;
  maxFrontier: number;
  probesPerGlyph: number;
}

/** Drive the reductions-ON pipeline over a zoom sweep (plus the all-leaves frontier as the last frame)
 *  with the memoised app colour scale, counting accessor calls and checking every colour byte. */
function runSweep(tree: LODTree, centroid: [number, number], baseK: number, frames: number): SweepResult {
  let calls = 0;
  const colorOf = resolveLinkColorOf((w: number) => {
    calls++;
    return strokeScale(w);
  });
  const style: SuperEdgeStyleResolved = { linkStyle: "half-arrow", directed: true, widthOf: () => 1, colorOf, bend: 0.15, arrowSize: 5, maxAggregateRadius: 26, crossLevelEdges: true };
  const cutSc = makeCutScratch();
  const dcSc = makeDeclutterFrontierScratch();
  const seSc = makeSuperEdgesScratch();
  let drawnAfterFirst = 0;
  let callsAfterFirst = 0;
  let colourMismatch: string | null = null;
  let maxFrontier = 0;
  let probes = 0;
  let glyphs = 0;
  const ts: number[] = [];
  for (let f = 0; f <= frames; f++) {
    const allLeaves = f === frames;
    const k = baseK * Math.pow(2, (f % 12) / 3); // 1x → ~16x, twice over
    const t: LODTransform = { k, x: W / 2 - centroid[0] * k, y: H / 2 - centroid[1] * k };
    const before = calls;
    const t0 = performance.now();
    const raw = cut(tree, t, W, H, { expandPx: allLeaves ? 1e-6 : 48, screenSized: true, maxAggregateRadius: 26 }, cutSc);
    maxFrontier = Math.max(maxFrontier, raw.length);
    const frontier = declutterFrontier(tree, raw, t, W, H, { screenSized: true, k, maxAggregateRadius: 26 }, dcSc).slice();
    probes += dcSc.grid.probes;
    glyphs += raw.length;
    const out = superEdges(tree, frontier, style, visibleWorldRect(t, W, H), seSc);
    ts.push(performance.now() - t0);
    const ha = out.halfArrows;
    const flows = out.flows ?? [];
    if (ha && colourMismatch === null) {
      for (let e = 0; e < ha.count; e++) {
        const want = parsed(strokeScale(flows[e] ?? 0));
        for (let c = 0; c < 4; c++) {
          if (ha.colors[e * 4 + c] !== want[c]) {
            colourMismatch = `frame ${f} edge ${e} channel ${c}: ${ha.colors[e * 4 + c]} !== ${want[c]}`;
            break;
          }
        }
        if (colourMismatch !== null) break;
      }
    }
    if (f > 0) {
      drawnAfterFirst += ha?.count ?? 0;
      callsAfterFirst += calls - before;
    }
  }
  return { frames: frames + 1, drawnAfterFirst, callsAfterFirst, colourMismatch, medianMs: median(ts), maxFrontier, probesPerGlyph: glyphs > 0 ? probes / glyphs : 0 };
}

describe("streamed LOD frame waste — colour resolution + mixed-radius declutter", () => {
  it("reductions ON: super-edge colours resolve per distinct weight, exact bytes; declutter probes stay O(1)", () => {
    const { tree, centroid, baseK } = lodFixture(100_000);
    const r = runSweep(tree, centroid, baseK, 24);
    expect(r.colourMismatch).toBeNull();
    expect(r.drawnAfterFirst, "the sweep drew no super-edges").toBeGreaterThan(10_000);
    expect(r.maxFrontier, "the all-leaves frame must present every leaf (LOD may not shrink the set)").toBeGreaterThanOrEqual(tree.leafCount);
    // Before: callsAfterFirst === drawnAfterFirst (one scale call + rgb() parse per drawn edge per frame).
    expect(r.callsAfterFirst, `${r.callsAfterFirst} colour resolutions for ${r.drawnAfterFirst} drawn super-edges`).toBeLessThan(r.drawnAfterFirst / 100);
    expect(r.probesPerGlyph, `${r.probesPerGlyph.toFixed(2)} declutter probes per frontier glyph`).toBeLessThan(MAX_PROBES_PER_GLYPH);
  }, 120_000);

  it("reductions ON, dense mixed radii: the radius-class grid keeps the single grid's set at O(1) probes per glyph", () => {
    const n = 200_000;
    const { sx, sy, radii, order } = mixedScreen(n);
    const scratch = declutterScratch();
    const out = new Uint8Array(n);
    declutterScreen(n, sx, sy, radii, order, W, H, 1, out, scratch);
    const ref = singleGridKept(n, sx, sy, radii, order);
    expect(firstMismatch(out, ref.kept)).toBe(-1);
    expect(ref.probes / n, "the fixture is dense enough to punish the single grid").toBeGreaterThan(30);
    expect(scratch.probes / n).toBeLessThan(MAX_PROBES_PER_GLYPH);
  }, 120_000);

  it("reductions OFF: the full-detail colour pass runs the accessor once per distinct weight, not per edge", () => {
    const graph = weightedClusteredGraph(100_000); // 200k edges, weights 1-4
    let calls = 0;
    const colorOf = resolveLinkColorOf((w: number) => {
      calls++;
      return strokeScale(w);
    });
    const attrs = linkLinesStyleAttrs(graph, { widthOf: () => 1, colorOf, bend: 0 });
    expect(calls).toBe(4);
    for (let e = 0; e < graph.edgeCount; e += 997) {
      const want = parsed(strokeScale(graph.weight[e] ?? 0));
      expect(Array.from(attrs.colors.subarray(e * 4, e * 4 + 4)), `edge ${e}`).toEqual(want);
    }
  }, 120_000);

  (BENCH ? it : it.skip)(`bench: both legs at ${BENCH_N.toLocaleString()}`, () => {
    // Declutter over an N-glyph dense mixed-radius screen (reductions ON with a visible set of ≈N).
    const { sx, sy, radii, order } = mixedScreen(BENCH_N);
    const scratch = declutterScratch();
    const out = new Uint8Array(BENCH_N);
    const ts: number[] = [];
    for (let rep = 0; rep < 5; rep++) {
      const t0 = performance.now();
      declutterScreen(BENCH_N, sx, sy, radii, order, W, H, 1, out, scratch);
      ts.push(performance.now() - t0);
    }
    const declutterMs = median(ts);
    const probesPerGlyph = scratch.probes / BENCH_N;
    expect(probesPerGlyph).toBeLessThan(MAX_PROBES_PER_GLYPH);

    // The pipeline sweep on a BENCH_N-leaf tree, all-leaves frame included.
    const { graph, tree, centroid, baseK } = lodFixture(BENCH_N);
    const r = runSweep(tree, centroid, baseK, 24);
    expect(r.colourMismatch).toBeNull();
    expect(r.maxFrontier).toBeGreaterThanOrEqual(tree.leafCount);
    expect(r.callsAfterFirst).toBeLessThan(Math.max(1, r.drawnAfterFirst / 100));
    expect(r.probesPerGlyph).toBeLessThan(MAX_PROBES_PER_GLYPH);

    // Reductions OFF: the full-detail colour pass over every edge.
    let calls = 0;
    const colorOf = resolveLinkColorOf((w: number) => {
      calls++;
      return strokeScale(w);
    });
    const t0 = performance.now();
    linkLinesStyleAttrs(graph, { widthOf: () => 1, colorOf, bend: 0 });
    const offMs = performance.now() - t0;
    expect(calls).toBe(4);

    const line =
      `N=${BENCH_N.toLocaleString()}  declutter(N-glyph screen) median=${declutterMs.toFixed(1)}ms probes/glyph=${probesPerGlyph.toFixed(2)}  ` +
      `sweep median=${r.medianMs.toFixed(2)}ms maxFrontier=${r.maxFrontier.toLocaleString()} sweepProbes/glyph=${r.probesPerGlyph.toFixed(2)} ` +
      `colourCalls=${r.callsAfterFirst}/${r.drawnAfterFirst} drawn  fullDetailColours=${graph.edgeCount.toLocaleString()} edges in ${offMs.toFixed(0)}ms (${calls} accessor calls)\n`;
    console.log(line);
    appendFileSync("/tmp/lod-frame-waste-perf.txt", `[${process.env.BENCH_LOD_FRAME_WASTE_LABEL ?? "run"}] ${line}`);
    if (ASSERT) {
      const declutterCeiling = (DECLUTTER_MS_PER_M * BENCH_N) / 1_000_000;
      expect(declutterMs, `declutter median ${declutterMs.toFixed(1)}ms at N=${BENCH_N} (ceiling ${declutterCeiling.toFixed(0)}ms)`).toBeLessThan(declutterCeiling);
      expect(r.medianMs, `sweep frame median ${r.medianMs.toFixed(2)}ms at N=${BENCH_N}`).toBeLessThan(SWEEP_FRAME_MS);
    }
  }, 600_000);
});
