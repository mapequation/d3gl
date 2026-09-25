import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import {
  computeLODGeometry,
  cut,
  declutterFrontier,
  makeCutBoundaries,
  makeCutScratch,
  makeDeclutterFrontierScratch,
  visibleWorldRect,
  type BoundaryDiscs,
  type CutBoundaries,
  type LODTransform,
  type LODTree,
} from "../lod.js";
import { boundaryRings, makeSuperEdgesScratch, superEdges, type SuperEdgeStyleResolved } from "../glyphs.js";
import { buildGraph } from "../graph.js";
import { buildModuleLODTree, type ModuleLink, type ModuleNode } from "../modules.js";

/**
 * Per-frame regression guard for the module boundaries (#329, AGENTS.md lifecycle §5). A LOD frame with
 * `lod({ moduleBoundary, crossLevelEdges })` runs the cut (now also collecting the expanded modules in
 * view), declutter, the super-edge gather (now also anchoring module links at those modules' rings) and
 * the ring build. All of it must stay O(visible), never O(tree):
 *
 *   1. collecting is invisible to the frontier — every frame's cut is identical with and without it;
 *   2. nothing O(tree) is re-allocated per frame — the collector, the cut scratch and the gather's
 *      presence array keep their identity once warm;
 *   3. a frame budget over a zoom sweep with **reductions ON** (the adaptive cut + declutter), with the
 *      boundaries on next to the same pipeline with them off;
 *   4. **reductions OFF**: a cut that opens every module (every leaf drawn, every module ringed, every
 *      module link anchored — the whole map is the visible set) under its own budget;
 *   5. a raw network (no module links) gathers byte-identically with the anchor passed.
 *
 * The fixture is `.ftree`-shaped: graph edges only inside bottom modules, module links between siblings
 * at every level, module discs nested (the geometry the nested layout gives, placed directly so a 1M
 * fixture builds in seconds). N = 100k always-on; the 1M leg is env-gated:
 *   BENCH_MODULE_BOUNDARY=1 npx vitest run packages/d3gl/src/network/__tests__/module-boundary-perf.test.ts
 * (BENCH_MODULE_BOUNDARY_NODES sets N; PERF_ASSERT=1 adds the wall-clock ceilings; each run appends a
 * line to /tmp/module-boundary-perf.txt labelled BENCH_MODULE_BOUNDARY_LABEL).
 */
const BENCH = !!process.env.BENCH_MODULE_BOUNDARY;
const BENCH_N = Number(process.env.BENCH_MODULE_BOUNDARY_NODES) || 1_000_000;
const ASSERT = !!process.env.PERF_ASSERT;
const SWEEP_FRAME_MS = Number(process.env.PERF_MODULE_BOUNDARY_MS) || 20;
const ALL_OPEN_MS = Number(process.env.PERF_MODULE_BOUNDARY_ALL_MS) || 6000;
const ALLOC_KB_PER_FRAME = Number(process.env.PERF_MODULE_BOUNDARY_ALLOC_KB) || 256;
const W = 1280;
const H = 800;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

interface Map {
  tree: LODTree;
  /** The same hierarchy and graph edges, without module links — a raw network. */
  raw: LODTree;
  discs: BoundaryDiscs;
  centre: [number, number];
  baseK: number;
  links: number;
}

/**
 * A ragged `.ftree`-shaped map over `n` leaves: modules split into 2-12 children and bottom out at random
 * (16-96 leaves, or depth 7); each bottom module chains its leaves with two edges each; each module links
 * to two random siblings (a module link, as in an `.ftree`'s `*Links` rows). Every module is a disc inside
 * its parent's (children on a spiral at up to 0.8 R, radius 0.5 R/√k), and those discs are its rings.
 */
function ftreeMap(n: number): Map {
  let s = 13 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const records: ModuleNode[] = new Array<ModuleNode>(n);
  const positions = new Float32Array(n * 2);
  const source: number[] = [];
  const target: number[] = [];
  const links: ModuleLink[] = [];
  const disc = new Map<string, [number, number, number]>(); // module path → its disc
  const place = (lo: number, hi: number, prefix: number[], x: number, y: number, R: number): void => {
    const size = hi - lo;
    disc.set(prefix.join(":"), [x, y, R]);
    if (prefix.length >= 1 && (prefix.length >= 7 || size <= 16 + rng() * 80)) {
      for (let i = lo; i < hi; i++) {
        const rank = i - lo;
        const rr = 0.8 * R * Math.sqrt((rank + 0.5) / size);
        records[i] = { id: i, path: [...prefix, rank + 1] };
        positions[2 * i] = x + rr * Math.cos(rank * GOLDEN);
        positions[2 * i + 1] = y + rr * Math.sin(rank * GOLDEN);
        for (let e = 0; e < 2; e++) {
          source.push(i);
          target.push(lo + Math.floor(rng() * size));
        }
      }
      return;
    }
    const k = Math.min(2 + Math.floor(rng() * 11), size);
    const rc = (0.5 * R) / Math.sqrt(k);
    let start = lo;
    for (let j = 0; j < k; j++) {
      const end = j === k - 1 ? hi : Math.min(hi - (k - 1 - j), Math.max(start + 1, lo + Math.round((size * (j + 1)) / k)));
      const rr = 0.8 * R * Math.sqrt((j + 0.5) / k);
      place(start, end, [...prefix, j + 1], x + rr * Math.cos(j * GOLDEN), y + rr * Math.sin(j * GOLDEN), rc);
      start = end;
    }
    for (let j = 0; j < k; j++) {
      for (let e = 0; e < 2; e++) {
        const o = Math.floor(rng() * k);
        if (o !== j) links.push({ source: [...prefix, j + 1], target: [...prefix, o + 1], flow: 1 + rng() * 9 });
      }
    }
  };
  place(0, n, [], 0, 0, 4 * Math.sqrt(n));
  const g = buildGraph({ nodeCount: n, source, target, directed: true });
  g.positions.set(positions);
  const radii = new Float32Array(n).fill(4);
  const tree = buildModuleLODTree(n, records, g, links);
  computeLODGeometry(tree, g, radii);
  const raw = buildModuleLODTree(n, records, g);
  computeLODGeometry(raw, g, radii);
  // Each module's disc, relative to its leaf centroid (what `nestedBoundaryDiscs` gives the engine).
  const parent = tree.parent!;
  const branch = tree.branch!;
  const rows = tree.size - tree.leafCount;
  const discs: BoundaryDiscs = { dx: new Float32Array(rows), dy: new Float32Array(rows), r: new Float32Array(rows) };
  for (let g2 = tree.leafCount; g2 < tree.size; g2++) {
    const path: number[] = [];
    for (let x = g2; parent[x]! >= 0; x = parent[x]!) path.unshift(branch[x]!);
    const [dx, dy, r] = disc.get(path.join(":"))!;
    const o = g2 - tree.leafCount;
    discs.dx[o] = dx - tree.cx[g2]!;
    discs.dy[o] = dy - tree.cy[g2]!;
    discs.r[o] = r;
  }
  const R0 = 4 * Math.sqrt(n);
  return { tree, raw, discs, centre: [0, 0], baseK: 0.9 * Math.min(W, H) / (2 * R0), links: links.length };
}

const SE_STYLE: SuperEdgeStyleResolved = {
  linkStyle: "half-arrow",
  directed: true,
  widthOf: () => 1,
  colorOf: () => [100, 110, 140, 200],
  bend: 0.15,
  arrowSize: 5,
  maxAggregateRadius: 26,
  crossLevelEdges: true,
};

/** The engine's per-frame LOD pipeline (`computeFrontier` + `frontierLayers`), boundaries on or off. */
class Pipeline {
  readonly cutScratch = makeCutScratch();
  readonly declutterScratch = makeDeclutterFrontierScratch();
  readonly seScratch = makeSuperEdgesScratch();
  readonly bnd: CutBoundaries = makeCutBoundaries();
  constructor(readonly tree: LODTree, readonly discs: BoundaryDiscs) {
    this.bnd.discs = discs;
  }
  frame(t: LODTransform, boundaries: boolean, opts: { expandPx?: number; declutter?: boolean } = {}): { frontier: Uint32Array; edges: number; rings: number; bytes: number } {
    const { tree, bnd } = this;
    bnd.count = 0;
    let frontier = cut(tree, t, W, H, { expandPx: opts.expandPx, maxAggregateRadius: 26, boundaries: boundaries ? bnd : undefined }, this.cutScratch);
    if (opts.declutter !== false) frontier = declutterFrontier(tree, frontier, t, W, H, { screenSized: false, k: t.k, maxAggregateRadius: 26 }, this.declutterScratch);
    const view = visibleWorldRect(t, W, H);
    const se = superEdges(tree, frontier, { ...SE_STYLE, anchor: boundaries ? bnd : undefined }, view, this.seScratch);
    const rings = boundaries ? boundaryRings(tree, bnd, { width: 1, color: "#3a3f52", opacity: 0.5, screen: false, k: t.k }, view) : null;
    const ha = se.halfArrows;
    const bytes = (ha ? ha.sources.byteLength * 2 + ha.radii.byteLength + ha.widths.byteLength + ha.bends.byteLength + ha.colors.byteLength : 0) + (rings ? rings.centers.byteLength + rings.radii.byteLength * 3 + rings.colors.byteLength * 2 : 0);
    return { frontier, edges: se.ids.length, rings: rings?.count ?? 0, bytes };
  }
}

/** A zoom sweep toward an off-centre spot (1× → ~55× over 24 frames), so modules open as it goes. */
function sweep(m: Map): LODTransform[] {
  const R0 = 4 * Math.sqrt(m.tree.leafCount);
  const fx = 0.31 * R0;
  const fy = -0.22 * R0;
  const out: LODTransform[] = [];
  for (let i = 0; i < 24; i++) {
    const k = m.baseK * Math.pow(2, i / 4);
    out.push({ k, x: W / 2 - fx * k, y: H / 2 - fy * k });
  }
  return out;
}

const fitView = (m: Map): LODTransform => ({ k: m.baseK, x: W / 2, y: H / 2 });

/**
 * One **flat** bottom module holding `n` leaves directly, packed inside 0.6 R of its disc of radius R (the
 * room a nested layout leaves around a module's members), plus a small far-off second module; the view
 * (k = 4) sits on the big module's rim, so its ring is in view and none of its members are. The cut walks
 * the module ring-only there (#329): its `n` leaf children must cost nothing.
 */
function flatRim(n: number): { tree: LODTree; discs: BoundaryDiscs; view: LODTransform } {
  const R = 2000;
  const records: ModuleNode[] = new Array<ModuleNode>(n + 4);
  const positions = new Float32Array((n + 4) * 2);
  for (let i = 0; i < n; i++) {
    const rr = 0.6 * R * Math.sqrt((i + 0.5) / n);
    records[i] = { id: i, path: [1, i + 1] };
    positions[2 * i] = rr * Math.cos(i * GOLDEN);
    positions[2 * i + 1] = rr * Math.sin(i * GOLDEN);
  }
  for (let j = 0; j < 4; j++) {
    records[n + j] = { id: n + j, path: [2, j + 1] };
    positions[2 * (n + j)] = 10 * R + j;
    positions[2 * (n + j) + 1] = 0;
  }
  const g = buildGraph({ nodeCount: n + 4, source: [], target: [], directed: true });
  g.positions.set(positions);
  const tree = buildModuleLODTree(n + 4, records);
  computeLODGeometry(tree, g, new Float32Array(n + 4).fill(4));
  const rows = tree.size - tree.leafCount;
  const discs: BoundaryDiscs = { dx: new Float32Array(rows), dy: new Float32Array(rows), r: new Float32Array(rows) };
  for (let o = 0; o < rows; o++) {
    const m = tree.leafCount + o;
    const big = tree.count[m]! >= n; // the big module (and the root, whose ring the cut never draws)
    discs.dx[o] = big ? -tree.cx[m]! : 0; // the big module's disc: radius R, centred on the origin
    discs.dy[o] = big ? -tree.cy[m]! : 0;
    discs.r[o] = big ? R : 10;
  }
  const k = 4;
  return { tree, discs, view: { k, x: W / 2 - R * k, y: H / 2 } }; // view centred on (R, 0): the rim
}

/** Median cut time over `reps` cuts (after a warm one), what the last cut returned, and the scratch
 *  stack's length after them (grow-only: it records the deepest stack any cut needed). */
function rimCut(fx: ReturnType<typeof flatRim>, boundaries: boolean, reps: number): { median: number; frontier: number; rings: number; stack: number } {
  const sc = makeCutScratch();
  const bnd = makeCutBoundaries();
  bnd.discs = fx.discs;
  const run = (): number => cut(fx.tree, fx.view, W, H, { maxAggregateRadius: 26, boundaries: boundaries ? bnd : undefined }, sc).length;
  run();
  const ts: number[] = [];
  let frontier = 0;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    frontier = run();
    ts.push(performance.now() - t0);
  }
  return { median: stats(ts).median, frontier, rings: boundaries ? bnd.count : 0, stack: sc.stack.length };
}

/** The rim guard's assertions at `n` leaves: nothing drawn, one ring collected, the members never walked. */
function checkRim(n: number, assertTime: boolean): { on: ReturnType<typeof rimCut>; off: ReturnType<typeof rimCut> } {
  const fx = flatRim(n);
  const off = rimCut(fx, false, 20);
  const on = rimCut(fx, true, 20);
  expect(off.frontier).toBe(0);
  expect(on.frontier).toBe(0); // no member in view
  expect(on.rings).toBe(1); // the big module's ring is
  // Deterministic signature: the ring-only walk never pushed the module's leaf children (it used to grow
  // the stack to n — 1,048,576 entries at 1M — and pop every one only to drop it).
  expect(on.stack).toBe(off.stack);
  expect(on.stack).toBeLessThanOrEqual(256);
  // Measured: 0.002 ms either way (the leaf pushes took 12.8 ms at 1M, 2.2 ms at 200k).
  if (assertTime) expect(on.median, `rim cut at N=${n}: ${on.median.toFixed(3)}ms`).toBeLessThan(3 * off.median + 0.5);
  return { on, off };
}

/** Modules a cut can open (any extent at all), the root aside — what "every module open" rings. */
function openable(tree: LODTree): number {
  let n = 0;
  for (let g = tree.leafCount; g < tree.size - 1; g++) if (tree.extent[g]! > 0) n++;
  return n;
}

function stats(ts: number[]): { median: number; p95: number } {
  const s = [...ts].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)]!, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]! };
}

/** Time the sweep for one variant (after a warm pass), checking the deterministic signatures per frame. */
function timedSweep(p: Pipeline, frames: LODTransform[], boundaries: boolean): { ts: number[]; rings: number; edges: number } {
  for (const t of frames) p.frame(t, boundaries); // warm: JIT + every grow-on-demand array
  const refs = { ids: p.bnd.ids, seen: p.seScratch.seen, cutFrontier: p.cutScratch.frontier };
  const ts: number[] = [];
  let rings = 0;
  let edges = 0;
  for (const t of frames) {
    const t0 = performance.now();
    const f = p.frame(t, boundaries);
    ts.push(performance.now() - t0);
    rings = Math.max(rings, f.rings);
    edges = Math.max(edges, f.edges);
    // 2. Nothing O(tree) re-allocated per frame once warm.
    expect(p.bnd.ids).toBe(refs.ids);
    expect(p.seScratch.seen).toBe(refs.seen);
    expect(p.cutScratch.frontier).toBe(refs.cutFrontier);
  }
  return { ts, rings, edges };
}

describe("#329 module boundaries per-frame cost", () => {
  it("stays O(visible) with reductions ON (sweep) and OFF (every module open), within budget", () => {
    const N = 100_000;
    const m = ftreeMap(N);
    const frames = sweep(m);
    const p = new Pipeline(m.tree, m.discs);

    // 1. Collecting never changes the frontier (checked on a fresh cut per frame).
    for (const t of frames) {
      const bnd = makeCutBoundaries();
      bnd.discs = m.discs;
      expect(Array.from(cut(m.tree, t, W, H, { maxAggregateRadius: 26, boundaries: bnd }))).toEqual(Array.from(cut(m.tree, t, W, H, { maxAggregateRadius: 26 })));
    }

    // 3. Reductions ON: the boundaries' frame next to the same pipeline without them.
    const off = timedSweep(p, frames, false);
    const on = timedSweep(p, frames, true);
    expect(on.rings).toBeGreaterThan(0); // the sweep really opens (and rings) modules
    expect(on.edges).toBeGreaterThan(off.edges); // and anchors module links
    // Dev hardware at 100k: median ~0.05 ms (0.02 without boundaries), p95 < 0.1 ms. Loose ceilings —
    // the typical sweep frontier is tens of glyphs, so timing is noise-bound here; the signatures above
    // and the at-scale leg's ratio carry the O(visible) proof.
    expect(stats(on.ts).median).toBeLessThan(5);
    expect(Math.max(...on.ts)).toBeLessThan(100);
    expect(stats(on.ts).median).toBeLessThan(3 * stats(off.ts).median + 1);

    // 4. A cut that opens every module at the fit view: every module ringed and every module link
    // anchored — with declutter ON (reductions on, over the largest expanded set there is) and OFF
    // (every leaf drawn: the visible set IS the map).
    for (const declutter of [true, false]) {
      const all = { expandPx: 1e-6, declutter };
      p.frame(fitView(m), true, all); // warm
      const t0 = performance.now();
      const f = p.frame(fitView(m), true, all);
      const allMs = performance.now() - t0;
      if (!declutter) expect(f.frontier.length).toBe(m.tree.leafCount);
      expect(p.bnd.count).toBe(openable(m.tree)); // every module but the root (one-leaf modules have no extent)
      expect(f.rings).toBe(p.bnd.count);
      expect(f.edges, `declutter=${declutter}`).toBeGreaterThan(m.links / 2); // anchored module links
      expect(allMs, `declutter=${declutter}`).toBeLessThan(700); // ~10× over dev hardware (~30-70 ms at 100k)
    }

    // 5. A raw network (no module links): passing the anchor changes nothing.
    const rp = new Pipeline(m.raw, m.discs);
    for (const t of [...frames.slice(0, 24).filter((_, i) => i % 4 === 0), fitView(m)]) {
      const frontier = Uint32Array.from(rp.frame(t, false).frontier);
      rp.bnd.count = 0;
      cut(m.raw, t, W, H, { maxAggregateRadius: 26, boundaries: rp.bnd });
      const view = visibleWorldRect(t, W, H);
      const a = superEdges(m.raw, frontier, { ...SE_STYLE, anchor: rp.bnd }, view);
      const b = superEdges(m.raw, frontier, SE_STYLE, view);
      expect(a.ids).toEqual(b.ids);
      expect(a.halfArrows?.sources).toEqual(b.halfArrows?.sources);
    }
  });

  it("walks a big flat module ring-only in O(its aggregate children) when only its rim is in view", () => {
    checkRim(100_000, true);
  });

  (BENCH ? it : it.skip)(
    `bench: module boundaries per frame at ${BENCH_N.toLocaleString()} leaves`,
    () => {
      const tb = performance.now();
      const m = ftreeMap(BENCH_N);
      const buildMs = performance.now() - tb;
      const log = (line: string): void => {
        console.log(line);
        appendFileSync("/tmp/module-boundary-perf.txt", `[${process.env.BENCH_MODULE_BOUNDARY_LABEL ?? "run"}] ${line}\n`);
      };
      log(`tree.size=${m.tree.size.toLocaleString()}  modules=${(m.tree.size - m.tree.leafCount).toLocaleString()}  moduleLinks=${m.links.toLocaleString()}  fixture+build=${buildMs.toFixed(0)}ms`);
      const frames = sweep(m);
      const p = new Pipeline(m.tree, m.discs);
      let sweepOff = 0;
      for (const boundaries of [false, true]) {
        for (const t of frames) p.frame(t, boundaries); // warm
        const gc = (globalThis as { gc?: () => void }).gc;
        gc?.();
        const m0 = process.memoryUsage();
        const ts: number[] = [];
        let outBytes = 0;
        let rings = 0;
        let maxFrontier = 0;
        for (const t of frames) {
          const t0 = performance.now();
          const f = p.frame(t, boundaries);
          ts.push(performance.now() - t0);
          outBytes += f.bytes;
          rings = Math.max(rings, f.rings);
          maxFrontier = Math.max(maxFrontier, f.frontier.length);
        }
        const m1 = process.memoryUsage();
        const { median, p95 } = stats(ts);
        const abKB = (m1.arrayBuffers - m0.arrayBuffers - outBytes) / frames.length / 1024;
        log(`sweep boundaries=${boundaries}  maxFrontier=${maxFrontier}  maxRings=${rings}  median=${median.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  abDelta-outputs=${abKB.toFixed(1)}KB/frame${gc ? "" : " (no --expose-gc; rough)"}`);
        if (gc) expect(abKB, `boundaries=${boundaries}: typed-array growth per frame beyond its outputs`).toBeLessThan(ALLOC_KB_PER_FRAME);
        if (ASSERT) expect(median, `sweep boundaries=${boundaries}: median ${median.toFixed(2)}ms at N=${BENCH_N}`).toBeLessThan(SWEEP_FRAME_MS);
        if (boundaries) {
          expect(rings).toBeGreaterThan(0);
          // O(visible), not O(tree): an O(tree) pass (≥ 1M elements) would add ≥ 1 ms to a frame that
          // costs ~0.02 ms without the boundaries (measured 0.029 vs 0.016 ms at 1M).
          if (ASSERT) expect(median, `sweep: the boundaries add ${(median - sweepOff).toFixed(3)}ms per frame at N=${BENCH_N}`).toBeLessThan(3 * sweepOff + 0.5);
        } else sweepOff = median;
      }
      // Every module open at the fit view, declutter on (reductions ON over the largest expanded set) and
      // off (reductions OFF: every leaf drawn).
      for (const declutter of [true, false]) {
        const all = { expandPx: 1e-6, declutter };
        for (const boundaries of [false, true]) {
          p.frame(fitView(m), boundaries, all); // warm
          const t0 = performance.now();
          const f = p.frame(fitView(m), boundaries, all);
          const ms = performance.now() - t0;
          log(`every module open  declutter=${declutter}  boundaries=${boundaries}  frontier=${f.frontier.length.toLocaleString()}  rings=${f.rings.toLocaleString()}  edges=${f.edges.toLocaleString()}  ${ms.toFixed(1)}ms`);
          if (!declutter) expect(f.frontier.length).toBe(m.tree.leafCount);
          if (boundaries) expect(f.rings).toBe(openable(m.tree));
          if (ASSERT) expect(ms, `every module open, declutter=${declutter}, boundaries=${boundaries}: ${ms.toFixed(0)}ms at N=${BENCH_N}`).toBeLessThan(ALL_OPEN_MS);
        }
      }
      // A flat bottom module of N leaves with only its rim in view: ring-only, nothing walked per member.
      const rim = checkRim(BENCH_N, ASSERT);
      log(`flat-module rim  boundaries=false ${rim.off.median.toFixed(3)}ms  boundaries=true ${rim.on.median.toFixed(3)}ms  stack=${rim.on.stack}`);
    },
    600_000,
  );
});
