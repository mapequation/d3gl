import { describe, it, expect } from "vitest";
import { buildModuleLODTree, type ModuleNode, type ModuleEdges } from "../modules.js";
import {
  computeLODPositions,
  computeLODStyle,
  cut,
  lodTreeFromTopology,
  buildSuperEdges,
  type LODTree,
  type LODTopology,
} from "../lod.js";

/** Children of tree node `g`, as a sorted array (scatter order is an implementation detail). */
function childrenOf(tree: { childOffset: Uint32Array; children: Uint32Array }, g: number): number[] {
  return Array.from(tree.children.slice(tree.childOffset[g]!, tree.childOffset[g + 1]!)).sort((a, b) => a - b);
}

/**
 * Balanced two-module tree (Infomap JSON node shape): nodes 0,1 in module `1`; nodes 2,3 in module
 * `2`; both modules under the root. `path` is Infomap's 1-based child-index chain, so the module of
 * a node is `path.slice(0, -1)`.
 */
function balanced() {
  return buildModuleLODTree(4, [
    { id: 0, path: [1, 1] },
    { id: 1, path: [1, 2] },
    { id: 2, path: [2, 1] },
    { id: 3, path: [2, 2] },
  ]);
}

describe("buildModuleLODTree", () => {
  it("turns a balanced module tree into a leaves-first LOD tree with the root as the single coarsest node", () => {
    const tree = balanced();

    expect(tree.leafCount).toBe(4);
    expect(tree.size).toBe(7); // 4 leaves + 2 modules + root
    expect(tree.levelCount).toBe(3); // leaves (h0), modules (h1), root (h2)
    expect(Array.from(tree.levelOffset)).toEqual([0, 4, 6, 7]);

    // Modules 4 = {0,1}, 5 = {2,3}; root 6 = {4,5}. Leaves have no children.
    expect(childrenOf(tree, 4)).toEqual([0, 1]);
    expect(childrenOf(tree, 5)).toEqual([2, 3]);
    expect(childrenOf(tree, 6)).toEqual([4, 5]);
    expect(childrenOf(tree, 0)).toEqual([]);

    // No super-edges in N6a (deferred to N6c): adjacency is empty.
    expect(tree.edgeNeighbors.length).toBe(0);
    expect(tree.edgeOffset[tree.size]).toBe(0);
  });

  it("levels a ragged tree by height so every node's children sit in a strictly lower level", () => {
    // node 0 is a shallow leaf in module `1`; nodes 1,2 are deep in module `2:1`.
    const tree = buildModuleLODTree(3, [
      { id: 0, path: [1, 1] },
      { id: 1, path: [2, 1, 1] },
      { id: 2, path: [2, 1, 2] },
    ]);

    // Heights: leaves 0; modules `1` and `2:1` are 1; module `2` is 2; root is 3.
    expect(tree.levelCount).toBe(4);
    expect(tree.size).toBe(3 + 4); // 3 leaves + {`1`, `2:1`, `2`, root}
    expect(Array.from(tree.levelOffset)).toEqual([0, 3, 5, 6, 7]);

    // Module `1` (h1, id 3) -> {0}; module `2:1` (h1, id 4) -> {1,2}; module `2` (h2, id 5) -> {4};
    // root (h3, id 6) -> {3, 5}. Every child id < its parent id, and child level < parent level.
    expect(childrenOf(tree, 3)).toEqual([0]);
    expect(childrenOf(tree, 4)).toEqual([1, 2]);
    expect(childrenOf(tree, 5)).toEqual([4]);
    expect(childrenOf(tree, 6)).toEqual([3, 5]);
  });

  it("attaches a top-level leaf (path length 1) directly to the root", () => {
    // node 0 sits at the top level (no enclosing module); nodes 1,2 are in module `2`.
    const tree = buildModuleLODTree(3, [
      { id: 0, path: [1] },
      { id: 1, path: [2, 1] },
      { id: 2, path: [2, 2] },
    ]);
    // Module `2` (h1, id 3) -> {1,2}; root (h2, id 4) -> {0, 3}.
    expect(tree.levelCount).toBe(3);
    expect(childrenOf(tree, 3)).toEqual([1, 2]);
    expect(childrenOf(tree, 4)).toEqual([0, 3]);
  });

  describe("the adaptive cut walks the module tree", () => {
    // Two tight clusters far apart: {0@(0,0),1@(4,0)} and {2@(96,0),3@(100,0)}.
    function geo() {
      const tree = balanced();
      computeLODPositions(tree, new Float32Array([0, 0, 4, 0, 96, 0, 100, 0]));
      computeLODStyle(tree, new Float32Array([4, 4, 4, 4]), new Float32Array([1, 1, 1, 1]));
      return tree;
    }
    const W = 2000;
    const H = 2000;
    // Centre the content (centroid x≈50) in the viewport at scale k.
    const view = (k: number) => ({ k, x: W / 2 - 50 * k, y: H / 2 });
    const sortedCut = (tree: ReturnType<typeof geo>, k: number) =>
      Array.from(cut(tree, view(k), W, H)).sort((a, b) => a - b);

    it("draws the root alone when zoomed far out", () => {
      expect(sortedCut(geo(), 0.1)).toEqual([6]);
    });
    it("draws the two modules at mid zoom (root expanded, modules not yet)", () => {
      expect(sortedCut(geo(), 1)).toEqual([4, 5]);
    });
    it("expands modules into their leaves when zoomed in", () => {
      expect(sortedCut(geo(), 12)).toEqual([0, 1, 2, 3]);
    });
  });

  describe("validation", () => {
    it("rejects a record id outside [0, nodeCount)", () => {
      expect(() => buildModuleLODTree(2, [{ id: 0, path: [1] }, { id: 5, path: [1] }])).toThrow(/id/);
    });
    it("rejects records that don't cover every node exactly once", () => {
      expect(() => buildModuleLODTree(3, [{ id: 0, path: [1] }, { id: 1, path: [1] }])).toThrow();
      expect(() => buildModuleLODTree(2, [{ id: 0, path: [1] }, { id: 0, path: [1] }])).toThrow();
    });
    it("rejects an empty path", () => {
      expect(() => buildModuleLODTree(1, [{ id: 0, path: [] }])).toThrow(/path/);
    });
  });
});

// --- #215 guard: the integer-keyed prefix-tree build must produce trees identical to the original
// string-keyed registry it replaced. `referenceModuleLODTree` below is a verbatim copy of that
// original implementation (":"-joined prefix strings interned in a Map); every array of the built
// tree is deep-compared against it, on the hand-written fixtures above and on randomized ragged
// multi-level fixtures with shuffled record order (first-seen registration order is non-trivial). ---
describe("buildModuleLODTree matches the string-keyed reference build (#215)", () => {
  const fixtures: { name: string; nodeCount: number; records: ModuleNode[] }[] = [
    {
      name: "balanced two-module tree",
      nodeCount: 4,
      records: [
        { id: 0, path: [1, 1] },
        { id: 1, path: [1, 2] },
        { id: 2, path: [2, 1] },
        { id: 3, path: [2, 2] },
      ],
    },
    {
      name: "ragged tree",
      nodeCount: 3,
      records: [
        { id: 0, path: [1, 1] },
        { id: 1, path: [2, 1, 1] },
        { id: 2, path: [2, 1, 2] },
      ],
    },
    {
      name: "top-level leaf beside a module",
      nodeCount: 3,
      records: [
        { id: 0, path: [1] },
        { id: 1, path: [2, 1] },
        { id: 2, path: [2, 2] },
      ],
    },
  ];
  for (const f of fixtures) {
    it(`is identical on the ${f.name} fixture`, () => {
      expect(buildModuleLODTree(f.nodeCount, f.records)).toStrictEqual(referenceModuleLODTree(f.nodeCount, f.records));
    });
  }

  it("is identical (including super-edges) on randomized ragged multi-level fixtures", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const nodeCount = 100 + seed * 137; // odd sizes, up to ~785 nodes
      const { records, edges } = randomFixture(seed, nodeCount);
      expect(buildModuleLODTree(nodeCount, records, edges)).toStrictEqual(
        referenceModuleLODTree(nodeCount, records, edges),
      );
    }
  });
});

/** Deterministic LCG in [0, 1) — keeps the randomized fixtures reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Random ragged module fixture: every node gets a random-depth (1–5) path with branch ids 1–4, and
 * the records arrive in a shuffled id order so first-seen module registration interleaves across
 * subtrees. Edges are a random directed list for the super-edge derivation.
 */
function randomFixture(seed: number, nodeCount: number): { records: ModuleNode[]; edges: ModuleEdges } {
  const rng = makeRng(seed);
  const ids = Array.from({ length: nodeCount }, (_, i) => i);
  for (let i = nodeCount - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = ids[i]!;
    ids[i] = ids[j]!;
    ids[j] = t;
  }
  const records = ids.map((id) => {
    const depth = 1 + Math.floor(rng() * 5);
    return { id, path: Array.from({ length: depth }, () => 1 + Math.floor(rng() * 4)) };
  });
  const edgeCount = nodeCount * 2;
  const source = new Uint32Array(edgeCount);
  const target = new Uint32Array(edgeCount);
  const weight = new Float32Array(edgeCount);
  for (let e = 0; e < edgeCount; e++) {
    source[e] = Math.floor(rng() * nodeCount);
    target[e] = Math.floor(rng() * nodeCount);
    weight[e] = rng();
  }
  return { records, edges: { source, target, weight } };
}

/**
 * The pre-#215 string-keyed implementation, kept verbatim as the reference: registers every module
 * prefix as a ":"-joined path string in a `Map<string, number>` and derives parents/heights from the
 * retained key strings. Slow and allocation-heavy — which is why it was replaced — but its output
 * defines the expected tree.
 */
function referenceModuleLODTree(nodeCount: number, records: ArrayLike<ModuleNode>, edges?: ModuleEdges): LODTree {
  const ROOT_KEY = "";
  const prefixDepth = (key: string): number => {
    if (key === ROOT_KEY) return 0;
    let n = 1;
    for (let i = 0; i < key.length; i++) if (key.charCodeAt(i) === 58 /* ":" */) n++;
    return n;
  };

  const moduleIndex = new Map<string, number>(); // prefix key → internal module index
  const moduleKeys: string[] = []; // internal index → key (registration order)
  const registerModule = (key: string): number => {
    let idx = moduleIndex.get(key);
    if (idx === undefined) {
      idx = moduleKeys.length;
      moduleIndex.set(key, idx);
      moduleKeys.push(key);
    }
    return idx;
  };
  registerModule(ROOT_KEY);

  const leafModule = new Int32Array(nodeCount).fill(-1);
  for (let r = 0; r < records.length; r++) {
    const { id, path } = records[r]!;
    const depth = path.length;
    let key = ROOT_KEY;
    for (let d = 0; d < depth - 1; d++) {
      key = d === 0 ? String(path[d]) : `${key}:${path[d]}`;
      registerModule(key);
    }
    leafModule[id] = registerModule(key);
  }

  const moduleCount = moduleKeys.length;

  const moduleParent = new Int32Array(moduleCount).fill(-1);
  for (let m = 0; m < moduleCount; m++) {
    const key = moduleKeys[m]!;
    if (key === ROOT_KEY) continue;
    const cutAt = key.lastIndexOf(":");
    const parentKey = cutAt === -1 ? ROOT_KEY : key.slice(0, cutAt);
    moduleParent[m] = moduleIndex.get(parentKey)!;
  }

  const moduleHeight = new Int32Array(moduleCount).fill(1);
  const byDepthDesc = Array.from({ length: moduleCount }, (_, m) => m).sort(
    (a, b) => prefixDepth(moduleKeys[b]!) - prefixDepth(moduleKeys[a]!),
  );
  for (const m of byDepthDesc) {
    const p = moduleParent[m]!;
    if (p >= 0 && moduleHeight[m]! + 1 > moduleHeight[p]!) moduleHeight[p] = moduleHeight[m]! + 1;
  }

  let maxHeight = 1;
  for (let m = 0; m < moduleCount; m++) if (moduleHeight[m]! > maxHeight) maxHeight = moduleHeight[m]!;
  const perHeight = new Uint32Array(maxHeight + 1);
  for (let m = 0; m < moduleCount; m++) perHeight[moduleHeight[m]!] = perHeight[moduleHeight[m]!]! + 1;
  const heightStart = new Uint32Array(maxHeight + 1);
  let acc = nodeCount;
  for (let h = 1; h <= maxHeight; h++) {
    heightStart[h] = acc;
    acc += perHeight[h]!;
  }
  const moduleId = new Uint32Array(moduleCount);
  const hcursor = heightStart.slice();
  for (let m = 0; m < moduleCount; m++) {
    const h = moduleHeight[m]!;
    moduleId[m] = hcursor[h]!;
    hcursor[h] = hcursor[h]! + 1;
  }

  const size = nodeCount + moduleCount;
  const levelCount = maxHeight + 1;
  const levelOffset = new Uint32Array(levelCount + 1);
  levelOffset[1] = nodeCount;
  for (let h = 1; h <= maxHeight; h++) levelOffset[h + 1] = levelOffset[h]! + perHeight[h]!;

  const parent = new Int32Array(size).fill(-1);
  for (let i = 0; i < nodeCount; i++) parent[i] = moduleId[leafModule[i]!]!;
  for (let m = 0; m < moduleCount; m++) {
    const p = moduleParent[m]!;
    if (p >= 0) parent[moduleId[m]!] = moduleId[p]!;
  }

  const childOffset = new Uint32Array(size + 1);
  for (let g = 0; g < size; g++) {
    const p = parent[g]!;
    if (p >= 0) childOffset[p + 1] = childOffset[p + 1]! + 1;
  }
  for (let g = 0; g < size; g++) childOffset[g + 1] = childOffset[g + 1]! + childOffset[g]!;
  const children = new Uint32Array(childOffset[size]!);
  const cursor = childOffset.slice(0, size);
  for (let g = 0; g < size; g++) {
    const p = parent[g]!;
    if (p >= 0) {
      children[cursor[p]!] = g;
      cursor[p] = cursor[p]! + 1;
    }
  }

  const topo: LODTopology = {
    size,
    leafCount: nodeCount,
    levelCount,
    levelOffset,
    childOffset,
    children,
    edgeOffset: new Uint32Array(size + 1),
    edgeNeighbors: new Uint32Array(0),
    parent,
  };
  if (edges) Object.assign(topo, buildSuperEdges(size, parent, edges));
  return lodTreeFromTopology(topo);
}
