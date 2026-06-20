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
});
