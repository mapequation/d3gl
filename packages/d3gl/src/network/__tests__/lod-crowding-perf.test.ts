import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import {
  buildLODTree,
  buildMortonLODTree,
  computeLODCrowding,
  computeLODGeometry,
  crowdingHorizon,
  cut,
  declutterFrontier,
  lodCrowdingPasses,
  makeCutScratch,
  makeDeclutterFrontierScratch,
  makeLODCrowdingScratch,
  type LODTransform,
  type LODTree,
} from "../lod.js";
import { lodFrameStep, makeSpatialLODStream, recycleSpatialFrame } from "../lod-frame.js";
import { buildModuleLODTree, type ModuleNode } from "../modules.js";
import { multilevelSeed } from "../coarsen.js";
import { buildGraph, type NetworkGraph } from "../graph.js";

/**
 * Regression guard for the overlap-aware cut (#426, AGENTS.md lifecycle §5).
 *
 * Two costs move:
 *   - **the crowding pass** ({@link computeLODCrowding}) runs with every position + style pass — on the
 *     worker for each streamed spatial or structure frame, on the main thread when a layout lands, a
 *     style changes, a drag or transition settles (and per repaint for a main-thread tree a GPU or nested
 *     layout streams). It must stay a small multiple of the position pass: O(tree size) plus the cross
 *     pairs near sibling borders, on sparse *and* dense layouts, for every tree kind.
 *   - **the cut** tests one more number per visited node (`k ≥ clearZoom`): the zoom sweep with the
 *     crowding computed — reductions ON (cut + declutter) — must stay within the frame budget, and the
 *     frontier the overlap rule opens must stay bounded by what the screen can show without overlap.
 *
 * Deterministic signatures, asserted unconditionally: a warm pass reallocates none of its scratch; one
 * call is one pass; no clear zoom is NaN; a streamed spatial frame carries the crowding in its own buffer
 * (a recycled buffer is reused, nothing grows once warm). Wall-clock ceilings: generous (~8× the calibrated
 * medians) always-on at 100k; under `PERF_ASSERT` at the tier's N, split into a constant and a per-100k term:
 *   BENCH_LOD_CROWDING=1 BENCH_LOD_CROWDING_NODES=1000000 pnpm exec vitest run packages/d3gl/src/network/__tests__/lod-crowding-perf.test.ts
 * Each bench run appends a labelled line per leg to /tmp/lod-crowding-perf.txt (BENCH_LOD_CROWDING_LABEL).
 */
const BENCH = !!process.env.BENCH_LOD_CROWDING;
const BENCH_N = Number(process.env.BENCH_LOD_CROWDING_NODES) || 1_000_000;
const ASSERT = !!process.env.PERF_ASSERT;
const LOCAL_N = 100_000;
const W = 1280;
const H = 800;
const MAX_AGG = 26;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

interface Fixture { name: string; graph: NetworkGraph; tree: LODTree; radii: Float32Array; centroid: [number, number]; baseK: number }

/** Communities of 50 scattered widely around random centres (the spatial-lod-perf web-like layout). */
function webLikeGraph(n: number): { graph: NetworkGraph; R: number } {
  const r = rng(11);
  const src = new Uint32Array(3 * n);
  const tgt = new Uint32Array(3 * n);
  let e = 0;
  for (let i = 0; i < n; i++) {
    const base = i - (i % 50);
    const span = Math.min(50, n - base);
    src[e] = i; tgt[e++] = base + Math.floor(r() * span);
    src[e] = i; tgt[e++] = base + Math.floor(r() * span);
    src[e] = i; tgt[e++] = Math.floor(r() * n);
  }
  const graph = buildGraph({ nodeCount: n, source: src, target: tgt });
  const R = 20 * Math.sqrt(n);
  const cx = new Float64Array(Math.ceil(n / 50));
  const cy = new Float64Array(cx.length);
  for (let c = 0; c < cx.length; c++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * R;
    cx[c] = Math.cos(a) * d;
    cy[c] = Math.sin(a) * d;
  }
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i / 50);
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(-2 * Math.log(r() + 1e-12)) * R * 0.15;
    graph.positions[2 * i] = (cx[c] ?? 0) + Math.cos(a) * d;
    graph.positions[2 * i + 1] = (cy[c] ?? 0) + Math.sin(a) * d;
  }
  return { graph, R };
}

/** The web-like graph with each community packed on a small lattice around its centre (a nested layout's
 *  compact modules), for the module map. */
function packedModules(n: number): { graph: NetworkGraph; R: number } {
  const web = webLikeGraph(n);
  const { graph } = web;
  for (let c = 0; c * 50 < n; c++) {
    let mx = 0;
    let my = 0;
    const m = Math.min(50, n - c * 50);
    for (let j = 0; j < m; j++) { mx += graph.positions[2 * (c * 50 + j)] ?? 0; my += graph.positions[2 * (c * 50 + j) + 1] ?? 0; }
    mx /= m;
    my /= m;
    for (let j = 0; j < m; j++) {
      graph.positions[2 * (c * 50 + j)] = mx + ((j % 7) - 3) * 12;
      graph.positions[2 * (c * 50 + j) + 1] = my + (Math.floor(j / 7) - 3) * 12;
    }
  }
  return web;
}

/** Hubs ringed by their degree-one satellites, nearly on top of each other (a web graph's force layout). */
function hubsGraph(n: number): { graph: NetworkGraph; R: number } {
  const r = rng(5);
  const graph = buildGraph({ nodeCount: n, source: new Uint32Array(0), target: new Uint32Array(0) });
  const R = 20 * Math.sqrt(n);
  let i = 0;
  while (i < n) {
    const k = Math.min(n - i, Math.floor(1 + Math.pow(r(), -1.2) * 3));
    const hx = (r() - 0.5) * 2 * R;
    const hy = (r() - 0.5) * 2 * R;
    for (let j = 0; j < k && i < n; j++, i++) {
      const a = r() * Math.PI * 2;
      const d = 5 + r() * 3;
      graph.positions[2 * i] = hx + Math.cos(a) * d;
      graph.positions[2 * i + 1] = hy + Math.sin(a) * d;
    }
  }
  return { graph, R };
}

/** A ring backbone with local chords laid out by the real multilevel seed (the frontier-perf fixture). */
function clusteredGraph(n: number): { graph: NetworkGraph; R: number } {
  const r = rng(7);
  const source = new Uint32Array(2 * n);
  const target = new Uint32Array(2 * n);
  for (let i = 0; i < n; i++) {
    source[2 * i] = i; target[2 * i] = (i + 1) % n;
    source[2 * i + 1] = i; target[2 * i + 1] = (i + 1 + Math.floor(r() * 50)) % n;
  }
  const graph = buildGraph({ nodeCount: n, source, target });
  multilevelSeed(graph, { width: 2000, height: 2000 });
  let span = 0;
  for (let i = 0; i < 2 * n; i++) span = Math.max(span, Math.abs(graph.positions[i] ?? 0));
  return { graph, R: span };
}

function degreeRadii(graph: NetworkGraph): Float32Array {
  const r = new Float32Array(graph.nodeCount);
  for (let i = 0; i < graph.nodeCount; i++) r[i] = 2 + Math.sqrt(graph.csr.degree[i] ?? 0);
  return r;
}

function fixture(name: string, made: { graph: NetworkGraph; R: number }, build: (g: NetworkGraph) => LODTree): Fixture {
  const { graph, R } = made;
  const tree = build(graph);
  const radii = degreeRadii(graph);
  computeLODGeometry(tree, graph, radii, graph.strength);
  return { name, graph, tree, radii, centroid: [0, 0], baseK: (0.85 * Math.min(W, H)) / (2.4 * R) };
}

/** Every fixture at `n`: sparse and dense spatial trees, a coarsening tree, a flat module map. */
function fixtures(n: number): Fixture[] {
  const web = webLikeGraph(n);
  const modules: ModuleNode[] = Array.from({ length: n }, (_, id) => ({ id, path: [Math.floor(id / 50) + 1, (id % 50) + 1] }));
  return [
    fixture("spatial-web", web, (g) => buildMortonLODTree(g.positions, g.nodeCount)),
    fixture("spatial-hubs", hubsGraph(n), (g) => buildMortonLODTree(g.positions, g.nodeCount)),
    fixture("structure", clusteredGraph(n), (g) => buildLODTree(g)),
    fixture("modules", packedModules(n), () => buildModuleLODTree(n, modules)),
  ];
}

const at = (c: [number, number], k: number): LODTransform => ({ k, x: W / 2 - c[0] * k, y: H / 2 - c[1] * k });

function median(ts: number[]): number {
  const s = [...ts].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
}

interface LegResult { name: string; median: number; frontier: number }

function runLegs(fs: Fixture[], reps: number): LegResult[] {
  const out: LegResult[] = [];
  for (const f of fs) {
    const sc = makeLODCrowdingScratch();
    const opts = { screenSized: true, expandPx: crowdingHorizon(f.tree) };
    computeLODCrowding(f.tree, opts, sc); // warm: JIT + scratch high-water
    const warm = { box: sc.box, rmax: sc.rmax, pairA: sc.pairA, order: sc.order };
    const passes = lodCrowdingPasses;
    const ts: number[] = [];
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      computeLODCrowding(f.tree, opts, sc);
      ts.push(performance.now() - t0);
    }
    expect(lodCrowdingPasses - passes, "one call is one pass").toBe(reps);
    expect(sc.box, `${f.name}: box scratch reallocated once warm`).toBe(warm.box);
    expect(sc.rmax).toBe(warm.rmax);
    expect(sc.pairA).toBe(warm.pairA);
    expect(sc.order).toBe(warm.order);
    let nan = 0;
    let open = 0;
    for (let g = f.tree.leafCount; g < f.tree.size; g++) {
      const z = f.tree.clearZoom[g] ?? NaN;
      if (Number.isNaN(z)) nan++;
      else if (z < Infinity) open++;
    }
    expect(nan, `${f.name}: NaN clear zooms`).toBe(0);
    expect(open, `${f.name}: aggregates that can open by overlap (not vacuous)`).toBeGreaterThan(0);
    out.push({ name: `pass:${f.name}`, median: median(ts), frontier: open });

    // The zoom sweep, fit → 64×, reductions ON (cut + declutter), on the engine's scratch.
    const cs = makeCutScratch();
    const ds = makeDeclutterFrontierScratch();
    const frameTs: number[] = [];
    let widest = 0;
    const frames = 13;
    for (let i = 0; i < frames; i++) {
      const t = at(f.centroid, f.baseK * Math.pow(2, (6 * i) / (frames - 1)));
      const t0 = performance.now();
      const drawn = cut(f.tree, t, W, H, { screenSized: true, maxAggregateRadius: MAX_AGG }, cs);
      const kept = declutterFrontier(f.tree, drawn, t, W, H, { screenSized: true, k: t.k, maxAggregateRadius: MAX_AGG }, ds);
      frameTs.push(performance.now() - t0);
      widest = Math.max(widest, drawn.length);
      void kept;
    }
    // Leaves the overlap rule opens do not overlap one another, so they are bounded by the screen area over
    // the smallest glyph's (2 px radius) disc; aggregates by the footprint rule, as before.
    expect(widest, `${f.name}: widest frontier of the sweep`).toBeLessThan((W * H) / (Math.PI * 4));
    out.push({ name: `sweep:${f.name}`, median: median(frameTs), frontier: widest });
  }

  // A streamed spatial frame (the worker's per-frame step) with the crowding, buffers recycled as the engine does.
  const f = fs[0];
  if (f) {
    const stream = makeSpatialLODStream(f.graph.nodeCount, { radii: f.radii, weight: f.graph.strength, crowding: { screenSized: true } }, 1);
    let frame = lodFrameStep(stream, f.graph.positions, 0);
    const ts: number[] = [];
    for (let i = 1; i <= reps; i++) {
      if (frame) recycleSpatialFrame(stream, frame.buffer);
      const t0 = performance.now();
      frame = lodFrameStep(stream, f.graph.positions, i);
      ts.push(performance.now() - t0);
    }
    expect(stream.pool.length + stream.outstanding, "a warm stream keeps one buffer in play").toBeLessThanOrEqual(2);
    out.push({ name: "stream:spatial-web", median: median(ts), frontier: 0 });
  }
  return out;
}

function report(results: LegResult[], n: number, label: string): void {
  for (const r of results) {
    const line = `${r.name.padEnd(22)} N=${n.toLocaleString()} median=${r.median.toFixed(2)}ms frontier=${r.frontier.toLocaleString()}\n`;
    console.log(line.trimEnd());
    if (BENCH) appendFileSync("/tmp/lod-crowding-perf.txt", `[${label}] ${line}`);
  }
}

// Calibrated on an M-series laptop at 100k (medians, see the PR): pass 2-8 ms per tree kind, sweep frame
// 1-5 ms, streamed spatial frame (rebuild + positions + style + crowding) ~15 ms. Ceilings are ~8× those;
// the at-scale leg splits each into a constant and a per-100k-leaves term.
const LOCAL_BUDGET: Record<string, number> = { pass: 60, sweep: 40, stream: 150 };
const CONSTANT_MS: Record<string, number> = { pass: 5, sweep: 10, stream: 10 };
const kindOf = (name: string): string => name.slice(0, name.indexOf(":"));

describe("#426 overlap-aware cut: crowding pass + cut sweep", () => {
  it(`stays within budget at ${LOCAL_N.toLocaleString()} leaves, with the deterministic signatures`, () => {
    const results = runLegs(fixtures(LOCAL_N), 5);
    report(results, LOCAL_N, "local");
    for (const r of results) expect(r.median, `${r.name} median`).toBeLessThan(LOCAL_BUDGET[kindOf(r.name)] ?? 0);
  }, 120_000);

  (BENCH ? it : it.skip)(`bench: the same legs at ${BENCH_N.toLocaleString()} leaves`, () => {
    const results = runLegs(fixtures(BENCH_N), 3);
    report(results, BENCH_N, process.env.BENCH_LOD_CROWDING_LABEL ?? "run");
    if (ASSERT) {
      for (const r of results) {
        const kind = kindOf(r.name);
        const local = LOCAL_BUDGET[kind] ?? 0;
        const c0 = CONSTANT_MS[kind] ?? 0;
        const env = Number(process.env[`PERF_LOD_CROWDING_${kind.toUpperCase()}_MS`]);
        const ceiling = env > 0 ? env : c0 + ((local - c0) * BENCH_N) / LOCAL_N;
        expect(r.median, `${r.name}: median ${r.median.toFixed(1)}ms exceeds ${ceiling.toFixed(0)}ms at N=${BENCH_N}`).toBeLessThan(ceiling);
      }
    }
  }, 900_000);
});
