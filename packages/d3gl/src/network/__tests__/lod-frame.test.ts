import { describe, it, expect } from "vitest";
import { buildMortonLODTree, computeLODCrowding, computeLODPositions, computeLODStyle, crowdingHorizon, mortonRootBox, lodTreeFromTopology, buildLODTree } from "../lod.js";
import { MAX_OUTSTANDING, lodFrameStep, lodTreeFromSpatialFrame, makeSpatialLODStream, makeStructureLODStream, recycleSpatialFrame, setStreamSizing, setStreamStyle, spatialFrameByteLength, type LeafStyle, type SpatialLODFrame } from "../lod-frame.js";
import { lodStyleFields, lodStyleMessage } from "../worker-protocol.js";
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

  it("bounds the frames in flight: a stalled main thread pauses the rebuilds, a returned buffer resumes them", () => {
    const pos = cloud(n, 5);
    const stream = makeSpatialLODStream(n, { radii, weight });
    const out: SpatialLODFrame[] = [];
    const buffers = new Set<ArrayBuffer>();
    // The main thread hands nothing back for 20 frames (a long task, a hidden tab).
    for (let f = 1; f <= 20; f++) {
      const frame = lodFrameStep(stream, pos.map((v) => v + f), f);
      if (frame) { out.push(frame); buffers.add(frame.buffer); }
    }
    expect(out.length).toBe(MAX_OUTSTANDING);
    expect(stream.pending).toBe(true);
    // One buffer back: the skipped frame is due, and builds the latest positions into the returned buffer.
    const first = out[0];
    if (!first) throw new Error("no frame");
    expect(recycleSpatialFrame(stream, first.buffer)).toBe(true);
    const resumed = lodFrameStep(stream, pos.map((v) => v + 20), 20);
    expect(resumed?.header.frame).toBe(20);
    expect(resumed?.buffer).toBe(first.buffer);
    expect(stream.pending).toBe(false);
    // Nothing more is due until another frame is skipped.
    const second = out[1];
    if (!second) throw new Error("no frame");
    expect(recycleSpatialFrame(stream, second.buffer)).toBe(false);
    // Over the whole stall, no more than MAX_OUTSTANDING distinct buffers were ever allocated.
    if (resumed) buffers.add(resumed.buffer);
    expect(buffers.size).toBeLessThanOrEqual(MAX_OUTSTANDING);
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
    expect(worker.clearZoom.every((z) => z === Infinity)).toBe(true); // no style: no crowding (#426)
  });
});

describe("lodFrameStep carries the crowding on the settled frame only (#426)", () => {
  const n = 2000;
  const radii = Float32Array.from({ length: n }, (_, i) => 1 + (i % 6));
  const weight = new Float32Array(n).fill(1);

  it("a spatial frame's clear zoom equals a main-thread crowding pass over the same tree", () => {
    const pos = cloud(n, 11);
    for (const crowding of [{ screenSized: true }, { screenSized: false }, { screenSized: true, expandPx: 300 }]) {
      const stream = makeSpatialLODStream(n, { radii, weight, crowding }, 1);
      // A streamed frame carries none: the footprint rule alone while the layout runs.
      const streamed = lodFrameStep(stream, pos, 1);
      if (!streamed) throw new Error("no frame");
      expect(streamed.header.crowding).toBe(false);
      expect(lodTreeFromSpatialFrame(streamed).clearZoom.every((z) => z === Infinity)).toBe(true);
      // The settled frame for the same positions is built again, with the crowding.
      const frame = lodFrameStep(stream, pos, 1, true);
      if (!frame) throw new Error("no settled frame");
      expect(frame.header.crowding).toBe(true);
      expect(lodFrameStep(stream, pos, 1, true), "a settled frame is built once").toBeNull();
      const got = lodTreeFromSpatialFrame(frame);
      const want = buildMortonLODTree(pos, n, { box: mortonRootBox(pos, n) });
      computeLODPositions(want, pos);
      computeLODStyle(want, radii, weight);
      computeLODCrowding(want, { screenSized: crowding.screenSized, expandPx: crowdingHorizon(want, crowding.expandPx) });
      expect(Array.from(got.clearZoom)).toEqual(Array.from(want.clearZoom));
      expect(got.clearZoom.subarray(n).some((z) => z < Infinity)).toBe(true); // not vacuous
    }
    // Without crowding inputs, a reused buffer is reset to "none" rather than keeping the last frame's.
    const stream = makeSpatialLODStream(n, { radii, weight, crowding: { screenSized: true } }, 1);
    const a = lodFrameStep(stream, pos, 1, true);
    if (!a) throw new Error("no frame");
    recycleSpatialFrame(stream, a.buffer);
    setStreamStyle(stream, { radii, weight }, 2);
    const b = lodFrameStep(stream, pos, 2, true);
    expect(b?.buffer).toBe(a.buffer);
    if (!b) throw new Error("no frame");
    expect(lodTreeFromSpatialFrame(b).clearZoom.every((z) => z === Infinity)).toBe(true);
  });

  it("a structure stream refits its crowding in place from the style it was given, on the settled frame", () => {
    const src: number[] = [];
    const tgt: number[] = [];
    for (let i = 1; i < n; i++) { src.push(i); tgt.push(i >> 1); }
    const g = buildGraph({ nodeCount: n, source: src, target: tgt });
    const tree = buildLODTree(g);
    const worker = lodTreeFromTopology(tree);
    const stream = makeStructureLODStream(worker, { radii, crowding: { screenSized: true } });
    const pos = cloud(n, 12);
    expect(lodFrameStep(stream, pos, 1, true)).toBeNull();
    computeLODPositions(tree, pos);
    computeLODStyle(tree, radii, weight);
    computeLODCrowding(tree, { screenSized: true, expandPx: crowdingHorizon(tree) });
    expect(Array.from(worker.clearZoom)).toEqual(Array.from(tree.clearZoom));
    // A new style reaches the next frame's crowding.
    const bigger = radii.map((r) => r * 3);
    setStreamSizing(stream, { radii: bigger, crowding: { screenSized: true } });
    lodFrameStep(stream, pos, 2, true);
    computeLODStyle(tree, bigger, weight);
    computeLODCrowding(tree, { screenSized: true, expandPx: crowdingHorizon(tree) });
    expect(Array.from(worker.clearZoom)).toEqual(Array.from(tree.clearZoom));
    expect(worker.clearZoom.some((z) => z < Infinity)).toBe(true); // not vacuous
    // A streamed frame (a reheat) drops it again: the footprint rule alone while the layout runs.
    lodFrameStep(stream, pos, 3);
    expect(worker.clearZoom.every((z) => z === Infinity)).toBe(true);
  });

  it("the worker gets the whole leaf style for a spatial stream, only the radii and sizing for a structure stream", () => {
    // A structure stream reads the radii and the size mode (its crowding); the weight, border and colours a
    // spatial stream aggregates would be cloned to the worker and kept there for nothing.
    const style: LeafStyle = { radii, weight, border: new Float32Array(n), colors: new Uint8Array(4 * n), crowding: { screenSized: true, expandPx: 60 } };
    expect(lodStyleMessage("spatial", style, 3)).toEqual({ type: "lod-style", style, version: 3 });
    const sizing = lodStyleMessage("structure", style, 3);
    expect(sizing).toEqual({ type: "lod-sizing", sizing: { radii, crowding: style.crowding } });
    if (sizing.type === "lod-sizing") {
      expect(Object.keys(sizing.sizing).sort()).toEqual(["crowding", "radii"]);
      expect(sizing.sizing.radii).toBe(radii); // the same array, not a copy
    }
    // The start message the same way.
    expect(lodStyleFields("spatial", style, 3)).toEqual({ lodStyle: style, lodStyleVersion: 3 });
    const start = lodStyleFields("structure", style, 3);
    expect(Object.keys(start)).toEqual(["lodSizing"]);
    expect(Object.keys(start.lodSizing ?? {}).sort()).toEqual(["crowding", "radii"]);
    expect(lodStyleFields("structure", undefined, undefined)).toEqual({});
  });
});
