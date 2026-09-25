import { describe, it, expect } from "vitest";
import { buildModuleLODTree, type ModuleLink, type ModuleNode } from "../modules.js";
import { computeLODGeometry, type LODTree } from "../lod.js";
import { superEdges, type SuperEdgeStyleResolved } from "../glyphs.js";
import { buildGraph } from "../graph.js";

/**
 * Super-edges between tree nodes at **different depths** (#325). A ragged Infomap tree puts leaves (and
 * module-link endpoints) at different depths; the gather must draw every underlying edge between two
 * disjoint visible subtrees, and count it exactly once — whatever depths the two sit at.
 *
 * The property is checked **exhaustively**: every cut (every antichain covering the leaves) of several
 * ragged fixtures, plus decluttered subsets of them, with `crossLevelEdges` on and off, everything on
 * screen. The oracle is independent of the CSR — it climbs `parent` from each edge's endpoints:
 *  - **on**: drawn flow of each visible pair `(A, B)` = Σ flow of the edges `u → v` with `u` under `A`
 *    and `v` under `B` (graph edges and module links alike). No other pair drawn, none drawn twice.
 *  - **off**: the same, restricted to the pairs the tree links directly — `A`, `B` at the same depth, or
 *    the shallower of the two *being* the edge's endpoint there (a leaf, or a module-link endpoint).
 */

const ALL = { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 }; // everything on screen
const STYLE: Omit<SuperEdgeStyleResolved, "crossLevelEdges"> = {
  linkStyle: "line",
  directed: true,
  widthOf: () => 1,
  colorOf: () => [0, 0, 0, 255],
  bend: 0,
  arrowSize: 3,
};

interface Fixture {
  label: string;
  records: ModuleNode[];
  /** Leaf-level graph edges (leaf ids). */
  edges: { source: number[]; target: number[]; weight: number[] };
  links: ModuleLink[];
}

/** Deterministic PRNG so a failing fixture is reproducible from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * The #325 example, ragged on purpose: `u = 1:3:2:5` (depth 4) and `v = 2:1:7` (depth 3), a leaf directly
 * under the root (`3`, depth 1), and leaves at depths 2-4 in between. Every ordered leaf pair gets an edge
 * (integer flows, so sums are exact), plus module links at the same and at different depths — sibling
 * links as an `.ftree` has them, cross-depth links, and links into an endpoint's own ancestor (which lie
 * inside one subtree at every cut and must never draw).
 */
function exampleFixture(): Fixture {
  const paths = [
    [1, 3, 2, 5], // 0: u (depth 4)
    [2, 1, 7], // 1: v (depth 3)
    [1, 1], // 2
    [1, 3, 1], // 3
    [1, 3, 2, 1], // 4
    [2, 1, 1], // 5
    [2, 2], // 6
    [3], // 7: a leaf directly under the root
  ];
  const records = paths.map((path, id) => ({ id, path }));
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  for (let a = 0; a < paths.length; a++) {
    for (let b = 0; b < paths.length; b++) {
      if (a === b) continue;
      source.push(a);
      target.push(b);
      weight.push(((a * 8 + b) % 7) + 1);
    }
  }
  const links: ModuleLink[] = [
    { source: [1, 3], target: [1, 1], flow: 16 }, // module → sibling leaf (an .ftree link)
    { source: [1], target: [2], flow: 32 }, // top modules
    { source: [2, 1], target: [2, 2], flow: 64 },
    { source: [1, 3, 2], target: [2], flow: 128 }, // depth 3 module → depth 1 module
    { source: [3], target: [1, 3], flow: 256 }, // depth 1 leaf → depth 2 module
    { source: [2, 1, 7], target: [1, 3, 2], flow: 512 }, // depth 3 leaf → depth 3 module
    { source: [1, 3, 2, 5], target: [1], flow: 1024 }, // into its own top module: never drawn
    { source: [2], target: [2, 1, 7], flow: 2048 }, // module → its own leaf: never drawn
  ];
  return { label: "#325 example (u 1:3:2:5 → v 2:1:7)", records, edges: { source, target, weight }, links };
}

/**
 * A random ragged module tree (leaves at ≥ 3 distinct depths, up to `maxDepth`), random leaf edges
 * (parallel edges and self-loops included) and random module links between arbitrary tree nodes — same
 * depth, different depths, and ancestor/descendant pairs. Seeds are scanned deterministically from
 * `seed` until the tree is genuinely ragged and has between 40 and 20 000 cuts (enough to mean
 * something, few enough to enumerate).
 */
function randomFixture(seed: number, maxLeaves: number, maxDepth: number): Fixture {
  for (let s = seed; ; s += 1000) {
    const r = rng(s);
    const leafPaths: number[][] = [];
    const modulePaths: number[][] = [];
    // Returns the subtree's cut count: 1 (itself) + the product of its children's.
    const grow = (prefix: number[], depth: number): number => {
      const k = 2 + Math.floor(r() * 2);
      let product = 1;
      for (let i = 1; i <= k; i++) {
        const path = [...prefix, i];
        if (depth < maxDepth && leafPaths.length + k - i < maxLeaves && r() < 0.6) {
          modulePaths.push(path);
          product *= grow(path, depth + 1);
        } else {
          leafPaths.push(path);
        }
      }
      return 1 + product;
    };
    const cuts = grow([], 1);
    const leafDepths = new Set(leafPaths.map((p) => p.length));
    if (leafDepths.size >= 3 && cuts >= 40 && cuts <= 20_000) return withRandomEdges(r, s, leafPaths, modulePaths);
  }
}

function withRandomEdges(r: () => number, seed: number, leafPaths: number[][], modulePaths: number[][]): Fixture {
  const records = leafPaths.map((path, id) => ({ id, path }));
  const n = leafPaths.length;
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  for (let e = 0; e < n * 3; e++) {
    source.push(Math.floor(r() * n));
    target.push(Math.floor(r() * n));
    weight.push(1 + Math.floor(r() * 5));
  }
  const nodes = [...leafPaths, ...modulePaths];
  const links: ModuleLink[] = [];
  for (let l = 0; l < n; l++) {
    const a = nodes[Math.floor(r() * nodes.length)]!;
    const b = nodes[Math.floor(r() * nodes.length)]!;
    if (a.join(":") !== b.join(":")) links.push({ source: a, target: b, flow: 1 + Math.floor(r() * 5) });
  }
  return { label: `random ragged tree (seed ${seed}, ${n} leaves, ${modulePaths.length} modules)`, records, edges: { source, target, weight }, links };
}

/** Per-node depth below the root (root = 0), from `parent` alone — independent of the CSR build. */
function depthsOf(tree: LODTree): Int32Array {
  const parent = tree.parent!;
  const depth = new Int32Array(tree.size);
  for (let g = 0; g < tree.size; g++) {
    let d = 0;
    for (let x = parent[g]!; x >= 0; x = parent[x]!) d++;
    depth[g] = d;
  }
  return depth;
}

/** Path string → tree id, spelled from `parent` + `branch` (resolves module-link endpoints for the oracle). */
function idsByPath(tree: LODTree): Map<string, number> {
  const parent = tree.parent!;
  const branch = tree.branch!;
  const out = new Map<string, number>();
  for (let g = 0; g < tree.size; g++) {
    const path: number[] = [];
    for (let x = g; parent[x]! >= 0; x = parent[x]!) path.unshift(branch[x]!);
    out.set(path.join(":"), g);
  }
  return out;
}

/** Every cut of the subtree at `g`: `[g]` itself, or (an aggregate) one cut per child, combined. */
function cutsOf(tree: LODTree, g: number): number[][] {
  const out: number[][] = [[g]];
  if (g < tree.leafCount) return out;
  let combos: number[][] = [[]];
  for (let c = tree.childOffset[g]!; c < tree.childOffset[g + 1]!; c++) {
    const sub = cutsOf(tree, tree.children[c]!);
    const next: number[][] = [];
    for (const left of combos) for (const right of sub) next.push([...left, ...right]);
    combos = next;
  }
  return out.concat(combos);
}

/** The drawn directed pairs (`"a:b"` → flow), failing on a pair drawn twice. */
function drawnPairs(tree: LODTree, frontier: number[], crossLevelEdges: boolean): Map<string, number> {
  const { ids, flows } = superEdges(tree, Uint32Array.from(frontier), { ...STYLE, crossLevelEdges }, ALL);
  const out = new Map<string, number>();
  ids.forEach((id, e) => {
    const a = Math.floor(id / tree.size);
    const key = `${a}:${id - a * tree.size}`;
    expect(out.has(key), `pair ${key} drawn twice`).toBe(false);
    out.set(key, flows[e]!);
  });
  return out;
}

/** The oracle: expected drawn pairs for a present set (an antichain, possibly not covering every leaf). */
function expectedPairs(
  tree: LODTree,
  depth: Int32Array,
  edges: { source: number[]; target: number[]; weight: number[] },
  present: number[],
  crossLevelEdges: boolean,
): Map<string, number> {
  const parent = tree.parent!;
  const isPresent = new Set(present);
  const cover = (x: number): number => {
    for (let y = x; y >= 0; y = parent[y]!) if (isPresent.has(y)) return y;
    return -1;
  };
  const out = new Map<string, number>();
  for (let e = 0; e < edges.source.length; e++) {
    const u = edges.source[e]!;
    const v = edges.target[e]!;
    const a = cover(u);
    const b = cover(v);
    if (a < 0 || b < 0 || a === b) continue;
    // Off: only what the tree links directly — a same-depth pair, or the shallower side IS the endpoint.
    const direct = depth[a] === depth[b] || (depth[a]! > depth[b]! ? v === b : u === a);
    if (!crossLevelEdges && !direct) continue;
    const key = `${a}:${b}`;
    out.set(key, (out.get(key) ?? 0) + edges.weight[e]!);
  }
  return out;
}

const sorted = (m: Map<string, number>): [string, number][] => [...m].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

/** Build the fixture's tree plus the oracle's flat edge list (leaf edges + resolved module links). */
function setup(fx: Fixture) {
  const n = fx.records.length;
  const tree = buildModuleLODTree(n, fx.records, fx.edges, fx.links);
  const byPath = idsByPath(tree);
  const all = { source: [...fx.edges.source], target: [...fx.edges.target], weight: [...fx.edges.weight] };
  for (const link of fx.links) {
    all.source.push(byPath.get(Array.from(link.source).join(":"))!);
    all.target.push(byPath.get(Array.from(link.target).join(":"))!);
    all.weight.push(link.flow);
  }
  return { tree, depth: depthsOf(tree), all, byPath };
}

describe("super-edges between tree nodes at different depths (#325)", () => {
  const fixtures = [exampleFixture(), randomFixture(1, 12, 5), randomFixture(2, 14, 4), randomFixture(3, 10, 6), randomFixture(4, 16, 3)];
  for (const fx of fixtures) {
    it(`draws exactly the underlying flow on every cut: ${fx.label}`, () => {
      const { tree, depth, all } = setup(fx);
      const root = tree.size - 1;
      const cuts = cutsOf(tree, root);
      expect(cuts.length).toBeGreaterThanOrEqual(13); // the enumeration is real, not a handful of cuts
      const r = rng(99);
      let checked = 0;
      for (const cut of cuts) {
        // The full cut, and a decluttered subset of it (declutter removes glyphs from the frontier).
        const subset = cut.filter(() => r() < 0.7);
        for (const present of [cut, subset]) {
          for (const crossLevelEdges of [true, false]) {
            const want = expectedPairs(tree, depth, all, present, crossLevelEdges);
            const got = drawnPairs(tree, present, crossLevelEdges);
            expect(sorted(got), `cut [${present.join(",")}] crossLevelEdges=${crossLevelEdges}`).toEqual(sorted(want));
            checked++;
          }
        }
      }
      expect(checked).toBe(cuts.length * 4);
    });
  }

  it("draws the depth-4 → depth-3 leaf edge 1:3:2:5 → 2:1:7 once both leaves are visible", () => {
    const records: ModuleNode[] = [
      { id: 0, path: [1, 3, 2, 5] }, // u, depth 4
      { id: 1, path: [2, 1, 7] }, // v, depth 3
    ];
    const tree = buildModuleLODTree(2, records, { source: [0], target: [1], weight: [5] });
    const byPath = idsByPath(tree);
    for (const crossLevelEdges of [false, true]) {
      // Both leaves on the frontier (full zoom): the leaf pair itself.
      expect(sorted(drawnPairs(tree, [0, 1], crossLevelEdges))).toEqual([["0:1", 5]]);
      // u's parent 1:3:2 against v: the deeper side lifted, the shallower endpoint itself.
      const m132 = byPath.get("1:3:2")!;
      expect(sorted(drawnPairs(tree, [m132, 1], crossLevelEdges))).toEqual([[`${m132}:1`, 5]]);
    }
    // u against v's collapsed module 2:1: a real mixed-level pair — drawn only with crossLevelEdges.
    const m21 = byPath.get("2:1")!;
    expect(sorted(drawnPairs(tree, [0, m21], true))).toEqual([[`0:${m21}`, 5]]);
    expect(sorted(drawnPairs(tree, [0, m21], false))).toEqual([]);
  });

  it("draws a present node's edge toward an off-screen deeper chain once, not once per lift level", () => {
    // u = leaf 3 at depth 1, v = leaf 1:3:2:5 at depth 4, both directions. Only u is on screen; v's whole
    // chain (1, 1:3, 1:3:2, v) is off-screen and not present. The edge exits the view toward exactly one
    // proxy (the same-depth ancestor, module 1) — not toward all four nested centroids.
    const records: ModuleNode[] = [
      { id: 0, path: [3] },
      { id: 1, path: [1, 3, 2, 5] },
    ];
    const graph = buildGraph({ nodeCount: 2, source: [0, 1], target: [1, 0], weight: [2, 3], directed: true });
    graph.positions.set([0, 0, 1000, 1000]);
    const tree = buildModuleLODTree(2, records, graph);
    computeLODGeometry(tree, graph, new Float32Array(2).fill(1));
    const m1 = idsByPath(tree).get("1")!;
    const view = { minX: -10, maxX: 10, minY: -10, maxY: 10 };
    for (const crossLevelEdges of [false, true]) {
      const { ids, flows } = superEdges(tree, Uint32Array.from([0]), { ...STYLE, crossLevelEdges }, view);
      expect(ids.map((id, e) => [id, flows[e]])).toEqual([
        [0 * tree.size + m1, 2], // out: u → module 1
        [m1 * tree.size + 0, 3], // in: module 1 → u
      ]);
    }
  });
});
