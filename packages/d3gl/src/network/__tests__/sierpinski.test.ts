import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateSierpinski, type InfomapNode } from "./sierpinski.js";
import { buildModuleLODTree } from "../modules.js";
import { computeLODPositions, computeLODStyle, cut, type LODTree } from "../lod.js";

const childrenOf = (t: LODTree, g: number) =>
  Array.from(t.children.slice(t.childOffset[g]!, t.childOffset[g + 1]!)).sort((a, b) => a - b);

describe("generateSierpinski", () => {
  it.each([1, 2, 3])("builds 3^(D+1) nodes with depth-D module paths (D=%i)", (depth) => {
    const net = generateSierpinski(depth);
    expect(net.nodeCount).toBe(3 ** (depth + 1));
    expect(net.positions.length).toBe(2 * net.nodeCount);
    // Every node carries a full path (D module choices + 1 rank) and a per-level breadth-first index.
    for (const n of net.infomap.nodes) {
      expect(n.path).toHaveLength(depth + 1);
      expect(n.modules).toHaveLength(depth);
      expect(n.path.every((c) => c >= 1 && c <= 3)).toBe(true);
    }
    // Edges: a 3-clique per leaf triangle (= nodeCount) + 3 corner bridges per internal module.
    const internalModules = (3 ** depth - 1) / 2;
    expect(net.source.length).toBe(net.nodeCount + 3 * internalModules);
    // Flow is a normalised distribution.
    const flowSum = net.infomap.nodes.reduce((s, n) => s + n.flow, 0);
    expect(flowSum).toBeCloseTo(1, 10);
  });

  it("matches the user's path shape: a depth-1 node reads like { path: [m, rank] }", () => {
    const { nodes } = generateSierpinski(1).infomap;
    expect(nodes[0]).toMatchObject({ id: 0, path: [1, 1], modules: [1], name: "0" });
    expect(nodes.map((n) => n.path)).toEqual([
      [1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3], [3, 1], [3, 2], [3, 3],
    ]);
  });
});

describe("planted hierarchy → LOD tree", () => {
  it.each([1, 2, 3])("recovers the recursive 3-ary module tree (D=%i)", (depth) => {
    const net = generateSierpinski(depth);
    const tree = buildModuleLODTree(net.nodeCount, net.infomap.nodes);

    expect(tree.leafCount).toBe(net.nodeCount);
    // Levels: leaves (h0), leaf modules (h1), … top modules (hD), root (h(D+1)).
    expect(tree.levelCount).toBe(depth + 2);
    // The root is the unique coarsest node, and it has the 3 top modules as children.
    const root = tree.size - 1;
    expect(childrenOf(tree, root)).toHaveLength(3);
    // Walk one branch root→leaf: every internal node has exactly 3 children until the leaf level.
    let g = root;
    for (let level = 0; level < depth; level++) {
      const kids = childrenOf(tree, g);
      expect(kids).toHaveLength(3);
      expect(kids.every((c) => c >= tree.leafCount)).toBe(true); // still a module
      g = kids[0]!;
    }
    const leafKids = childrenOf(tree, g); // the deepest module: 3 real leaves
    expect(leafKids).toHaveLength(3);
    expect(leafKids.every((c) => c < tree.leafCount)).toBe(true);
  });

  it("the adaptive cut collapses to the root zoomed out and expands to every leaf zoomed in", () => {
    const net = generateSierpinski(3); // 81 nodes
    const tree = buildModuleLODTree(net.nodeCount, net.infomap.nodes);
    computeLODPositions(tree, net.positions);
    computeLODStyle(tree, new Float32Array(net.nodeCount).fill(3), new Float32Array(net.nodeCount).fill(1));

    // Zoomed far out: the whole gasket is one glyph — the root.
    const out = cut(tree, { k: 0.001, x: 0, y: 0 }, 200, 200);
    expect(Array.from(out)).toEqual([tree.size - 1]);

    // Zoomed in with a viewport that contains the gasket (world span 0..1000): every leaf resolves.
    const k = 100;
    const inFrontier = cut(tree, { k, x: 0, y: 0 }, 2400 * k, 2400 * k);
    expect(inFrontier.length).toBe(net.nodeCount);
    expect(Array.from(inFrontier).every((g) => g < tree.leafCount)).toBe(true);
  });
});

describe("committed Infomap fixture (depth 2)", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/sierpinski-depth2.json", import.meta.url), "utf8"),
  ) as { nodes: InfomapNode[] };

  it("is exactly what the generator produces (regression pin on the Infomap output shape)", () => {
    expect(fixture).toEqual(generateSierpinski(2).infomap);
  });

  it("feeds lod({ modules }) directly: parse → buildModuleLODTree recovers 9 leaf triangles", () => {
    const tree = buildModuleLODTree(27, fixture.nodes);
    expect(tree.leafCount).toBe(27);
    expect(tree.levelCount).toBe(4); // leaves, leaf modules, top modules, root
    expect(childrenOf(tree, tree.size - 1)).toHaveLength(3); // 3 top modules under the root
  });
});
