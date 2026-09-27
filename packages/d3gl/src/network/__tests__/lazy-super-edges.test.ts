import { describe, it, expect } from "vitest";
import { buildMortonLODTree, buildSuperEdges, computeLODPositions, computeLODStyle, cut, declutterFrontier, makeCutScratch, makeDeclutterFrontierScratch, visibleWorldRect, type LODTransform, type LODTree } from "../lod.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildLeafIncidence, lazySuperEdges, makeLazySuperEdgesScratch, type LazyCut } from "../lazy-super-edges.js";
import { superEdges, type SuperEdgeStyleResolved } from "../glyphs.js";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** A graph with community structure placed spatially, plus long-range edges; weights vary unless `unit`. */
function fixture(n: number, seed: number, unit = false): NetworkGraph {
  const r = rng(seed);
  const src: number[] = [];
  const tgt: number[] = [];
  const w: number[] = [];
  for (let i = 1; i < n; i++) {
    src.push(i); tgt.push(Math.max(0, i - 1 - Math.floor(r() * 20))); w.push(unit ? 1 : 1 + Math.floor(r() * 4));
    if (i % 4 === 0) { src.push(Math.floor(r() * n)); tgt.push(i); w.push(unit ? 1 : 0.5); }
    if (i % 97 === 0) { src.push(i); tgt.push(i); w.push(1); } // self-loop
  }
  const g = buildGraph({ nodeCount: n, source: src, target: tgt, weight: w });
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 6 + r() * 0.3;
    const d = 50 + (i / n) * 400 + r() * 30;
    g.positions[2 * i] = Math.cos(a) * d;
    g.positions[2 * i + 1] = Math.sin(a) * d;
  }
  return g;
}

const W = 800;
const H = 600;

function spatialTree(g: NetworkGraph): LODTree {
  const tree = buildMortonLODTree(g.positions, g.nodeCount);
  computeLODPositions(tree, g.positions);
  computeLODStyle(tree, new Float32Array(g.nodeCount).fill(3), g.strength);
  return tree;
}

function styleOf(directed: boolean, linkStyle: "line" | "half-arrow" = "line"): SuperEdgeStyleResolved {
  return { linkStyle, directed, widthOf: (w) => Math.sqrt(w), colorOf: () => [10, 20, 30, 255], bend: 0, arrowSize: 1, maxAggregateRadius: 20 };
}

/** The cut the engine runs (screen-sized, declutter optional), with its covers. */
function cutAt(tree: LODTree, t: LODTransform, declutter: boolean, fadeBand = 0): LazyCut {
  const sc = makeCutScratch();
  const drawn = cut(tree, t, W, H, { screenSized: true, maxAggregateRadius: 20, recordCulled: true, fadeBand, fadeAlpha: fadeBand > 0 ? new Float32Array(tree.size) : undefined }, sc).slice();
  const kept = declutter ? declutterFrontier(tree, drawn, t, W, H, { screenSized: true, k: t.k, maxAggregateRadius: 20 }, makeDeclutterFrontierScratch()).slice() : drawn;
  return { drawn, kept, culled: sc.culled.slice(0, sc.culledCount), split: sc.split.slice(0, sc.splitCount) };
}

/** Brute force: label every leaf by its cover, then apply the drawing rules edge by edge. */
function reference(tree: LODTree, g: NetworkGraph, c: LazyCut, t: LODTransform, directed: boolean): Map<number, number> {
  const label = new Int32Array(g.nodeCount).fill(-1);
  const role = new Map<number, "kept" | "dropped" | "culled">();
  const put = (x: number, r: "kept" | "dropped" | "culled"): void => {
    role.set(x, r);
    for (let q = tree.leafStart![x]!; q < tree.leafEnd![x]!; q++) label[tree.leafOrder![q]!] = x;
  };
  for (const x of c.drawn) put(x, "dropped");
  for (const x of c.kept) role.set(x, "kept");
  for (const x of c.culled) put(x, "culled");
  const view = visibleWorldRect(t, W, H);
  const off = (x: number): boolean => tree.cx[x]! < view.minX || tree.cx[x]! > view.maxX || tree.cy[x]! < view.minY || tree.cy[x]! > view.maxY;
  const out = new Map<number, number>();
  const add = (a: number, b: number, w: number): void => {
    const key = a * tree.size + b;
    out.set(key, (out.get(key) ?? 0) + w);
  };
  for (let e = 0; e < g.edgeCount; e++) {
    const a = label[g.source[e]!]!;
    const b = label[g.target[e]!]!;
    if (a === b) continue;
    const w = g.weight[e]!;
    const ka = role.get(a) === "kept";
    const kb = role.get(b) === "kept";
    if (ka && kb) {
      if (directed) add(a, b, w);
      else add(Math.min(a, b), Math.max(a, b), w);
    } else if (ka && off(b)) add(a, b, w);
    else if (kb && off(a)) add(directed ? a : b, directed ? b : a, w);
  }
  return out;
}

function asMap(ids: number[], flows: number[] | undefined): Map<number, number> {
  const m = new Map<number, number>();
  ids.forEach((id, i) => {
    expect(m.has(id)).toBe(false); // each pair drawn once
    m.set(id, flows?.[i] ?? 0);
  });
  return m;
}

function expectSame(got: Map<number, number>, want: Map<number, number>): void {
  expect([...got.keys()].sort((x, y) => x - y)).toEqual([...want.keys()].sort((x, y) => x - y));
  for (const [k, v] of want) expect(got.get(k)).toBeCloseTo(v, 4);
}

describe("lazySuperEdges (#343)", () => {
  const n = 6000;
  const g = fixture(n, 3);
  const tree = spatialTree(g);
  const fit: LODTransform = { k: 0.9, x: W / 2, y: H / 2 };
  const zoomed: LODTransform = { k: 4, x: W / 2 - 150 * 4, y: H / 2 - 80 * 4 };

  for (const directed of [false, true]) {
    for (const declutter of [false, true]) {
      it(`matches the brute-force gather (${directed ? "directed" : "undirected"}, declutter ${declutter ? "on" : "off"})`, () => {
        const inc = buildLeafIncidence(g, directed);
        for (const t of [fit, zoomed]) {
          const c = cutAt(tree, t, declutter);
          const res = lazySuperEdges(tree, c, styleOf(directed), visibleWorldRect(t, W, H), g.csr, inc);
          expect(res.ids.length).toBeGreaterThan(0);
          expectSame(asMap(res.ids, res.flows), reference(tree, g, c, t, directed));
        }
      });
    }
  }

  // The rules the two gathers share, locked against the CSR gather on the same tree: with every glyph on
  // screen there is no off-screen end (the lazy gather draws those toward the culled cover), and with
  // crossLevelEdges the CSR gather also draws every pair of kept glyphs whatever their depths.
  for (const directed of [false, true]) {
    for (const declutter of [false, true]) {
      it(`draws what the super-edge CSR gather draws with crossLevelEdges, on screen (${directed ? "directed" : "undirected"}, declutter ${declutter ? "on" : "off"})`, () => {
        const parent = tree.parent;
        if (!parent) throw new Error("a spatial tree carries its parent map");
        const withCsr: LODTree = { ...tree, ...buildSuperEdges(tree.size, parent, g) };
        const all: LODTransform = { k: 0.5, x: W / 2, y: H / 2 }; // the whole layout inside the view
        const view = visibleWorldRect(all, W, H);
        const c = cutAt(tree, all, declutter);
        expect(c.culled.length).toBe(0);
        const lazy = lazySuperEdges(tree, c, styleOf(directed), view, g.csr, buildLeafIncidence(g, directed));
        const csr = superEdges(withCsr, c.kept, { ...styleOf(directed), crossLevelEdges: true }, view);
        expect(lazy.ids.length).toBeGreaterThan(0);
        // Undirected, the CSR gather keeps each direction's pair (two lines), the lazy gather one line per
        // pair with the flow of both directions: compare per unordered pair.
        const unordered = (m: Map<number, number>): Map<number, number> => {
          if (directed) return m;
          const u = new Map<number, number>();
          for (const [k, w] of m) {
            const a = Math.floor(k / tree.size);
            const b = k - a * tree.size;
            const key = Math.min(a, b) * tree.size + Math.max(a, b);
            u.set(key, (u.get(key) ?? 0) + w);
          }
          return u;
        };
        expectSame(unordered(asMap(lazy.ids, lazy.flows)), unordered(asMap(csr.ids, csr.flows)));
      });
    }
  }

  it("draws directed half-arrows with reciprocal widths between kept pairs", () => {
    const inc = buildLeafIncidence(g, true);
    const c = cutAt(tree, zoomed, true);
    const res = lazySuperEdges(tree, c, styleOf(true, "half-arrow"), visibleWorldRect(zoomed, W, H), g.csr, inc);
    const ha = res.halfArrows!;
    expect(ha.count).toBe(res.ids.length);
    const flow = asMap(res.ids, res.flows);
    let reciprocal = 0;
    res.ids.forEach((id, i) => {
      const a = Math.floor(id / tree.size);
      const b = id - a * tree.size;
      const back = flow.get(b * tree.size + a);
      if (back !== undefined && c.kept.includes(a) && c.kept.includes(b)) {
        expect(ha.widths[2 * i + 1]).toBeCloseTo(Math.sqrt(back));
        reciprocal++;
      }
    });
    expect(reciprocal).toBeGreaterThan(0);
  });

  it("keeps uniform weights out of memory and gives the same flows", () => {
    const unit = fixture(2000, 5, true);
    const inc = buildLeafIncidence(unit, false);
    expect(inc.weight).toBeNull();
    expect(inc.out).toBeNull();
    expect(inc.uniform).toBe(1);
    const t2 = spatialTree(unit);
    const c = cutAt(t2, fit, true);
    const res = lazySuperEdges(t2, c, styleOf(false), visibleWorldRect(fit, W, H), unit.csr, inc);
    expectSame(asMap(res.ids, res.flows), reference(t2, unit, c, fit, false));
  });

  it("answers a held view from the row memo: no leaf edge walked, identical output", () => {
    const inc = buildLeafIncidence(g, true);
    const sc = makeLazySuperEdgesScratch();
    const c = cutAt(tree, zoomed, true);
    const view = visibleWorldRect(zoomed, W, H);
    const first = lazySuperEdges(tree, c, styleOf(true), view, g.csr, inc, sc);
    expect(sc.misses).toBe(c.kept.length);
    expect(sc.visits).toBeGreaterThan(0);
    expect(sc.labelled).toBeGreaterThan(0);
    const again = lazySuperEdges(tree, c, styleOf(true), view, g.csr, inc, sc);
    expect(sc.hits).toBe(c.kept.length);
    expect(sc.misses).toBe(0);
    expect(sc.visits).toBe(0);
    expect(sc.labelled, "a held view labels no leaf: O(kept + rows), not O(leaves under the frontier)").toBe(0);
    expect(again.ids).toEqual(first.ids);
    expect(again.flows).toEqual(first.flows);
  });

  it("rebuilds exactly the rows a changed cut invalidates, and matches a cold gather", () => {
    const inc = buildLeafIncidence(g, false);
    const sc = makeLazySuperEdgesScratch();
    lazySuperEdges(tree, cutAt(tree, zoomed, true), styleOf(false), visibleWorldRect(zoomed, W, H), g.csr, inc, sc);
    const panned: LODTransform = { k: zoomed.k, x: zoomed.x + 60, y: zoomed.y };
    const c = cutAt(tree, panned, true);
    const warm = lazySuperEdges(tree, c, styleOf(false), visibleWorldRect(panned, W, H), g.csr, inc, sc);
    expect(sc.hits + sc.misses).toBe(c.kept.length);
    const cold = lazySuperEdges(tree, c, styleOf(false), visibleWorldRect(panned, W, H), g.csr, inc);
    expect(warm.ids).toEqual(cold.ids);
    expect(warm.flows).toEqual(cold.flows);
  });

  it("starts the memo over for a new tree (a streamed frame's rebuild)", () => {
    const inc = buildLeafIncidence(g, false);
    const sc = makeLazySuperEdgesScratch();
    const c = cutAt(tree, fit, true);
    lazySuperEdges(tree, c, styleOf(false), visibleWorldRect(fit, W, H), g.csr, inc, sc);
    const rebuilt = spatialTree(g);
    const c2 = cutAt(rebuilt, fit, true);
    lazySuperEdges(rebuilt, c2, styleOf(false), visibleWorldRect(fit, W, H), g.csr, inc, sc);
    expect(sc.hits).toBe(0);
    expect(sc.misses).toBe(c2.kept.length);
  });

  it("in a cross-fade band, never pairs a glyph with its own ancestor or descendant, and a warm memo matches a cold one", () => {
    const inc = buildLeafIncidence(g, true);
    const sc = makeLazySuperEdgesScratch();
    const style = styleOf(true);
    for (const k of [1.2, 1.35, 1.5]) {
      const t: LODTransform = { k, x: W / 2, y: H / 2 };
      const c = cutAt(tree, t, false, 0.4);
      const warm = lazySuperEdges(tree, c, { ...style, fadeAlpha: new Float32Array(tree.size).fill(1) }, visibleWorldRect(t, W, H), g.csr, inc, sc);
      const cold = lazySuperEdges(tree, c, { ...style, fadeAlpha: new Float32Array(tree.size).fill(1) }, visibleWorldRect(t, W, H), g.csr, inc);
      expect(warm.ids).toEqual(cold.ids);
      for (const id of warm.ids) {
        const a = Math.floor(id / tree.size);
        const b = id - a * tree.size;
        const nested = tree.leafStart![a]! < tree.leafEnd![b]! && tree.leafStart![b]! < tree.leafEnd![a]!;
        expect(nested).toBe(false);
      }
    }
  });
});
