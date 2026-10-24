import { describe, it, expect } from "vitest";
import { buildStateGraph, lumpStateGraph } from "../state-graph.js";
import { buildModuleLODTree, type ModuleLink } from "../modules.js";
import type { LODTopology } from "../lod.js";

/** Directed physical edge → weight, for order-independent assertions on the aggregation. */
function physEdges(g: { source: Uint32Array; target: Uint32Array; weight: Float32Array }): Map<string, number> {
  const m = new Map<string, number>();
  for (let e = 0; e < g.source.length; e++) m.set(`${g.source[e]}->${g.target[e]}`, g.weight[e]!);
  return m;
}

/** All directed super-edges as sorted `[source, target, flow]` triples, flows rounded to 1e-6. */
function superEdges(tree: LODTopology): [number, number, number][] {
  const out: [number, number, number][] = [];
  const { superEdgeOffset: offset, superEdgeTarget: target, superEdgeFlow: flow } = tree;
  if (!offset || !target || !flow) return out;
  for (let g = 0; g < tree.size; g++) {
    for (let k = offset[g] ?? 0; k < (offset[g + 1] ?? 0); k++) out.push([g, target[k] ?? -1, Math.round((flow[k] ?? 0) * 1e6) / 1e6]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

describe("buildStateGraph", () => {
  // Two physical nodes A(0), B(1). A has state nodes 0,1; B has state nodes 2,3.
  // State edges: 0->2 (w2), 1->2 (w1) cross A→B; 2->0 (w3) crosses B→A; 0->1 (w5) is intra-A.
  const input = {
    stateCount: 4,
    stateToPhysical: [0, 0, 1, 1],
    source: [0, 1, 2, 0],
    target: [2, 2, 0, 1],
    weight: [2, 1, 3, 5],
    directed: true,
  };

  it("keeps the state-level graph as a full NetworkGraph over the state nodes", () => {
    const { state } = buildStateGraph(input);
    expect(state.nodeCount).toBe(4);
    expect(state.edgeCount).toBe(4);
    expect(Array.from(state.source)).toEqual([0, 1, 2, 0]);
    expect(Array.from(state.target)).toEqual([2, 2, 0, 1]);
    expect(state.directed).toBe(true);
  });

  it("derives the physical network by summing state edges per physical pair (directed)", () => {
    const { physical, physicalCount } = buildStateGraph(input);
    expect(physicalCount).toBe(2);
    // A→B aggregates 0->2 (2) and 1->2 (1) = 3; B→A is 2->0 (3). Intra-A edge 0->1 is A's self-link (#535).
    const edges = physEdges(physical);
    expect(edges.get("0->1")).toBe(3);
    expect(edges.get("1->0")).toBe(3);
    expect(edges.get("0->0")).toBe(5);
    expect(physical.edgeCount).toBe(3); // the two cross-physical directed links + A's self-link
  });

  it("sums every state link inside one physical node into that node's one self-link (#535)", () => {
    // A (0) holds state nodes 0, 1, 2: 0->1 (w2), 1->2 (w3) and 2->2 (w4, a state self-link) stay in A.
    const g = buildStateGraph({
      stateCount: 4,
      stateToPhysical: [0, 0, 0, 1],
      source: [0, 1, 2, 2],
      target: [1, 2, 2, 3],
      weight: [2, 3, 4, 1],
      nodeFlow: [0.25, 0.25, 0.25, 0.25],
      directed: true,
    });
    const edges = physEdges(g.physical);
    expect(edges).toEqual(new Map([["0->0", 9], ["0->1", 1]]));
    // Physical flow is the state flow summed, as before; the self-link counts once in degree and strength.
    expect(Array.from(g.physical.flow!)).toEqual([0.75, 0.25]);
    expect(Array.from(g.physical.degree)).toEqual([2, 1]);
    expect(Array.from(g.physical.strength)).toEqual([10, 1]); // 9 (self, once) + 1
  });

  it("maps physical → state (CSR) as the inverse of stateToPhysical", () => {
    const { physicalToState } = buildStateGraph(input);
    expect(Array.from(physicalToState.offsets)).toEqual([0, 2, 4]);
    expect(Array.from(physicalToState.states.slice(0, 2)).sort()).toEqual([0, 1]); // physical A
    expect(Array.from(physicalToState.states.slice(2, 4)).sort()).toEqual([2, 3]); // physical B
  });

  it("sums per-physical flow from per-state flow when supplied, else leaves it null", () => {
    const withFlow = buildStateGraph({ ...input, nodeFlow: [0.1, 0.2, 0.3, 0.4] });
    expect(Array.from(withFlow.physical.flow!)).toEqual([
      expect.closeTo(0.3), // A = 0.1 + 0.2
      expect.closeTo(0.7), // B = 0.3 + 0.4
    ]);
    expect(withFlow.state.flow).not.toBeNull();
    expect(buildStateGraph(input).physical.flow).toBeNull();
  });

  it("infers physicalCount from the max physical id, or honours an explicit larger count", () => {
    expect(buildStateGraph(input).physicalCount).toBe(2);
    // A third physical node with no state node in this slice still gets a slot.
    const padded = buildStateGraph({ ...input, physicalCount: 3 });
    expect(padded.physicalCount).toBe(3);
    expect(padded.physical.nodeCount).toBe(3);
    expect(Array.from(padded.physicalToState.offsets)).toEqual([0, 2, 4, 4]); // node 2 empty
  });

  it("validates lengths and physical-id bounds", () => {
    expect(() => buildStateGraph({ ...input, stateToPhysical: [0, 0, 1] })).toThrow(/stateToPhysical length/);
    expect(() => buildStateGraph({ ...input, physicalCount: 1 })).toThrow(/out of range/);
  });
});

describe("lumpStateGraph (#529)", () => {
  // Physical A(0) holds state nodes 0,1,2; B(1) holds 3,4. Leaf module 1 holds 0,1,3; leaf module 2 holds 2,4.
  // Lumps: A·1 = {0,1}, A·2 = {2}, B·1 = {3}, B·2 = {4}.
  const sg = buildStateGraph({
    stateCount: 5,
    stateToPhysical: [0, 0, 0, 1, 1],
    // 0->1 inside a lump; 0->3 and 1->3 both A·1 -> B·1; 2->4 A·2 -> B·2; 4->0 B·2 -> A·1; 2->0 A·2 -> A·1.
    source: [0, 0, 1, 2, 4, 2],
    target: [1, 3, 3, 4, 0, 0],
    weight: [7, 2, 1, 4, 5, 6],
    nodeFlow: [0.1, 0.2, 0.3, 0.15, 0.25],
    directed: true,
  });
  const modules = [
    { id: 0, path: [1, 1] },
    { id: 1, path: [1, 2] },
    { id: 2, path: [2, 1] },
    { id: 3, path: [1, 3] },
    { id: 4, path: [2, 2] },
  ];

  it("lumps the state nodes of one physical node in one leaf module, a physical node's lumps consecutive", () => {
    const { graph, stateToLump, lumpToState } = lumpStateGraph(sg, modules);
    expect(graph.state.nodeCount).toBe(4);
    expect(Array.from(stateToLump)).toEqual([0, 0, 1, 2, 3]);
    expect(Array.from(lumpToState.offsets)).toEqual([0, 2, 3, 4, 5]);
    expect(Array.from(lumpToState.states)).toEqual([0, 1, 2, 3, 4]);
    expect(Array.from(graph.stateToPhysical)).toEqual([0, 0, 1, 1]);
    expect(Array.from(graph.physicalToState.offsets)).toEqual([0, 2, 4]);
    expect(Array.from(graph.physicalToState.states)).toEqual([0, 1, 2, 3]);
  });

  it("sums the links between lumps, and the links inside one into its self-link, as the physical graph's merge does", () => {
    const { graph } = lumpStateGraph(sg, modules);
    // 0 → 1 (7) stays inside lump 0 (#535).
    expect(physEdges(graph.state)).toEqual(new Map([["0->0", 7], ["0->2", 3], ["1->3", 4], ["3->0", 5], ["1->0", 6]]));
    expect(graph.state.directed).toBe(true);
    expect(Array.from(graph.state.flow ?? [])).toEqual(Array.from(Float32Array.from([0.3, 0.3, 0.15, 0.25])));
  });

  it("shares the source's physical graph, which merging the lumps by physical node gives again", () => {
    const { graph } = lumpStateGraph(sg, modules);
    expect(graph.physical).toBe(sg.physical);
    expect(graph.physicalCount).toBe(sg.physicalCount);
    const remerged = buildStateGraph({
      stateCount: graph.state.nodeCount,
      stateToPhysical: graph.stateToPhysical,
      source: graph.state.source,
      target: graph.state.target,
      weight: graph.state.weight,
      directed: true,
    });
    expect(physEdges(remerged.physical)).toEqual(physEdges(sg.physical));
  });

  it("ranks each leaf module's lumps by flow, ties by id, after the module's path", () => {
    const { modules: lumped } = lumpStateGraph(sg, modules);
    expect(lumped?.map((r) => Array.from(r.path))).toEqual([[1, 1], [2, 1], [1, 2], [2, 2]]);
    expect(lumped?.map((r) => r.id)).toEqual([0, 1, 2, 3]);
  });

  it("ranks by state-node count without flow, and lumps nodes in no module by physical node", () => {
    const plain = buildStateGraph({ stateCount: 3, stateToPhysical: [0, 0, 1], source: [0], target: [2] });
    const { graph, modules: lumped } = lumpStateGraph(plain, [{ id: 0, path: [1] }, { id: 1, path: [2] }, { id: 2, path: [3] }]);
    expect(graph.state.nodeCount).toBe(2);
    expect(graph.state.flow).toBeNull();
    expect(lumped?.map((r) => Array.from(r.path))).toEqual([[1], [2]]);
  });

  it("without modules lumps each physical node's state nodes into one: the physical network, with no records", () => {
    const { graph, stateToLump, modules: records } = lumpStateGraph(sg);
    expect(graph.state.nodeCount).toBe(sg.physicalCount);
    expect(Array.from(stateToLump)).toEqual([0, 0, 0, 1, 1]);
    expect(records).toBeNull();
    expect(physEdges(graph.state)).toEqual(physEdges(sg.physical));
  });

  it("throws on a record out of range or a state node with no record", () => {
    expect(() => lumpStateGraph(sg, [...modules, { id: 5, path: [1, 4] }])).toThrow(/out of range/);
    expect(() => lumpStateGraph(sg, modules.slice(1))).toThrow(/no module record for state node 0/);
  });
});

describe("lumpStateGraph with module links (#533)", () => {
  // The #529 fixture above: lumps A·1 = {0,1} [1,1], A·2 = {2} [2,1], B·1 = {3} [1,2], B·2 = {4} [2,2].
  const sg = buildStateGraph({
    stateCount: 5,
    stateToPhysical: [0, 0, 0, 1, 1],
    source: [0, 0, 1, 2, 4, 2],
    target: [1, 3, 3, 4, 0, 0],
    weight: [7, 2, 1, 4, 5, 6],
    nodeFlow: [0.1, 0.2, 0.3, 0.15, 0.25],
    directed: true,
  });
  const modules = [
    { id: 0, path: [1, 1] },
    { id: 1, path: [1, 2] },
    { id: 2, path: [2, 1] },
    { id: 3, path: [1, 3] },
    { id: 4, path: [2, 2] },
  ];
  const paths = (links: readonly ModuleLink[] | null) => links?.map((l) => [Array.from(l.source), Array.from(l.target), l.flow]);

  it("keeps a module endpoint's path and maps a leaf endpoint to the path of the lump that holds it", () => {
    const links: ModuleLink[] = [
      { source: [1], target: [2], flow: 0.4 },
      { source: [1, 3], target: [2], flow: 0.1 }, // state 3 → lump B·1, ranked [1, 2]
      { source: [2, 1], target: [1, 1], flow: 0.05 }, // state 2 → lump A·2 [2, 1]; state 0 → lump A·1 [1, 1]
    ];
    const { moduleLinks } = lumpStateGraph(sg, modules, links);
    expect(paths(moduleLinks)).toEqual([[[1], [2], 0.4], [[1, 2], [2], 0.1], [[2, 1], [1, 1], 0.05]]);
    expect(paths(lumpStateGraph(sg, modules).moduleLinks), "no module links given: none").toBeUndefined();
  });

  it("feeds the lumped module tree's super-edges: each link at its own endpoints, nothing else added", () => {
    const links: ModuleLink[] = [{ source: [1, 3], target: [2], flow: 0.1 }];
    const lumped = lumpStateGraph(sg, modules, links);
    const records = lumped.modules ?? [];
    const without = superEdges(buildModuleLODTree(4, records, lumped.graph.state));
    const tree = buildModuleLODTree(4, records, lumped.graph.state, lumped.moduleLinks ?? undefined);
    const m1 = tree.parent?.[0] ?? -1; // lump A·1's module, [1]
    const m2 = tree.parent?.[1] ?? -1; // lump A·2's module, [2]
    // Each super-edge's flow less its flow without the link: the link from lump B·1 (state 3's) into module 2, which
    // module 1 holds, so its module → module edge carries it too.
    const added = superEdges(tree)
      .map(([s, t, f]): [number, number, number] => [s, t, Math.round((f - (without.find((w) => w[0] === s && w[1] === t)?.[2] ?? 0)) * 1e6) / 1e6])
      .filter((e) => e[2] !== 0);
    expect(added).toEqual([[2, m2, 0.1], [m1, m2, 0.1]]);
  });

  it("gives a ragged module's lumps ranks its sub-modules do not use, so a leaf endpoint names the lump", () => {
    // Module 1 holds sub-modules 1:1, 1:2 and the leaf 1:3 (state 4), as Infomap numbers a ragged module's children.
    const ragged = buildStateGraph({ stateCount: 5, stateToPhysical: [0, 1, 2, 3, 4], source: [0], target: [1], directed: true });
    const records = [
      { id: 0, path: [1, 1, 1] },
      { id: 1, path: [1, 1, 2] },
      { id: 2, path: [1, 2, 1] },
      { id: 3, path: [2, 1] },
      { id: 4, path: [1, 3] },
    ];
    const links: ModuleLink[] = [{ source: [1, 2], target: [1, 3], flow: 0.05 }];
    const lumped = lumpStateGraph(ragged, records, links);
    const lump4 = lumped.stateToLump[4] ?? -1;
    const path4 = lumped.modules?.[lump4]?.path ?? [];
    expect(Array.from(path4), "not [1, 1]: that is sub-module 1:1").toEqual([1, 3]);
    expect(paths(lumped.moduleLinks)).toEqual([[[1, 2], [1, 3], 0.05]]);
    const tree = buildModuleLODTree(5, lumped.modules ?? [], undefined, lumped.moduleLinks ?? undefined);
    const m12 = tree.parent?.[lumped.stateToLump[2] ?? -1] ?? -1;
    expect(superEdges(tree)).toEqual([[m12, lump4, 0.05]]);
  });

  it("throws on module links without modules, or with an endpoint outside the hierarchy", () => {
    expect(() => lumpStateGraph(sg, null, [{ source: [1], target: [2], flow: 1 }])).toThrow(/requires modules/);
    expect(() => lumpStateGraph(sg, modules, [{ source: [9], target: [2], flow: 1 }])).toThrow(/endpoint 9 is not in the module tree/);
  });
});
