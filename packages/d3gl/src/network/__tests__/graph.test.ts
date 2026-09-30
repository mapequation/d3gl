import { describe, it, expect } from "vitest";
import { buildCSR, buildGraph, reciprocalEdges, type CSR } from "../graph.js";

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

  it("scatters per-edge weights parallel to the neighbors, one per entry on both endpoints", () => {
    // Edge e has weight 10 + e, so each CSR entry names the edge it came from.
    const source = [0, 1, 1, 3];
    const target = [1, 2, 3, 0];
    const csr = buildCSR(4, source, target, [10, 11, 12, 13]);
    const weights = csr.weights;
    expect(weights).toBeInstanceOf(Float32Array);
    expect(weights?.length).toBe(csr.neighbors.length);
    for (let i = 0; i < 4; i++) {
      for (let p = csr.offsets[i] ?? 0; p < (csr.offsets[i + 1] ?? 0); p++) {
        const j = csr.neighbors[p];
        const e = (weights?.[p] ?? 0) - 10;
        // The entry's edge joins i and j, in either direction.
        const ends = [source[e], target[e]].sort();
        expect(ends).toEqual([i, j].sort());
      }
    }
  });

  it("builds no weights array without edge weights", () => {
    expect(buildCSR(2, [0], [1]).weights).toBeUndefined();
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

describe("reciprocalEdges", () => {
  /** The lookup it replaces: a Map keyed by s·n + t, where the last parallel edge wins. */
  function viaMap(n: number, source: number[], target: number[]): number[] {
    const byPair = new Map<number, number>();
    source.forEach((s, e) => byPair.set(s * n + (target[e] ?? 0), e));
    return source.map((s, e) => byPair.get((target[e] ?? 0) * n + s) ?? -1);
  }

  it("finds each edge's t→s edge, the last of parallel ones, a self-loop's own last copy, or −1", () => {
    // 0→1, 1→0, 1→0 (parallel: the later one answers), 0→2 (no 2→0), 3→3 twice, 2→1, 1→2.
    const source = [0, 1, 1, 0, 3, 3, 2, 1];
    const target = [1, 0, 0, 2, 3, 3, 1, 2];
    const g = buildGraph({ nodeCount: 4, source, target, directed: true });
    expect(Array.from(reciprocalEdges(g))).toEqual([2, 0, 0, -1, 5, 5, 7, 6]);
    expect(Array.from(reciprocalEdges(g))).toEqual(viaMap(4, source, target));
  });

  it("agrees with the Map on random multigraphs with hubs, self-loops and isolated nodes", () => {
    let seed = 7;
    const rand = (k: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % k;
    };
    for (const [n, m] of [[1, 3], [5, 40], [50, 300], [400, 5000]] as const) {
      const source: number[] = [];
      const target: number[] = [];
      for (let e = 0; e < m; e++) {
        // A third of the edges touch node 0 (a hub), some repeat an earlier edge reversed or as is.
        const s = rand(3) === 0 ? 0 : rand(n);
        const t = rand(n);
        source.push(s);
        target.push(t);
        if (rand(4) === 0) {
          source.push(rand(2) ? t : s);
          target.push(rand(2) ? s : t);
        }
      }
      const g = buildGraph({ nodeCount: n, source, target, directed: true });
      expect(Array.from(reciprocalEdges(g))).toEqual(viaMap(n, source, target));
    }
  });

  it("handles a graph with no edges", () => {
    expect(reciprocalEdges(buildGraph({ nodeCount: 3, source: [], target: [], directed: true })).length).toBe(0);
  });
});
