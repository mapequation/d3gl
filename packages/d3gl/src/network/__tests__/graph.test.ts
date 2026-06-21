import { describe, it, expect } from "vitest";
import { buildCSR, buildGraph, type CSR } from "../graph.js";

function neighborsOf(csr: CSR, node: number): number[] {
  return Array.from(
    csr.neighbors.slice(csr.offsets[node], csr.offsets[node + 1]),
  ).sort((a, b) => a - b);
}

describe("buildCSR", () => {
  it("builds symmetric (undirected) adjacency from a directed edge list", () => {
    // edges: 0->1, 1->2, 1->3 (a star centred on node 1, plus isolated structure)
    const source = [0, 1, 1];
    const target = [1, 2, 3];

    const csr = buildCSR(4, source, target);

    expect(Array.from(csr.degree)).toEqual([1, 3, 1, 1]);
    expect(Array.from(csr.offsets)).toEqual([0, 1, 4, 5, 6]);
    expect(neighborsOf(csr, 0)).toEqual([1]);
    expect(neighborsOf(csr, 1)).toEqual([0, 2, 3]);
    expect(neighborsOf(csr, 2)).toEqual([1]);
    expect(neighborsOf(csr, 3)).toEqual([1]);
  });

  it("handles a node with no edges (zero degree, empty slice)", () => {
    // node 2 is isolated
    const csr = buildCSR(3, [0], [1]);

    expect(Array.from(csr.degree)).toEqual([1, 1, 0]);
    expect(Array.from(csr.offsets)).toEqual([0, 1, 2, 2]);
    expect(neighborsOf(csr, 2)).toEqual([]);
  });
});

describe("buildGraph", () => {
  it("packs directed edges into typed-array SoA, defaults weight to 1, zeroes positions, exposes CSR", () => {
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: true });

    expect(g.source).toBeInstanceOf(Uint32Array);
    expect(Array.from(g.source)).toEqual([0, 1]);
    expect(Array.from(g.target)).toEqual([1, 2]);
    expect(g.weight).toBeInstanceOf(Float32Array);
    expect(Array.from(g.weight)).toEqual([1, 1]);
    expect(g.edgeCount).toBe(2);
    expect(g.positions).toBeInstanceOf(Float32Array);
    expect(g.positions.length).toBe(6);
    expect(Array.from(g.positions)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(g.directed).toBe(true);
    expect(Array.from(g.csr.degree)).toEqual([1, 2, 1]);
  });

  it("uses provided weights and defaults directed to false", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], weight: [2.5] });

    expect(Array.from(g.weight)).toEqual([2.5]);
    expect(g.directed).toBe(false);
  });

  it("computes per-node strength (weighted degree) from incident edges, defaulting weights to 1", () => {
    // star centred on node 1; weights 1/2/3 → hub strength 6, leaves 1/2/3.
    const weighted = buildGraph({ nodeCount: 4, source: [0, 1, 1], target: [1, 2, 3], weight: [1, 2, 3] });
    expect(weighted.strength).toBeInstanceOf(Float32Array);
    expect(Array.from(weighted.strength)).toEqual([1, 6, 2, 3]);

    // unweighted strength equals degree (every edge contributes 1 to both ends).
    const plain = buildGraph({ nodeCount: 4, source: [0, 1, 1], target: [1, 2, 3] });
    expect(Array.from(plain.strength)).toEqual(Array.from(plain.csr.degree));
  });

  it("keeps flow null unless supplied, copies provided flow, and validates its length", () => {
    expect(buildGraph({ nodeCount: 2, source: [0], target: [1] }).flow).toBeNull();

    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], nodeFlow: [0.5, 0.3, 0.2] });
    expect(g.flow).toBeInstanceOf(Float32Array);
    expect(Array.from(g.flow!)).toEqual([0.5, expect.closeTo(0.3), expect.closeTo(0.2)]); // float32 rounding

    expect(() => buildGraph({ nodeCount: 3, source: [], target: [], nodeFlow: [0.5, 0.5] })).toThrow(
      /nodeFlow length 2 !== nodeCount 3/,
    );
  });
});
