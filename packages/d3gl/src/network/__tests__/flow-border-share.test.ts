import { describe, it, expect } from "vitest";
import { buildGraph } from "../graph.js";
import { resolveFlowBorder, nodeCircles, frontierCircles, flowBorderInnerRadii, shareBorderWidth, moduleBorderValues, applyModuleBorder } from "../glyphs.js";
import { buildModuleLODTree } from "../modules.js";
import { buildMortonLODTree, computeLODPositions, computeLODStyle, mortonRootBox } from "../lod.js";
import { lodFrameStep, lodTreeFromSpatialFrame, makeSpatialLODStream, spatialFrameByteLength } from "../lod-frame.js";

/**
 * #510: the share mode of the flow border. The border covers the share of a node's flow that leaves it
 * (exit flow e over flow f) as a share of its area: inner radius `r · √(1 − e/f)`, `e/f` clamped to [0, 1].
 */

const SQRT_HALF = Math.SQRT1_2;

/** Two modules of two leaves each, under the root: leaves 0..3, modules 4 = {0, 1} and 5 = {2, 3}, root 6. */
function twoModules() {
  return buildModuleLODTree(4, [
    { id: 0, path: [1, 1] },
    { id: 1, path: [1, 2] },
    { id: 2, path: [2, 1] },
    { id: 3, path: [2, 2] },
  ]);
}

describe("shareBorderWidth", () => {
  it("covers the share e/f of the area: e = f all of it, e = f/2 half, e = 0 none", () => {
    expect(shareBorderWidth(10, 0.4, 0.4)).toBe(10);
    expect(shareBorderWidth(10, 0.2, 0.4)).toBeCloseTo(10 - 10 * SQRT_HALF, 6);
    expect(shareBorderWidth(10, 0, 0.4)).toBe(0);
    // The inner disc keeps the rest of the area: π(r − w)² / πr² = 1 − e/f.
    const w = shareBorderWidth(10, 0.1, 0.4);
    expect(((10 - w) / 10) ** 2).toBeCloseTo(0.75, 6);
  });

  it("clamps the share to [0, 1]", () => {
    expect(shareBorderWidth(10, 0.8, 0.4)).toBe(10);
    expect(shareBorderWidth(10, -0.1, 0.4)).toBe(0);
  });

  it("draws no border (NaN) for f = 0, a negative f or a missing value", () => {
    expect(shareBorderWidth(10, 0.1, 0)).toBeNaN();
    expect(shareBorderWidth(10, 0.1, -1)).toBeNaN();
    expect(shareBorderWidth(10, NaN, 0.4)).toBeNaN();
    expect(shareBorderWidth(10, 0.1, NaN)).toBeNaN();
  });
});

describe("resolveFlowBorder, share mode", () => {
  it("has no scale and takes the graph's node flow by reference", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], nodeFlow: [0.6, 0.4] });
    const b = resolveFlowBorder(g, { share: true, flow: new Float32Array([0.6, 0.2]), color: "#f00" }, "#000");
    expect(b.scale).toBeNull();
    expect(b.flow).toBe(g.flow);
  });

  it("gives every node a missing flow when the graph has none", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    const b = resolveFlowBorder(g, { share: true, flow: new Float32Array([0.6, 0.2]) }, "#000");
    expect(Array.from(b.flow!)).toEqual([NaN, NaN]);
  });

  it("leaves the absolute mode without a flow", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], nodeFlow: [0.6, 0.4] });
    const b = resolveFlowBorder(g, { flow: "flow", scale: (v) => v }, "#000");
    expect(b.flow).toBeUndefined();
    expect(typeof b.scale).toBe("function");
  });
});

describe("nodeCircles (LOD off), share mode", () => {
  it("draws each node's border as its exit-flow share of the area, whatever its radius", () => {
    const g = buildGraph({ nodeCount: 5, source: [0], target: [1], nodeFlow: [0.4, 0.4, 0.4, 0, 0.4] });
    const border = resolveFlowBorder(g, { share: true, flow: new Float32Array([0.4, 0.2, 0, 0.1, NaN]), color: "#f00" }, "#000");
    for (const r of [3, 10, 40]) {
      const data = nodeCircles(g, { radii: new Float32Array(5).fill(r), fill: "#00f", border });
      const b = Array.from(data.borders!);
      expect(b[0]).toBe(1); // e = f: the whole node
      expect(b[1]).toBeCloseTo(1 - SQRT_HALF, 6); // e = f/2: half the area
      expect(b[2]).toBe(0); // e = 0
      expect(b[3]).toBe(0); // f = 0: none
      expect(b[4]).toBe(0); // missing exit flow: none
    }
  });

  it("inner radii for the Canvas/SVG path keep r · √(1 − e/f)", () => {
    const inner = flowBorderInnerRadii(new Float32Array([10, 10, 10, 10]), new Float32Array([0.4, 0.2, 0, 0.1]), null, new Float32Array([0.4, 0.4, 0.4, 0]));
    expect(inner[0]).toBe(0);
    expect(inner[1]).toBeCloseTo(10 * SQRT_HALF, 5);
    expect(inner[2]).toBe(10);
    expect(inner[3]).toBe(10); // f = 0: no border
  });
});

describe("LOD aggregates, share mode", () => {
  it("sums the leaf flow up the tree beside the exit flow, and holds none in the absolute mode", () => {
    const tree = twoModules();
    const ones = new Float32Array([1, 1, 1, 1]);
    computeLODStyle(tree, ones, ones, new Float32Array([1, 2, 3, 4]), undefined, undefined, undefined, new Float32Array([2, 2, 4, 4]));
    expect(Array.from(tree.borderFlow!)).toEqual([2, 2, 4, 4, 4, 8, 12]);
    computeLODStyle(tree, ones, ones, new Float32Array([1, 2, 3, 4]));
    expect(tree.borderFlow).toBeUndefined();
  });

  it("draws an aggregate's border as its summed exit flow over its summed flow, on its drawn (capped) radius", () => {
    const tree = twoModules();
    computeLODPositions(tree, new Float32Array([0, 0, 1, 0, 2, 0, 3, 0]));
    const radii = new Float32Array([10, 10, 10, 10]);
    // Module {0, 1}: e = f for both ⇒ all of it. Module {2, 3}: Σe = 0.3, Σf = 0.6 ⇒ half. Root: 0.7/1.0.
    const exit = new Float32Array([0.2, 0.2, 0.1, 0.2]);
    const flow = new Float32Array([0.2, 0.2, 0.3, 0.3]);
    computeLODStyle(tree, radii, radii, exit, undefined, undefined, undefined, flow);
    const border = { metric: exit, scale: null, flow, color: [255, 0, 0, 255] as [number, number, number, number], colorCss: "#f00" };
    for (const maxAggregateRadius of [Infinity, 4]) {
      const fc = frontierCircles(tree, Uint32Array.from([4, 5, 6, 2]), { nodeFill: "#00f", aggregateFill: "#999", border, maxAggregateRadius });
      const b = Array.from(fc.borders!);
      expect(b[0]).toBe(1);
      expect(b[1]).toBeCloseTo(1 - SQRT_HALF, 5);
      expect(b[2]).toBeCloseTo(1 - Math.sqrt(1 - 0.7), 5);
      expect(b[3]).toBeCloseTo(1 - Math.sqrt(1 - 1 / 3), 5); // leaf 2: 0.1 / 0.3
    }
  });

  it("takes a module's own exit flow (moduleFlow) over its summed flow", () => {
    const g = buildGraph({ nodeCount: 4, source: [0], target: [1], nodeFlow: [0.2, 0.2, 0.3, 0.3] });
    const tree = twoModules();
    computeLODPositions(tree, new Float32Array([0, 0, 1, 0, 2, 0, 3, 0]));
    // Module flow only (an .ftree): module 1 exits 0.1 of its 0.4, module 2 all of its 0.6; the root has none.
    const border = resolveFlowBorder(g, { share: true, color: "#f00", moduleFlow: (path) => (path.length === 1 ? [0.1, 0.6][path[0]! - 1] : undefined) }, "#000");
    const radii = new Float32Array([10, 10, 10, 10]);
    computeLODStyle(tree, radii, radii, border.metric, undefined, undefined, undefined, border.flow);
    applyModuleBorder(tree, moduleBorderValues(tree, border)!);
    const fc = frontierCircles(tree, Uint32Array.from([4, 5, 6, 0]), { nodeFill: "#00f", aggregateFill: "#999", border });
    const b = Array.from(fc.borders!);
    expect(b[0]).toBeCloseTo(1 - Math.sqrt(1 - 0.25), 5);
    expect(b[1]).toBe(1);
    expect(b[2]).toBe(0); // the root: no exit-flow value, no border
    expect(b[3]).toBe(0); // a leaf: no exit-flow value, no border
  });

  it("packs the summed flow into a worker's spatial frame, equal to a main-thread build", () => {
    const n = 2000;
    const pos = Float32Array.from({ length: 2 * n }, (_, i) => ((i * 7919) % 1000) / 10);
    const radii = new Float32Array(n).fill(2);
    const weight = new Float32Array(n).fill(1);
    const border = Float32Array.from({ length: n }, (_, i) => (i % 3) / n);
    const borderFlow = Float32Array.from({ length: n }, (_, i) => (1 + (i % 5)) / n);
    const frame = lodFrameStep(makeSpatialLODStream(n, { radii, weight, border, borderFlow }, 1), pos, 1);
    expect(frame?.header.borderFlow).toBe(true);
    if (!frame) return;
    expect(frame.buffer.byteLength).toBeGreaterThanOrEqual(spatialFrameByteLength(frame.header, true));
    const got = lodTreeFromSpatialFrame(frame);
    const want = buildMortonLODTree(pos, n, { box: mortonRootBox(pos, n) });
    computeLODPositions(want, pos);
    computeLODStyle(want, radii, weight, border, undefined, undefined, undefined, borderFlow);
    expect(Array.from(got.border)).toEqual(Array.from(want.border));
    expect(Array.from(got.borderFlow!)).toEqual(Array.from(want.borderFlow!));
    // The absolute mode's frame holds no such array (and is no bigger than before).
    const plain = lodFrameStep(makeSpatialLODStream(n, { radii, weight, border }, 1), pos, 1);
    expect(plain?.header.borderFlow).toBeUndefined();
    if (plain) expect(lodTreeFromSpatialFrame(plain).borderFlow).toBeUndefined();
  });
});
