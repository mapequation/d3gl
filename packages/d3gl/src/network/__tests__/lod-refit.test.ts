/**
 * The LOD worker's side of the GPU layout's LOD refit (#377), node, pure: the coarsen-only tree is the one
 * the worker backend streams (same topology), the worker keeps its own copies of what a refit reads so the
 * topology can be transferred away, and a refit writes exactly what the worker backend's per-frame
 * `computeLODPositions` writes — into the buffer it is handed, allocating nothing else.
 *
 * Each relayed frame runs the worker backend's one per-frame step, `lodFrameStep` (#343): a structure
 * stream refits in place, a spatial stream rebuilds the Morton tree into a packed frame to transfer — and
 * skips a frame id it already built, so it stops once the layout has converged. The spatial source needs no
 * coarsening: the worker coarsens only for a seed plan.
 */
import { describe, expect, it, vi } from "vitest";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { buildHierarchy } from "../coarsen.js";
import {
  buildMortonLODTree,
  computeLODPositions,
  computeLODStyle,
  flattenHierarchyToTopology,
  lodTreeFromTopology,
  mortonRootBox,
  type LODTopology,
} from "../lod.js";
import { answerCoarsen, answerLODGeometry, coarsenForRefit, topologyTransferables } from "../lod-refit.js";
import { lodTreeFromSpatialFrame, makeSpatialLODStream, makeStructureLODStream, type LODStream } from "../lod-frame.js";
import { lodGeometryByteLength, type CoarsenMessage, type LODGeometryMessage, type WorkerToMain } from "../worker-protocol.js";
import { coarseSeedPlan, seedPlanTransferables } from "../gpu/seed-plan.js";

const coarsenings = vi.hoisted(() => ({ count: 0 }));
vi.mock("../coarsen.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../coarsen.js")>();
  return {
    ...mod,
    buildHierarchy: (...args: Parameters<typeof mod.buildHierarchy>) => {
      coarsenings.count++;
      return mod.buildHierarchy(...args);
    },
  };
});

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
    const { reply } = relayFrame(makeStructureLODStream(tree), g.positions.slice(), 1);
    expect(reply.geometry?.length).toBe(4 * tree.size); // [cx, cy, extent, clearZoom] (#426)
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
    const { reply } = relayFrame(makeStructureLODStream(tree), g.positions.slice(), 1);
    const geometry = reply.geometry;
    if (!geometry) throw new Error("no geometry");
    const n = tree.size;
    expect(geometry.subarray(0, n)).toEqual(reference.cx);
    expect(geometry.subarray(n, 2 * n)).toEqual(reference.cy);
    expect(geometry.subarray(2 * n, 3 * n)).toEqual(reference.extent);
  });

  it("refits into the buffer it is handed, frame after frame", () => {
    const g = clustered(1000, 9);
    const { topology, tree } = coarsenForRefit(g);
    const stream = makeStructureLODStream(tree);
    const handed = new Float32Array(lodGeometryByteLength(tree.size) / 4);
    const first = relayFrame(stream, g.positions.slice(), 1, handed).reply.geometry;
    expect(first?.buffer).toBe(handed.buffer);
    // The layout moves on: the next refit reuses the same buffer and follows the new positions.
    for (let i = 0; i < g.positions.length; i++) g.positions[i] = (g.positions[i] ?? 0) + 10;
    const second = relayFrame(stream, g.positions.slice(), 2, first).reply.geometry;
    expect(second?.buffer).toBe(handed.buffer);
    const reference = lodTreeFromTopology(topology);
    computeLODPositions(reference, g.positions);
    expect(second?.subarray(0, tree.size)).toEqual(reference.cx);
  });
});

describe("the coarsening worker's answer (#377, #353)", () => {
  const seed = { width: 800, height: 600 };
  const request = (g: NetworkGraph, lod: boolean, withSeed: boolean) => ({
    type: "coarsen" as const,
    nodeCount: g.nodeCount,
    source: g.source,
    target: g.target,
    weight: g.weight,
    lod,
    ...(withSeed ? { seed } : {}),
  });

  it("sends the seed plan first — the plan of the same hierarchy — then the LOD topology, each with its buffers", () => {
    const g = clustered(3000, 11);
    const sent: { message: WorkerToMain; transfer: Transferable[] }[] = [];
    const tree = answerCoarsen(request(g, true, true), (message, transfer) => sent.push({ message, transfer }));
    expect(sent.map((s) => s.message.type)).toEqual(["seed-plan", "lod-topology"]);
    const first = sent[0]?.message;
    if (first?.type !== "seed-plan" || !first.plan) throw new Error("no plan");
    const expected = coarseSeedPlan(g, buildHierarchy(g), seed);
    expect(first.plan.levels.map((l) => l.count)).toEqual(expected?.levels.map((l) => l.count));
    expect(sent[0]?.transfer).toEqual(seedPlanTransferables(first.plan));
    const second = sent[1]?.message;
    if (second?.type !== "lod-topology") throw new Error("no topology");
    expect(sent[1]?.transfer).toEqual(topologyTransferables(second.topology));
    if (tree?.kind !== "structure") throw new Error("no structure stream");
    expect(tree.tree.size).toBe(second.topology.size);
  });

  it("with LOD off, sends only the plan and keeps no tree; without a seed request, only the topology", () => {
    const g = clustered(2000, 12);
    const seedOnly: string[] = [];
    expect(answerCoarsen(request(g, false, true), (m) => seedOnly.push(m.type))).toBeNull();
    expect(seedOnly).toEqual(["seed-plan"]);
    const lodOnly: string[] = [];
    expect(answerCoarsen(request(g, true, false), (m) => lodOnly.push(m.type))).not.toBeNull();
    expect(lodOnly).toEqual(["lod-topology"]);
  });

  it("sends a null plan for a graph that cannot be coarsened", () => {
    const g = buildGraph({ nodeCount: 20, source: [], target: [] });
    const sent: WorkerToMain[] = [];
    answerCoarsen(request(g, false, true), (m) => sent.push(m));
    expect(sent).toEqual([{ type: "seed-plan", plan: null }]);
  });
});

/** The worker's reply to one relayed frame, with what it transferred. */
function relayFrame(stream: LODStream, positions: Float32Array, frame: number, geometry?: Float32Array): { reply: LODGeometryMessage; transfer: Transferable[] } {
  let out: { reply: LODGeometryMessage; transfer: Transferable[] } | null = null;
  answerLODGeometry(stream, { type: "lod-geometry", positions, frame, ...(geometry ? { geometry } : {}) }, (message, transfer) => {
    if (message.type !== "lod-geometry") throw new Error(`replied ${message.type}`);
    out = { reply: message, transfer };
  });
  if (!out) throw new Error("no reply");
  return out;
}

describe("the relay's per-frame step: lodFrameStep in the LOD worker (#343 × #377)", () => {
  const n = 3000;
  const radii = new Float32Array(n).fill(2);
  const weight = Float32Array.from({ length: n }, (_, i) => 1 + (i % 5));
  const colors = Uint8Array.from({ length: 4 * n }, (_, i) => (i * 37) % 256);
  const request = (g: NetworkGraph, withSeed: boolean): CoarsenMessage => ({
    type: "coarsen",
    nodeCount: g.nodeCount,
    source: g.source,
    target: g.target,
    weight: g.weight,
    lod: true,
    lodSource: "spatial",
    lodStyle: { radii, weight, colors },
    lodStyleVersion: 4,
    ...(withSeed ? { seed: { width: 800, height: 600 } } : {}),
  });

  it("a structure stream refits into the buffer it is handed, as computeLODPositions does, with one box scratch for every frame", () => {
    const g = clustered(4000, 21);
    const { topology, tree } = coarsenForRefit(g);
    const stream = makeStructureLODStream(tree);
    const reference = lodTreeFromTopology(topology);
    let geometry: Float32Array | undefined;
    let scratch: Float32Array | null = null;
    for (let f = 1; f <= 3; f++) {
      for (let i = 0; i < g.positions.length; i++) g.positions[i] = (g.positions[i] ?? 0) * 1.01 + f;
      const handed = geometry;
      const { reply, transfer } = relayFrame(stream, g.positions.slice(), f, handed);
      if (!reply.geometry) throw new Error("no geometry");
      if (handed) expect(reply.geometry.buffer).toBe(handed.buffer); // refit in place: nothing allocated
      expect(transfer).toEqual([reply.positions.buffer, reply.geometry.buffer]);
      expect(reply.lodFrame).toBeUndefined();
      computeLODPositions(reference, g.positions);
      const size = tree.size;
      expect(reply.geometry.subarray(0, size)).toEqual(reference.cx);
      expect(reply.geometry.subarray(size, 2 * size)).toEqual(reference.cy);
      expect(reply.geometry.subarray(2 * size, 3 * size)).toEqual(reference.extent);
      if (scratch) expect(stream.bounds.bounds).toBe(scratch); // the exact boxes' scratch is reused (#343)
      scratch = stream.bounds.bounds;
      geometry = reply.geometry;
    }
  });

  it("a spatial stream rebuilds the tree for each new frame, equal to a main-thread build, and hands the positions back", () => {
    const g = clustered(n, 22);
    const stream = makeSpatialLODStream(n, { radii, weight, colors }, 4);
    const positions = g.positions.slice();
    const { reply, transfer } = relayFrame(stream, positions, 7);
    const frame = reply.lodFrame;
    if (!frame) throw new Error("no spatial frame");
    expect(reply.positions).toBe(positions);
    expect(reply.geometry).toBeUndefined();
    expect(transfer).toEqual([positions.buffer, frame.buffer]);
    expect(frame.header.frame).toBe(7);
    expect(frame.header.styleVersion).toBe(4);
    const got = lodTreeFromSpatialFrame(frame);
    const want = buildMortonLODTree(g.positions, n, { box: mortonRootBox(g.positions, n) });
    computeLODPositions(want, g.positions);
    computeLODStyle(want, radii, weight, undefined, colors);
    expect(got.size).toBe(want.size);
    for (const k of ["childOffset", "children", "leafOrder", "cx", "cy", "extent", "count", "radius", "weight", "color"] as const) {
      expect(Array.from(got[k] ?? []), k).toEqual(Array.from(want[k] ?? []));
    }
  });

  it("stops at convergence: a frame id it already built brings its positions back and no tree", () => {
    const g = clustered(n, 23);
    const stream = makeSpatialLODStream(n, { radii, weight });
    expect(relayFrame(stream, g.positions.slice(), 40).reply.lodFrame).toBeDefined();
    const again = relayFrame(stream, g.positions.slice(), 40);
    expect(again.reply.lodFrame).toBeUndefined();
    expect(again.transfer).toEqual([again.reply.positions.buffer]);
    // A drag's reheat moves the layout on: new ticks, a new tree.
    expect(relayFrame(stream, g.positions.map((v) => v + 1), 41).reply.lodFrame).toBeDefined();
  });

  it("the coarsen answer for the spatial source: no coarsening and no topology without a seed; the plan alone with one", () => {
    const g = clustered(2000, 24);
    const sent: WorkerToMain[] = [];
    coarsenings.count = 0;
    const stream = answerCoarsen(request(g, false), (m) => sent.push(m));
    expect(coarsenings.count).toBe(0);
    expect(sent).toEqual([]);
    if (stream?.kind !== "spatial") throw new Error("no spatial stream");
    expect(stream.leafCount).toBe(2000);
    expect(stream.styleVersion).toBe(4);
    expect(stream.style?.radii).toBe(radii);

    const seeded: string[] = [];
    const withSeed = answerCoarsen(request(g, true), (m) => seeded.push(m.type));
    expect(coarsenings.count).toBe(1); // for the seed's plan only
    expect(seeded).toEqual(["seed-plan"]);
    expect(withSeed?.kind).toBe("spatial");
  });
});
