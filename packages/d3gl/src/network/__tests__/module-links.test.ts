import { describe, it, expect } from "vitest";
import {
  buildModuleLODTree,
  checkModuleLinks,
  type ModuleLink,
  type ModuleNode,
} from "../modules.js";
import type { LODTopology } from "../lod.js";

/** All directed super-edges as sorted `[source, target, flow]` triples. */
function superEdges(tree: LODTopology): [number, number, number][] {
  const out: [number, number, number][] = [];
  const offset = tree.superEdgeOffset;
  const target = tree.superEdgeTarget;
  const flow = tree.superEdgeFlow;
  if (!offset || !target || !flow) return out;
  for (let g = 0; g < tree.size; g++) {
    for (let k = offset[g]!; k < offset[g + 1]!; k++)
      out.push([g, target[k]!, Math.round(flow[k]! * 1e6) / 1e6]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * An `.ftree`-shaped hierarchy (#199): top module 1 holds sub-modules 1:1, 1:2 and a leaf 1:3 (ragged);
 * top module 2 holds one leaf. Only bottom-module leaf links are graph edges; every coarser link is a
 * module link, as in an `.ftree`'s `*Links` sections.
 */
const records: ModuleNode[] = [
  { id: 0, path: [1, 1, 1] },
  { id: 1, path: [1, 1, 2] },
  { id: 2, path: [1, 2, 1] },
  { id: 3, path: [2, 1] },
  { id: 4, path: [1, 3] },
];
const edges = { source: [0], target: [1], weight: [0.1] };
const links: ModuleLink[] = [
  { source: [1, 1], target: [1, 2], flow: 0.2 },
  { source: [1, 2], target: [1, 3], flow: 0.05 }, // module → sibling leaf
  { source: [1], target: [2], flow: 0.3 },
];

describe("buildModuleLODTree with module links (#199)", () => {
  const tree = buildModuleLODTree(5, records, edges, links);
  const parent = tree.parent;
  if (!parent) throw new Error("module trees carry a parent map");
  const m11 = parent[0]!;
  const m12 = parent[2]!;
  const m2 = parent[3]!;
  const m1 = parent[m11]!;

  it("adds each module link exactly at its own level — no leaf-level edges are derived from it", () => {
    expect(superEdges(tree)).toEqual(
      [
        [0, 1, 0.1], // the real leaf link inside 1:1
        [m11, m12, 0.2],
        [m12, 4, 0.05],
        [m1, m2, 0.3],
      ].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!),
    );
  });

  it("keeps the in-adjacency (transpose) in step", () => {
    const inFlow = tree.superEdgeInFlow;
    expect(inFlow && Array.from(inFlow).reduce((a, b) => a + b, 0)).toBeCloseTo(
      0.65,
    );
  });

  it("sums a module link with graph-edge contributions to the same pair", () => {
    const summed = buildModuleLODTree(
      5,
      records,
      { source: [0], target: [2], weight: [0.1] },
      [{ source: [1, 1], target: [1, 2], flow: 0.2 }],
    );
    // The leaf edge 0→2 also contributes 1:1→1:2 on its way up.
    expect(superEdges(summed)).toContainEqual([m11, m12, 0.3]);
  });

  it("builds super-edges from module links alone (no graph edges)", () => {
    expect(
      superEdges(buildModuleLODTree(5, records, undefined, [links[2]!])),
    ).toEqual([[m1, m2, 0.3]]);
  });

  it("rejects an endpoint path that is not in the tree", () => {
    expect(() =>
      buildModuleLODTree(5, records, edges, [
        { source: [1, 9], target: [2], flow: 1 },
      ]),
    ).toThrow(/1:9 is not in the module tree/);
  });

  it("checks endpoint paths on their own, without building the tree (what data() runs, #326)", () => {
    expect(() => checkModuleLinks(5, records, links)).not.toThrow();
    expect(() => checkModuleLinks(5, records, [{ source: [1, 9], target: [2], flow: 1 }])).toThrow(/module links: module link endpoint 1:9 is not in the module tree/);
    expect(() => checkModuleLinks(5, records, [{ source: [1], target: [], flow: 1 }])).toThrow(/empty path/);
  });
});
