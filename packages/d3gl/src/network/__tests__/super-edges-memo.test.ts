import { describe, it, expect, vi } from "vitest";
import {
  computeLODGeometry,
  computeLODPositions,
  cut,
  declutterFrontier,
  makeCutBoundaries,
  makeCutScratch,
  makeDeclutterFrontierScratch,
  visibleWorldRect,
  type BoundaryDiscs,
  type LODTransform,
  type LODTree,
} from "../lod.js";
import { makeSuperEdgesScratch, superEdges, type SuperEdgeStyleResolved } from "../glyphs.js";
import { buildGraph } from "../graph.js";
import { buildModuleLODTree, type ModuleLink, type ModuleNode } from "../modules.js";
import { firstDifference, makeMapSuperEdgesScratch, superEdgesMapReference } from "./super-edges-map-reference.js";

/**
 * #364: the super-edge gather's per-call scratch moved from `Map`s and `Set`s to generation-stamped typed
 * arrays (the `cover` memo) and open-addressing pair indexes. The output must not move: every frame here
 * is compared **element for element** (`Object.is`, so −0 and NaN count) against the verbatim Map-based
 * gather (`super-edges-map-reference.ts`) — ids, flows and every batch array, for every link style.
 *
 * The fixture is a ragged module map with module links and nested discs, driven through the real cut
 * (collecting the expanded modules for anchoring) and declutter over zoom sweeps toward off-centre spots,
 * so a frame has same-level pairs, off-screen pairs, lift pairs (#325), cross-level projections (#139),
 * anchored module links (#329) and claims (pairs toward an off-screen expanded module) — each counted, so
 * the comparison cannot pass vacuously. One scratch per side serves every frame, tree switch and stamp
 * wrap, as the engine's does: a stale stamp or a pair left from the previous call would show up here.
 */

const W = 1000;
const H = 700;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

interface MemoMap {
  tree: LODTree;
  discs: BoundaryDiscs;
  radius: number;
}

/**
 * A ragged module map over `n` leaves: modules split into 2-6 children and bottom out at 8-40 leaves (or
 * depth 6), and a third of the splitting modules also hold 1-3 leaves directly, so leaves sit at several
 * depths. Each leaf has an edge inside its module and one to a leaf up to 300 ranks on; every 8th a
 * random long-range edge. Each module links to a sibling and, now and then, to any tree node. Flows are
 * fractional, so a changed summation order would show in the last bits. Modules nest on discs.
 */
function memoMap(n: number, seed: number): MemoMap {
  const r = rng(seed);
  const records: ModuleNode[] = new Array<ModuleNode>(n);
  const positions = new Float32Array(n * 2);
  const groupLo = new Uint32Array(n);
  const groupHi = new Uint32Array(n);
  const disc = new Map<string, [number, number, number]>();
  const modulePaths: number[][] = [];
  const links: ModuleLink[] = [];
  const leaf = (i: number, path: number[], x: number, y: number, lo: number, hi: number): void => {
    records[i] = { id: i, path };
    positions[2 * i] = x;
    positions[2 * i + 1] = y;
    groupLo[i] = lo;
    groupHi[i] = hi;
  };
  const place = (lo: number, hi: number, prefix: number[], x: number, y: number, R: number): void => {
    const size = hi - lo;
    disc.set(prefix.join(":"), [x, y, R]);
    if (prefix.length > 0) modulePaths.push(prefix);
    if (prefix.length >= 1 && (prefix.length >= 6 || size <= 8 + r() * 32)) {
      for (let i = lo; i < hi; i++) {
        const rank = i - lo;
        const rr = 0.8 * R * Math.sqrt((rank + 0.5) / size);
        leaf(i, [...prefix, rank + 1], x + rr * Math.cos(rank * GOLDEN), y + rr * Math.sin(rank * GOLDEN), lo, hi);
      }
      return;
    }
    const direct = prefix.length >= 1 && r() < 0.33 ? 1 + Math.floor(r() * 3) : 0;
    const k = Math.min(2 + Math.floor(r() * 5), size - direct);
    const slots = direct + k;
    const at = (j: number): [number, number] => {
      const rr = 0.8 * R * Math.sqrt((j + 0.5) / slots);
      return [x + rr * Math.cos(j * GOLDEN), y + rr * Math.sin(j * GOLDEN)];
    };
    for (let j = 0; j < direct; j++) leaf(lo + j, [...prefix, j + 1], ...at(j), lo, hi);
    const first = lo + direct;
    let start = first;
    for (let j = 0; j < k; j++) {
      const end = j === k - 1 ? hi : Math.min(hi - (k - 1 - j), Math.max(start + 1, first + Math.round(((hi - first) * (j + 1)) / k)));
      const branch = [...prefix, direct + j + 1];
      if (end - start === 1) leaf(start, branch, ...at(direct + j), lo, hi);
      else place(start, end, branch, ...at(direct + j), (0.5 * R) / Math.sqrt(slots));
      start = end;
    }
    for (let j = 0; j < k; j++) {
      const o = Math.floor(r() * k);
      if (o !== j) links.push({ source: [...prefix, direct + j + 1], target: [...prefix, direct + o + 1], flow: 0.5 + r() * 9 });
    }
  };
  place(0, n, [], 0, 0, 4 * Math.sqrt(n));
  // Cross-depth module links between arbitrary tree nodes (a leaf, a module, an ancestor of either).
  const nodes = [...records.map((rec) => Array.from(rec.path)), ...modulePaths];
  for (let l = 0; l < n / 20; l++) {
    const a = nodes[Math.floor(r() * nodes.length)]!;
    const b = nodes[Math.floor(r() * nodes.length)]!;
    if (a.join(":") !== b.join(":")) links.push({ source: a, target: b, flow: 0.25 + r() * 4 });
  }
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i, i);
    target.push(groupLo[i]! + Math.floor(r() * (groupHi[i]! - groupLo[i]!)), (i + 1 + Math.floor(r() * 300)) % n);
    weight.push(0.1 + r() * 3, 0.1 + r() * 3);
    if (i % 8 === 0) {
      source.push(i);
      target.push(Math.floor(r() * n));
      weight.push(0.1 + r());
    }
  }
  const g = buildGraph({ nodeCount: n, source, target, weight, directed: true });
  g.positions.set(positions);
  const radii = new Float32Array(n).map((_, i) => 1 + (i % 5));
  const tree = buildModuleLODTree(n, records, g, links);
  computeLODGeometry(tree, g, radii);
  const parent = tree.parent!;
  const branch = tree.branch!;
  const rows = tree.size - tree.leafCount;
  const discs: BoundaryDiscs = { dx: new Float32Array(rows), dy: new Float32Array(rows), r: new Float32Array(rows) };
  for (let m = tree.leafCount; m < tree.size; m++) {
    const path: number[] = [];
    for (let x = m; parent[x]! >= 0; x = parent[x]!) path.unshift(branch[x]!);
    const [dx, dy, dr] = disc.get(path.join(":"))!;
    discs.dx[m - tree.leafCount] = dx - tree.cx[m]!;
    discs.dy[m - tree.leafCount] = dy - tree.cy[m]!;
    discs.r[m - tree.leafCount] = dr;
  }
  computeLODPositions(tree, g.positions, discs);
  return { tree, discs, radius: 4 * Math.sqrt(n) };
}

const widthOf = (w: number): number => 0.3 + Math.sqrt(w);
const colorOf = (w: number): [number, number, number, number] => [Math.floor(w * 37) % 256, Math.floor(w * 11) % 256, 128, 40 + (Math.floor(w * 7) % 200)];
const STYLES: Omit<SuperEdgeStyleResolved, "crossLevelEdges">[] = [
  { linkStyle: "half-arrow", directed: true, widthOf, colorOf, bend: 0.15, arrowSize: 1, maxAggregateRadius: 12 },
  { linkStyle: "line", directed: true, widthOf, colorOf, bend: 0.2, arrowSize: 4, maxAggregateRadius: 12 },
  { linkStyle: "line", directed: false, widthOf, colorOf, bend: 0, arrowSize: 4 },
];

/** Zoom sweeps (1× → 64×) toward four off-centre spots, then a grid of pans at 4×, 8× and 16×: views that
 *  cut modules through, so their centroids leave the screen while members are still drawn. */
function views(m: MemoMap): LODTransform[] {
  const baseK = (0.9 * Math.min(W, H)) / (2 * m.radius);
  const out: LODTransform[] = [];
  const at = (k: number, fx: number, fy: number): LODTransform => ({ k, x: W / 2 - fx * m.radius * k, y: H / 2 - fy * m.radius * k });
  for (const [fx, fy] of [[0.31, -0.22], [-0.45, 0.1], [0.05, 0.6], [0.7, 0.7]] as const) {
    for (let i = 0; i < 25; i += 2) out.push(at(baseK * Math.pow(2, i / 4), fx, fy));
  }
  for (const zoom of [4, 8, 16]) {
    for (let gx = -0.8; gx <= 0.8; gx += 0.4) for (let gy = -0.8; gy <= 0.8; gy += 0.4) out.push(at(baseK * zoom, gx, gy));
  }
  return out;
}

/** Tally of what a comparison run exercised — the non-vacuity evidence. */
interface Exercised {
  frames: number;
  edges: number;
  projected: number;
  anchored: number;
  claimFrames: number;
  maxClaims: number;
  reciprocal: number;
  /** `Map`/`Set` entries the typed gather wrote (#364's signature: none, on every path, anchoring too). */
  mapWrites: number;
}

/** Run the typed gather, counting the `Map` and `Set` entries written meanwhile into `seen.mapWrites`. */
function typedGather(seen: Exercised, run: () => ReturnType<typeof superEdges>): ReturnType<typeof superEdges> {
  const set = vi.spyOn(Map.prototype, "set");
  const add = vi.spyOn(Set.prototype, "add");
  try {
    return run();
  } finally {
    seen.mapWrites += set.mock.calls.length + add.mock.calls.length;
    set.mockRestore();
    add.mockRestore();
  }
}

/** The engine's LOD frame up to the gather: the cut (collecting the expanded modules in view for anchoring,
 *  a fade band when asked) and the declutter. */
class Cutter {
  readonly bnd = makeCutBoundaries();
  readonly fadeAlpha: Float32Array;
  private readonly cutScratch = makeCutScratch();
  private readonly dScratch = makeDeclutterFrontierScratch();
  constructor(private readonly m: MemoMap) {
    this.bnd.radius = m.discs.r;
    this.fadeAlpha = new Float32Array(m.tree.size);
  }
  frame(t: LODTransform, fading: boolean): { raw: Uint32Array; decluttered: Uint32Array; view: ReturnType<typeof visibleWorldRect> } {
    const tree = this.m.tree;
    this.bnd.count = 0;
    const raw = cut(tree, t, W, H, { expandPx: 24, maxAggregateRadius: 12, boundaries: this.bnd, fadeBand: fading ? 0.3 : 0, fadeAlpha: fading ? this.fadeAlpha : undefined }, this.cutScratch).slice();
    const decluttered = declutterFrontier(tree, raw, t, W, H, { screenSized: false, k: t.k, maxAggregateRadius: 12 }, this.dScratch).slice();
    return { raw, decluttered, view: visibleWorldRect(t, W, H) };
  }
}

/**
 * Cut `m` at every view (with and without declutter, fade band on alternate frames), then gather each
 * frame for every link style, `crossLevelEdges` on and off, anchoring on and off — once through the typed-
 * array gather, once through the Map reference, each side with its one reused scratch — and compare.
 */
function compareOverViews(m: MemoMap, sc: ReturnType<typeof makeSuperEdgesScratch>, ref: ReturnType<typeof makeMapSuperEdgesScratch>, seen: Exercised): string[] {
  const { tree } = m;
  const cutter = new Cutter(m);
  const { bnd, fadeAlpha } = cutter;
  const failures: string[] = [];
  views(m).forEach((t, v) => {
    const fading = v % 2 === 1;
    const { raw, decluttered, view } = cutter.frame(t, fading);
    for (const frontier of [raw, decluttered]) {
      for (const base of STYLES) {
        for (const [crossLevelEdges, anchored] of [[false, false], [true, false], [true, true]] as const) {
          const style: SuperEdgeStyleResolved = { ...base, crossLevelEdges, anchor: anchored ? bnd : undefined, fadeAlpha: fading ? fadeAlpha : undefined };
          const got = typedGather(seen, () => superEdges(tree, frontier, style, view, sc));
          const want = superEdgesMapReference(tree, frontier, style, view, ref);
          const diff = firstDifference(got, want);
          if (diff !== "") failures.push(`view ${v} (k=${t.k.toFixed(3)}), frontier ${frontier.length}, ${base.linkStyle}${base.directed ? " directed" : ""}, crossLevelEdges=${crossLevelEdges}, anchor=${anchored}: ${diff}`);
          seen.frames++;
          seen.edges += want.ids.length;
          seen.projected += ref.proj.size;
          seen.anchored += ref.anchor.size;
          if (ref.claimed.size > 0) seen.claimFrames++;
          seen.maxClaims = Math.max(seen.maxClaims, ref.claimed.size);
          const ha = got.halfArrows;
          if (ha) for (let e = 0; e < ha.count; e++) if (ha.widths[2 * e] !== ha.widths[2 * e + 1]) seen.reciprocal++;
        }
      }
    }
  });
  // Everything present at once (the reductions-off shape): every leaf, everything on screen.
  const leaves = new Uint32Array(tree.leafCount).map((_, i) => i);
  const all = { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 };
  for (const base of STYLES) {
    for (const crossLevelEdges of [false, true]) {
      const style: SuperEdgeStyleResolved = { ...base, crossLevelEdges };
      const diff = firstDifference(typedGather(seen, () => superEdges(tree, leaves, style, all, sc)), superEdgesMapReference(tree, leaves, style, all, ref));
      if (diff !== "") failures.push(`all leaves, ${base.linkStyle}, crossLevelEdges=${crossLevelEdges}: ${diff}`);
      seen.frames++;
    }
  }
  return failures;
}

describe("#364 the typed-array super-edge gather reproduces the Map-based gather", () => {
  it("element for element over zoom sweeps of ragged module maps, every link style, across tree switches", () => {
    const small = memoMap(1500, 9);
    const big = memoMap(20_000, 5);
    const sc = makeSuperEdgesScratch();
    const ref = makeMapSuperEdgesScratch();
    const seen: Exercised = { frames: 0, edges: 0, projected: 0, anchored: 0, claimFrames: 0, maxClaims: 0, reciprocal: 0, mapWrites: 0 };
    // Small, then big (the memo grows to the bigger tree), then small again on the grown scratch.
    const failures = [...compareOverViews(small, sc, ref, seen), ...compareOverViews(big, sc, ref, seen), ...compareOverViews(small, sc, ref, seen)];
    expect(failures.slice(0, 5), `${failures.length} frames differ`).toEqual([]);
    // The typed gather wrote no Map or Set entry on any of those calls: the anchored (#329) and claim
    // passes included, which the per-frame guard's fixture (no module links) does not reach.
    expect(seen.mapWrites).toBe(0);

    // Non-vacuity: every pass that used a Map ran, often, and the scratch grew past its initial sizes
    // (measured: 6.9k calls, 1.8M drawn pairs, 55k projected and 28k anchored pairs, claims on 495 frames
    // and up to 22 in one, 62k reciprocal half-arrow widths).
    expect(seen.frames).toBeGreaterThan(5000);
    expect(seen.edges).toBeGreaterThan(1_500_000);
    expect(seen.projected).toBeGreaterThan(30_000);
    expect(seen.anchored).toBeGreaterThan(15_000);
    expect(seen.claimFrames).toBeGreaterThan(200);
    expect(seen.maxClaims).toBeGreaterThan(16);
    expect(seen.reciprocal).toBeGreaterThan(50_000);
    expect(sc.pairs.capacity).toBeGreaterThan(1024);
    expect(sc.pairedRows.length).toBeGreaterThan(256);
    expect(sc.claimW.length).toBeGreaterThan(16);
    expect(sc.cover.length).toBeGreaterThanOrEqual(big.tree.size);
  });

  it("clears the cover memo when the generation stamp wraps", () => {
    const m = memoMap(20_000, 5);
    const cutter = new Cutter(m);
    const baseK = (0.9 * Math.min(W, H)) / (2 * m.radius);
    const at = (zoom: number): LODTransform => ({ k: baseK * zoom, x: W / 2 - 0.31 * m.radius * baseK * zoom, y: H / 2 + 0.22 * m.radius * baseK * zoom });
    const style: SuperEdgeStyleResolved = { ...STYLES[0]!, crossLevelEdges: true };
    // The first call memoises covers at stamp 1 over the decluttered frontier; after the wrap the stamp is 1
    // again, over the same cut before declutter, so a cover memoised then and left in place would answer
    // for the other frontier.
    const { raw, decluttered, view } = cutter.frame(at(2), false);
    const sc = makeSuperEdgesScratch();
    const first = superEdges(m.tree, decluttered, style, view, sc);
    expect(sc.gen).toBe(1);
    sc.gen = 0x7fffffff;
    const got = superEdges(m.tree, raw, style, view, sc);
    expect(sc.gen).toBe(1); // it wrapped
    const ref = makeMapSuperEdgesScratch();
    const want = superEdgesMapReference(m.tree, raw, style, view, ref);
    expect(firstDifference(got, want)).toBe("");
    // Non-vacuity: the second frame projects (it reads the memo), and it is not the first frame.
    expect(ref.proj.size).toBeGreaterThan(100);
    expect(first.ids.length).not.toBe(want.ids.length);
  });
});
