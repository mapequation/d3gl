import { describe, it, expect } from "vitest";
import { buildMortonLODTree, computeLODPositions, computeLODStyle, mortonRootBox, lodTreeFromTopology, buildLODTree } from "../lod.js";
import { lodFrameStep, lodTreeFromSpatialFrame, makeSpatialLODStream, makeStructureLODStream, recycleSpatialFrame, spatialFrameByteLength } from "../lod-frame.js";
import { buildGraph } from "../graph.js";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}
function cloud(n: number, seed: number): Float32Array {
  const r = rng(seed);
  const pos = new Float32Array(2 * n);
  for (let i = 0; i < 2 * n; i++) pos[i] = (r() - 0.5) * 900 + (i % 7) * 30;
  return pos;
}

describe("lodFrameStep (#343): the one per-frame LOD step", () => {
  const n = 3000;
  const radii = new Float32Array(n).fill(2);
  const weight = Float32Array.from({ length: n }, (_, i) => 1 + (i % 5));
  const colors = Uint8Array.from({ length: 4 * n }, (_, i) => (i * 37) % 256);

  it("rebuilds a spatial tree into one packed frame equal to a main-thread build", () => {
    const pos = cloud(n, 1);
    const stream = makeSpatialLODStream(n, { radii, weight, colors }, 7);
    const frame = lodFrameStep(stream, pos, 1);
    expect(frame).not.toBeNull();
    if (!frame) return;
    expect(frame.header.styleVersion).toBe(7);
    expect(frame.header.frame).toBe(1);
    expect(frame.buffer.byteLength).toBeGreaterThanOrEqual(spatialFrameByteLength(frame.header));
    const got = lodTreeFromSpatialFrame(frame);
    const want = buildMortonLODTree(pos, n, { box: mortonRootBox(pos, n) });
    computeLODPositions(want, pos);
    computeLODStyle(want, radii, weight, undefined, colors);
    expect(got.size).toBe(want.size);
    expect(got.leafBranching).toBe(want.leafBranching);
    for (const k of ["levelOffset", "childOffset", "children", "parent", "leafOrder", "leafStart", "leafEnd", "cx", "cy", "extent", "count", "radius", "weight", "color"] as const) {
      expect(Array.from(got[k]), k).toEqual(Array.from(want[k]));
    }
    expect(Array.from(got.morton!.code)).toEqual(Array.from(want.morton!.code));
    expect(got.morton!.box).toEqual(want.morton!.box);
  });

  it("skips a frame it already built (converged), and keeps the root box while the layout fits it", () => {
    const pos = cloud(n, 2);
    const stream = makeSpatialLODStream(n, { radii, weight });
    const a = lodFrameStep(stream, pos, 5);
    expect(a).not.toBeNull();
    expect(lodFrameStep(stream, pos, 5)).toBeNull();
    const moved = pos.map((v) => v * 1.01);
    const b = lodFrameStep(stream, moved, 6);
    expect(b?.header.box).toBe(a?.header.box);
  });

  it("reuses a recycled buffer instead of allocating one", () => {
    const pos = cloud(n, 3);
    const stream = makeSpatialLODStream(n, { radii, weight });
    const a = lodFrameStep(stream, pos, 1);
    if (!a) throw new Error("no frame");
    recycleSpatialFrame(stream, a.buffer);
    const b = lodFrameStep(stream, pos.map((v) => v + 1), 2);
    expect(b?.buffer).toBe(a.buffer);
    // colours stay zero without a colour style, even in a reused buffer that held some
    const withColors = makeSpatialLODStream(n, { radii, weight, colors });
    const c = lodFrameStep(withColors, pos, 1);
    if (!c) throw new Error("no frame");
    recycleSpatialFrame(stream, c.buffer);
    const d = lodFrameStep(stream, pos, 3);
    if (!d) throw new Error("no frame");
    expect(lodTreeFromSpatialFrame(d).color.every((v) => v === 0)).toBe(true);
  });

  it("refits a structure stream in place and posts nothing", () => {
    const src: number[] = [];
    const tgt: number[] = [];
    for (let i = 1; i < 400; i++) { src.push(i); tgt.push(i >> 1); }
    const g = buildGraph({ nodeCount: 400, source: src, target: tgt });
    const tree = buildLODTree(g);
    const worker = lodTreeFromTopology(tree);
    const stream = makeStructureLODStream(worker);
    const pos = cloud(400, 4);
    expect(lodFrameStep(stream, pos, 1)).toBeNull();
    computeLODPositions(tree, pos);
    expect(Array.from(worker.cx)).toEqual(Array.from(tree.cx));
    expect(Array.from(worker.extent)).toEqual(Array.from(tree.extent));
  });
});
