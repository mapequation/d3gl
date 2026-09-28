/**
 * The LOD worker's side of the GPU layout's LOD refit (#377), node, pure: the coarsen-only tree is the one
 * the worker backend streams (same topology), the worker keeps its own copies of what a refit reads so the
 * topology can be transferred away, and a refit writes exactly what the worker backend's per-frame
 * `computeLODPositions` writes — into the buffer it is handed, allocating nothing else.
 */
import { describe, expect, it } from "vitest";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildHierarchy } from "../coarsen.js";
import { computeLODPositions, flattenHierarchyToTopology, lodTreeFromTopology, type LODTopology } from "../lod.js";
import { coarsenForRefit, refitGeometry, topologyTransferables } from "../lod-refit.js";
import { lodGeometryByteLength } from "../worker-protocol.js";

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A clustered graph with random positions: it coarsens over several levels. */
function clustered(n: number, seed: number): NetworkGraph {
  const rng = makePrng(seed);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i);
    target.push((i + 1) % n);
    source.push(i);
    target.push(Math.floor(rng() * n));
  }
  const g = buildGraph({ nodeCount: n, source, target });
  for (let i = 0; i < 2 * n; i++) g.positions[i] = (rng() - 0.5) * 1000;
  return g;
}

/** Every typed array of a topology, by field name. */
function typedArrays(topo: LODTopology): [string, ArrayBufferView][] {
  return Object.entries(topo).filter((e): e is [string, ArrayBufferView] => ArrayBuffer.isView(e[1]));
}

describe("coarsen-only LOD tree (#377)", () => {
  it("is the tree the worker backend streams: the same topology, super-edges included", () => {
    const g = clustered(3000, 7);
    const coarsen = { minNodes: 6 };
    const { topology } = coarsenForRefit(g, coarsen);
    const expected = flattenHierarchyToTopology(buildHierarchy(g, coarsen), g.nodeCount, g);
    expect(topology.levelCount).toBeGreaterThan(3);
    expect(topology.superEdgeOffset).toBeDefined();
    expect(topology).toEqual(expected);
  });

  it("keeps its own copies of what a refit reads, so the topology can be transferred away", () => {
    const g = clustered(2000, 3);
    const { topology, tree } = coarsenForRefit(g);
    const buffers = topologyTransferables(topology);
    // Transfer every buffer (as postMessage does): the topology's arrays detach, the refit tree's do not.
    structuredClone(topology, { transfer: buffers });
    expect(topology.children.length).toBe(0);
    expect(tree.children.length).toBeGreaterThan(0);
    const geometry = refitGeometry(tree, g.positions, new ArrayBuffer(lodGeometryByteLength(tree.size)));
    expect(geometry.length).toBe(3 * tree.size);
  });

  it("lists each buffer behind the topology once, covering every typed array", () => {
    const g = clustered(1500, 11);
    const { topology } = coarsenForRefit(g);
    const buffers = topologyTransferables(topology);
    expect(new Set(buffers).size).toBe(buffers.length);
    for (const [name, view] of typedArrays(topology)) {
      expect(buffers.includes(view.buffer as ArrayBuffer), `${name} not transferred`).toBe(true);
    }
  });
});

describe("LOD geometry refit (#377)", () => {
  it("writes [cx, cy, extent] exactly as the worker backend's per-frame computeLODPositions", () => {
    const g = clustered(4000, 5);
    const { topology, tree } = coarsenForRefit(g);
    const reference = lodTreeFromTopology(topology);
    computeLODPositions(reference, g.positions);
    const geometry = refitGeometry(tree, g.positions, new ArrayBuffer(lodGeometryByteLength(tree.size)));
    const n = tree.size;
    expect(geometry.subarray(0, n)).toEqual(reference.cx);
    expect(geometry.subarray(n, 2 * n)).toEqual(reference.cy);
    expect(geometry.subarray(2 * n, 3 * n)).toEqual(reference.extent);
  });

  it("refits into the buffer it is handed, frame after frame", () => {
    const g = clustered(1000, 9);
    const { topology, tree } = coarsenForRefit(g);
    const buffer = new ArrayBuffer(lodGeometryByteLength(tree.size));
    const first = refitGeometry(tree, g.positions, buffer);
    expect(first.buffer).toBe(buffer);
    // The layout moves on: the next refit reuses the same buffer and follows the new positions.
    for (let i = 0; i < g.positions.length; i++) g.positions[i] = (g.positions[i] ?? 0) + 10;
    const second = refitGeometry(tree, g.positions, buffer);
    expect(second.buffer).toBe(buffer);
    const reference = lodTreeFromTopology(topology);
    computeLODPositions(reference, g.positions);
    expect(second.subarray(0, tree.size)).toEqual(reference.cx);
  });
});
