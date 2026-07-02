import { describe, it, expect } from "vitest";
import { buildStateGraph } from "../state-graph.js";

/** Directed physical edge → weight, for order-independent assertions on the aggregation. */
function physEdges(g: { source: Uint32Array; target: Uint32Array; weight: Float32Array }): Map<string, number> {
  const m = new Map<string, number>();
  for (let e = 0; e < g.source.length; e++) m.set(`${g.source[e]}->${g.target[e]}`, g.weight[e]!);
  return m;
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

  it("derives the physical network by summing state edges across physical boundaries (directed)", () => {
    const { physical, physicalCount } = buildStateGraph(input);
    expect(physicalCount).toBe(2);
    // A→B aggregates 0->2 (2) and 1->2 (1) = 3; B→A is 2->0 (3). Intra-A edge 0->1 collapses (not a link).
    const edges = physEdges(physical);
    expect(edges.get("0->1")).toBe(3);
    expect(edges.get("1->0")).toBe(3);
    expect(physical.edgeCount).toBe(2); // exactly the two cross-physical directed links
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
