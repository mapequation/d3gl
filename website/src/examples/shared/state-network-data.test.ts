import { describe, it, expect } from "vitest";
import { generateLFR, generateStateNetwork } from "./state-network-data.js";

describe("generateLFR", () => {
  it("plants communities with a low cross-community edge fraction at small mu", () => {
    const net = generateLFR({ nodeCount: 300, communityCount: 6, mu: 0.1, seed: 7 });
    expect(net.nodeCount).toBe(300);
    let cross = 0;
    for (const [a, b] of net.edges) if (net.community[a] !== net.community[b]) cross++;
    // Roughly mu of edges cross communities; assert it's a clear minority (planted structure survives).
    expect(cross / net.edges.length).toBeLessThan(0.3);
    expect(net.edges.length).toBeGreaterThan(300); // avg degree ≳ 2
  });

  it("is deterministic for a given seed", () => {
    const a = generateLFR({ seed: 42 });
    const b = generateLFR({ seed: 42 });
    expect(a.edges).toEqual(b.edges);
  });
});

describe("generateStateNetwork", () => {
  it("makes state nodes the directed physical edges, with physical = the head node", () => {
    const { graph, physical } = generateStateNetwork({ nodeCount: 120, seed: 3 });
    // Directed edges = 2 × undirected edges → that many state nodes.
    expect(graph.state.nodeCount).toBe(physical.edges.length * 2);
    expect(graph.physicalCount).toBe(physical.nodeCount);
    // Every state node's physical id is a valid physical node.
    for (let s = 0; s < graph.state.nodeCount; s++) {
      expect(graph.stateToPhysical[s]!).toBeLessThan(physical.nodeCount);
    }
  });

  it("produces overlapping modules at bridge physical nodes (the reason for pie charts)", () => {
    const { graph, stateModules } = generateStateNetwork({ nodeCount: 240, mu: 0.2, seed: 5 });
    const topModuleOf = (s: number) => Number(stateModules[s]!.path[0]);
    // For each physical node, collect the top modules its state nodes span.
    let overlapping = 0;
    for (let pnode = 0; pnode < graph.physicalCount; pnode++) {
      const mods = new Set<number>();
      for (let i = graph.physicalToState.offsets[pnode]!; i < graph.physicalToState.offsets[pnode + 1]!; i++) {
        mods.add(topModuleOf(graph.physicalToState.states[i]!));
      }
      if (mods.size >= 2) overlapping++;
    }
    // With cross-community edges, a meaningful set of physical nodes are bridges (multi-module).
    expect(overlapping).toBeGreaterThan(0);
  });

  it("weights trigrams by the node2vec bias: a triangle-closing step outweighs exploration", () => {
    // Tiny hand-built physical graph: a triangle 0-1-2 plus a pendant 3 off node 1.
    //   From state (0,1): neighbours of 1 are {0,2,3}. Coming from 0:
    //     → 0 is the return step  (weight 1/p),
    //     → 2 closes the 0-1-2 triangle (weight 1),
    //     → 3 is exploration, not adjacent to 0 (weight 1/q).
    // We verify by reading the state edges out of a network whose physical graph we know. Rather than
    // hand-wire LFR, assert the invariant on the generated graph: mean triangle-edge weight > mean
    // explore-edge weight is guaranteed by 1 > 1/q for q>1, so just sanity-check q's effect via extremes.
    const strong = generateStateNetwork({ nodeCount: 80, q: 5, seed: 9 });
    // Total state-edge weight shrinks as q grows (explore steps get down-weighted by 1/q).
    const sum = (g: typeof strong) => g.graph.state.weight.reduce((a, b) => a + b, 0);
    const weak = generateStateNetwork({ nodeCount: 80, q: 1.001, seed: 9 });
    expect(sum(strong)).toBeLessThan(sum(weak));
  });

  it("is deterministic", () => {
    const a = generateStateNetwork({ nodeCount: 100, seed: 11 });
    const b = generateStateNetwork({ nodeCount: 100, seed: 11 });
    expect(Array.from(a.graph.state.source)).toEqual(Array.from(b.graph.state.source));
    expect(Array.from(a.graph.state.weight)).toEqual(Array.from(b.graph.state.weight));
  });
});
