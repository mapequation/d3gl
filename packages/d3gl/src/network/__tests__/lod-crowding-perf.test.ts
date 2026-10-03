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
  lodCrowdingPairs,
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
 *     pairs near sibling borders, on sparse *and* dense layouts, for every tree kind, in `screen` and
 *     `world` size modes — and O(m log m) on a node of `m` children however wide: one flat module of every
 *     leaf, and modules of 10k members, on a packed lattice (swept along one axis alone they cost O(m·√m)).
 *   - **the cut** tests one more number per visited node (`k ≥ clearZoom`): the zoom sweep with the
 *     crowding computed — reductions ON (cut + declutter), in both size modes — must stay within the frame
 *     budget. The frontier it opens is not screen-bounded: members opened from different aggregates may
 *     overlap each other, so in the worst case every visible leaf is drawn — the all-leaves legs of
 *     `frontier-perf` and `spatial-lod-perf` cover that frontier at 1M.
 *
 * Deterministic signatures, asserted unconditionally: a warm pass reallocates none of its scratch; one
 * call is one pass; no clear zoom is NaN; on the wide modules a pass examines at most
 * {@link PAIRS_PER_MEMBER} node pairs per member (a one-axis sweep examined 100-500); the cut draws no
 * aggregate whose members clear at its zoom; a settled spatial frame carries the crowding in its own buffer
 * (a recycled buffer is reused, nothing grows once warm). Wall-clock ceilings: generous (~4-8× the calibrated
 * medians) always-on at 100k; under `PERF_ASSERT` at the tier's N, split into a constant and a per-100k term:
 *   BENCH_LOD_CROWDING=1 BENCH_LOD_CROWDING_NODES=1000000 pnpm exec vitest run packages/d3gl/src/network/__tests__/lod-crowding-perf.test.ts
 * Each bench run appends a labelled line per leg to /tmp/lod-crowding-perf.txt (BENCH_LOD_CROWDING_LABEL).
 */
const BENCH = !!process.env.BENCH_LOD_CROWDING;
const BENCH_N = Number(process.env.BENCH_LOD_CROWDING_NODES) || 1_000_000;
/** The overlap spacings the bench runs its legs at (`BENCH_LOD_CROWDING_SPACINGS`, comma-separated; default 1 and 3). */
const SPACINGS = (process.env.BENCH_LOD_CROWDING_SPACINGS ?? "1,3").split(",").map(Number).filter((x) => x > 0);
const ASSERT = !!process.env.PERF_ASSERT;
const LOCAL_N = 100_000;
const W = 1280;
const H = 800;
const MAX_AGG = 26;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

interface Fixture { name: string; graph: NetworkGraph; tree: LODTree; radii: Float32Array; worldRadii: Float32Array; centroid: [number, number]; baseK: number; wide?: boolean }

/** The most node pairs a pass may examine per member on the wide modules (6-10 measured; a one-axis sweep, 100-500). */
const PAIRS_PER_MEMBER = 40;

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

function fixture(name: string, made: { graph: NetworkGraph; R: number }, build: (g: NetworkGraph) => LODTree, radius?: number): Fixture {
  const { graph, R } = made;
  const tree = build(graph);
  const radii = radius === undefined ? degreeRadii(graph) : new Float32Array(graph.nodeCount).fill(radius);
  // World discs a tenth of the screen legs' size: well inside most layouts' spacing, so members part once a
  // pixel apart (the half-pixel floor) — the world-mode frontier at its widest.
  const worldRadii = radii.map((r) => r / 10);
  computeLODGeometry(tree, graph, radii, graph.strength);
  return { name, graph, tree, radii, worldRadii, centroid: [0, 0], baseK: (0.85 * Math.min(W, H)) / (2.4 * R) };
}

/** Every leaf on one square lattice, 12 apart: the layout the wide modules below are packed on. */
function packedLattice(n: number): { graph: NetworkGraph; R: number } {
  const graph = buildGraph({ nodeCount: n, source: new Uint32Array(0), target: new Uint32Array(0) });
  const side = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    graph.positions[2 * i] = ((i % side) - side / 2) * 12;
    graph.positions[2 * i + 1] = (Math.floor(i / side) - side / 2) * 12;
  }
  return { graph, R: 6 * side };
}

/** One module per `size`-member square tile of the lattice. */
function tiles(n: number, size: number): ModuleNode[] {
  const side = Math.ceil(Math.sqrt(n));
  const t = Math.round(Math.sqrt(size));
  const per = Math.ceil(side / t);
  const rank = new Uint32Array(per * per);
  return Array.from({ length: n }, (_, id) => {
    const m = Math.floor(Math.floor(id / side) / t) * per + Math.floor((id % side) / t);
    const r = (rank[m] ?? 0) + 1;
    rank[m] = r;
    return { id, path: [m + 1, r] };
  });
}

/** Every fixture at `n`: sparse and dense spatial trees, a coarsening tree, a module map of 50-member modules;
 *  with `wide`, also one flat module of every leaf and 10k-member modules, packed on a lattice. */
function fixtures(n: number, wide = true): Fixture[] {
  const web = webLikeGraph(n);
  const modules: ModuleNode[] = Array.from({ length: n }, (_, id) => ({ id, path: [Math.floor(id / 50) + 1, (id % 50) + 1] }));
  const out = [
    fixture("spatial-web", web, (g) => buildMortonLODTree(g.positions, g.nodeCount)),
    fixture("spatial-hubs", hubsGraph(n), (g) => buildMortonLODTree(g.positions, g.nodeCount)),
    fixture("structure", clusteredGraph(n), (g) => buildLODTree(g)),
    fixture("modules", packedModules(n), () => buildModuleLODTree(n, modules)),
  ];
  if (wide) {
    // Sub-pixel glyphs (at the half-pixel floor), so neither module map is crowded below its horizon at any N
    // up to ~2M: every member pair is computed, the pass's worst case on a wide node.
    const lattice = packedLattice(n);
    out.push({ ...fixture("modules-flat", lattice, () => buildModuleLODTree(n, Array.from({ length: n }, (_, id) => ({ id, path: [1, id + 1] }))), 0.5), wide: true });
    out.push({ ...fixture("modules-10k", lattice, () => buildModuleLODTree(n, tiles(n, 10_000)), 0.5), wide: true });
  }
  return out;
}

const at = (c: [number, number], k: number): LODTransform => ({ k, x: W / 2 - c[0] * k, y: H / 2 - c[1] * k });

function median(ts: number[]): number {
  const s = [...ts].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
}

interface LegResult { name: string; median: number; frontier: number }

function runLegs(fs: Fixture[], reps: number, spacing = 1): LegResult[] {
  const out: LegResult[] = [];
  // A leg at an overlap spacing (`lod({ overlapSpacing })`) is labelled `@s<spacing>`, with the same budget.
  const tag = spacing === 1 ? "" : `@s${spacing}`;
  for (const f of fs) {
    for (const screenSized of [true, false]) {
      const mode = (f.wide ? "-wide" : "") + (screenSized ? "" : "-world") + tag;
      computeLODGeometry(f.tree, f.graph, screenSized ? f.radii : f.worldRadii, f.graph.strength);
      const sc = makeLODCrowdingScratch();
      const opts = { screenSized, expandPx: crowdingHorizon(f.tree), spacing };
      computeLODCrowding(f.tree, opts, sc); // warm: JIT + scratch high-water
      const warm = { box: sc.box, rmax: sc.rmax, pairA: sc.pairA, order: sc.order, kdBox: sc.kdBox, perm: sc.perm, kdStack: sc.kdStack };
      const passes = lodCrowdingPasses;
      const pairs0 = lodCrowdingPairs;
      const ts: number[] = [];
      for (let i = 0; i < reps; i++) {
        const t0 = performance.now();
        computeLODCrowding(f.tree, opts, sc);
        ts.push(performance.now() - t0);
      }
      expect(lodCrowdingPasses - passes, "one call is one pass").toBe(reps);
      const again = { box: sc.box, rmax: sc.rmax, pairA: sc.pairA, order: sc.order, kdBox: sc.kdBox, perm: sc.perm, kdStack: sc.kdStack };
      for (const k of ["box", "rmax", "pairA", "order", "kdBox", "perm", "kdStack"] as const) expect(again[k], `${f.name}${mode}: ${k} reallocated once warm`).toBe(warm[k]);
      const perMember = (lodCrowdingPairs - pairs0) / reps / f.tree.leafCount;
      if (f.wide) expect(perMember, `${f.name}${mode}: node pairs examined per member`).toBeLessThan(PAIRS_PER_MEMBER);
      let nan = 0;
      let open = 0;
      for (let g = f.tree.leafCount; g < f.tree.size; g++) {
        const z = f.tree.clearZoom[g] ?? NaN;
        if (Number.isNaN(z)) nan++;
        else if (z < Infinity) open++;
      }
      expect(nan, `${f.name}${mode}: NaN clear zooms`).toBe(0);
      // Packed 12 apart with 3-5 px screen radii, the module map's members all overlap once their radii are taken
      // 3×: that leg is the crowded case (every module stops at its first pairs), not a vacuous one.
      if (spacing !== 1 && f.name === "modules" && screenSized) expect(open, `${f.name}${mode}: the crowded case, nothing opens by overlap`).toBe(0);
      else expect(open, `${f.name}${mode}: aggregates that can open by overlap (not vacuous)`).toBeGreaterThan(0);
      out.push({ name: `pass${mode}:${f.name}`, median: median(ts), frontier: open });
      if (f.wide) continue; // the cut over these is the all-leaves frontier frontier-perf owns

      // The zoom sweep, fit → 64×, reductions ON (cut + declutter), on the engine's scratch.
      const cs = makeCutScratch();
      const ds = makeDeclutterFrontierScratch();
      const frameTs: number[] = [];
      let widest = 0;
      const frames = 13;
      for (let i = 0; i < frames; i++) {
        const t = at(f.centroid, f.baseK * Math.pow(2, (6 * i) / (frames - 1)));
        const t0 = performance.now();
        const drawn = cut(f.tree, t, W, H, { screenSized, maxAggregateRadius: MAX_AGG }, cs);
        const kept = declutterFrontier(f.tree, drawn, t, W, H, { screenSized, k: t.k, maxAggregateRadius: MAX_AGG }, ds);
        frameTs.push(performance.now() - t0);
        widest = Math.max(widest, drawn.length);
        void kept;
        // The rule's signature: no drawn aggregate's members clear at this zoom (it would have opened).
        let clear = 0;
        for (const g of drawn) if (g >= f.tree.leafCount && (f.tree.clearZoom[g] ?? Infinity) <= t.k) clear++;
        expect(clear, `${f.name}${mode}: drawn aggregates whose members clear at k = ${t.k}`).toBe(0);
      }
      out.push({ name: `sweep${mode}:${f.name}`, median: median(frameTs), frontier: widest });
    }
  }

  // A settled spatial frame (the worker's step for a layout's `done`, the one that carries the crowding — a
  // streamed frame has none), buffers recycled as the engine does.
  const f = fs[0];
  if (f) {
    const stream = makeSpatialLODStream(f.graph.nodeCount, { radii: f.radii, weight: f.graph.strength, crowding: { screenSized: true, spacing } }, 1);
    let frame = lodFrameStep(stream, f.graph.positions, 0, true);
    const ts: number[] = [];
    for (let i = 1; i <= reps; i++) {
      if (frame) recycleSpatialFrame(stream, frame.buffer);
      const t0 = performance.now();
      frame = lodFrameStep(stream, f.graph.positions, i, true);
      ts.push(performance.now() - t0);
    }
    expect(stream.pool.length + stream.outstanding, "a warm stream keeps one buffer in play").toBeLessThanOrEqual(2);
    out.push({ name: `stream${tag}:spatial-web`, median: median(ts), frontier: 0 });
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

// Calibrated on an M1 Max at 100k (medians, under load from parallel runs): pass 8-15 ms per tree kind in
// screen mode and 5-18 ms in world mode, 25-33 ms on the wide modules (both modes); sweep frame < 1 ms;
// settled spatial frame (rebuild + positions + style + crowding) 22-26 ms. At 1M: pass 88-169 ms (screen),
// 79-150 ms (world), 268-460 ms on the wide modules, stream ~210 ms. Ceilings are 4-8× the 100k medians; the
// at-scale leg splits each into a constant and a per-100k-leaves term (the wide modules' O(m log m) grows a
// little faster than linear: at 1M they sit at a third of their 1,455 ms ceiling).
const LOCAL_BUDGET: Record<string, number> = { pass: 60, "pass-world": 60, "pass-wide": 150, "pass-wide-world": 150, sweep: 40, "sweep-world": 40, stream: 150 };
const CONSTANT_MS: Record<string, number> = { pass: 5, "pass-world": 5, "pass-wide": 5, "pass-wide-world": 5, sweep: 10, "sweep-world": 10, stream: 10 };
const kindOf = (name: string): string => name.slice(0, name.indexOf(":")).replace(/@s[\d.]+$/, "");

describe("#426 overlap-aware cut: crowding pass + cut sweep", () => {
  it(`stays within budget at ${LOCAL_N.toLocaleString()} leaves, with the deterministic signatures`, () => {
    const results = runLegs(fixtures(LOCAL_N), 5);
    report(results, LOCAL_N, "local");
    for (const r of results) expect(r.median, `${r.name} median`).toBeLessThan(LOCAL_BUDGET[kindOf(r.name)] ?? 0);
  }, 120_000);

  // `lod({ overlapSpacing })` widens every glyph's radius in the test: more pairs fall inside a sweep's window and
  // a walk's reach before a node is crowded. The same legs, signatures and budgets at spacing 3.
  it(`with overlapSpacing 3: the same legs stay within the same budgets at ${LOCAL_N.toLocaleString()} leaves`, () => {
    const results = runLegs(fixtures(LOCAL_N), 5, 3);
    report(results, LOCAL_N, "local");
    for (const r of results) expect(r.median, `${r.name} median`).toBeLessThan(LOCAL_BUDGET[kindOf(r.name)] ?? 0);
  }, 120_000);

  (BENCH ? it : it.skip)(`bench: the same legs at ${BENCH_N.toLocaleString()} leaves`, () => {
    const results = SPACINGS.flatMap((spacing) => runLegs(fixtures(BENCH_N), 3, spacing));
    report(results, BENCH_N, process.env.BENCH_LOD_CROWDING_LABEL ?? "run");
    if (ASSERT) {
      for (const r of results) {
        const kind = kindOf(r.name);
        const local = LOCAL_BUDGET[kind] ?? 0;
        const c0 = CONSTANT_MS[kind] ?? 0;
        const env = Number(process.env[`PERF_LOD_CROWDING_${kind.toUpperCase().replaceAll("-", "_")}_MS`]);
        const ceiling = env > 0 ? env : c0 + ((local - c0) * BENCH_N) / LOCAL_N;
        expect(r.median, `${r.name}: median ${r.median.toFixed(1)}ms exceeds ${ceiling.toFixed(0)}ms at N=${BENCH_N}`).toBeLessThan(ceiling);
      }
    }
  }, 900_000);
});
