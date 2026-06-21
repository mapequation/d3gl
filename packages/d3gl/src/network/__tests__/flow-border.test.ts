import { describe, it, expect } from "vitest";
import { rgb } from "d3-color";
import { buildGraph } from "../graph.js";
import { resolveFlowBorder, nodeCircles, frontierCircles, flowBorderInnerRadii } from "../glyphs.js";
import { buildModuleLODTree } from "../modules.js";
import { computeLODPositions, computeLODStyle } from "../lod.js";

const id = (v: number) => v;

describe("resolveFlowBorder", () => {
  it("passes an app Float32Array straight through (no copy) and defaults the colour to a darker fill", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    const flow = new Float32Array([0.3, 0.7]);
    const b = resolveFlowBorder(g, { flow, scale: id }, "#4878d0");
    expect(b.metric).toBe(flow); // same reference
    expect(b.colorCss).toBe(rgb("#4878d0").darker(0.8).formatHex());
    expect(b.color).toEqual([...rgbBytes("#4878d0", 0.8)]);
  });

  it("resolves a built-in metric to per-node values, and honours an explicit colour", () => {
    const g = buildGraph({ nodeCount: 3, source: [0, 0], target: [1, 2], nodeFlow: [0.5, 0.2, 0.3] });
    const b = resolveFlowBorder(g, { flow: "flow", scale: id, color: "#ff0000" }, "#000000");
    expect(b.metric[0]).toBeCloseTo(0.5, 6); // graph.flow is Float32, so compare approximately
    expect(b.metric[1]).toBeCloseTo(0.2, 6);
    expect(b.metric[2]).toBeCloseTo(0.3, 6);
    expect(b.color).toEqual([255, 0, 0, 255]);
  });

  it("rejects a Float32Array of the wrong length", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    expect(() => resolveFlowBorder(g, { flow: new Float32Array([1]), scale: id }, "#000")).toThrow(/length/);
  });
});

describe("nodeCircles flow border", () => {
  it("emits ring thickness as scale(metric)/radius, clamped to [0,1], with a repeated colour", () => {
    const g = buildGraph({ nodeCount: 3, source: [0], target: [1] });
    const border = resolveFlowBorder(g, { flow: new Float32Array([5, 0, 40]), scale: id, color: "#ff0000" }, "#000");
    const data = nodeCircles(g, { radii: new Float32Array([10, 10, 10]), fill: "#0000ff", border });
    // 5/10 = 0.5; 0/10 = 0; 40/10 = 4 → clamped to 1.
    expect(Array.from(data.borders!)).toEqual([0.5, 0, 1]);
    expect(Array.from(data.borderColors!.slice(0, 4))).toEqual([255, 0, 0, 255]);
  });

  it("omits the ring arrays when no border style is given (plain filled discs, unchanged)", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    const data = nodeCircles(g, { radii: new Float32Array([4, 4]), fill: "#0000ff" });
    expect(data.borders).toBeUndefined();
    expect(data.borderColors).toBeUndefined();
  });
});

describe("LOD border aggregation (computeLODStyle)", () => {
  it("sums the per-leaf metric up the tree so a module's border reflects its members' total", () => {
    // Two modules of two leaves each, under the root (the modules.test balanced tree).
    const tree = buildModuleLODTree(4, [
      { id: 0, path: [1, 1] },
      { id: 1, path: [1, 2] },
      { id: 2, path: [2, 1] },
      { id: 3, path: [2, 2] },
    ]);
    computeLODStyle(tree, new Float32Array([1, 1, 1, 1]), new Float32Array([1, 1, 1, 1]), new Float32Array([1, 2, 3, 4]));
    expect(Array.from(tree.border.slice(0, 4))).toEqual([1, 2, 3, 4]); // leaves keep their own
    expect(tree.border[4]).toBe(3); // module {0,1}
    expect(tree.border[5]).toBe(7); // module {2,3}
    expect(tree.border[6]).toBe(10); // root
  });

  it("leaves border zeroed when no metric is supplied", () => {
    const tree = buildModuleLODTree(2, [{ id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }]);
    computeLODStyle(tree, new Float32Array([1, 1]), new Float32Array([1, 1]));
    expect(Array.from(tree.border)).toEqual(new Array(tree.size).fill(0));
  });
});

describe("frontierCircles flow border", () => {
  it("draws each frontier glyph's ring from the tree's aggregated metric over its drawn radius", () => {
    const tree = buildModuleLODTree(4, [
      { id: 0, path: [1, 1] },
      { id: 1, path: [1, 2] },
      { id: 2, path: [2, 1] },
      { id: 3, path: [2, 2] },
    ]);
    computeLODPositions(tree, new Float32Array([0, 0, 1, 0, 2, 0, 3, 0]));
    computeLODStyle(tree, new Float32Array([10, 10, 10, 10]), new Float32Array([1, 1, 1, 1]), new Float32Array([5, 5, 5, 5]));
    const fc = frontierCircles(tree, Uint32Array.from([0, 1, 2, 3]), {
      nodeFill: "#00f",
      aggregateFill: "#999",
      border: { metric: new Float32Array(0), scale: id, color: [255, 0, 0, 255], colorCss: "#f00" },
    });
    expect(Array.from(fc.borders!)).toEqual([0.5, 0.5, 0.5, 0.5]); // 5 / radius 10
  });
});

describe("flowBorderInnerRadii (SVG two-disc export)", () => {
  it("shrinks each radius by the ring width, clamped so it never goes negative", () => {
    expect(Array.from(flowBorderInnerRadii(new Float32Array([10, 10]), new Float32Array([3, 20]), id))).toEqual([7, 0]);
  });
});

/** RGBA bytes of a CSS colour darkened by `k` (mirrors resolveFlowBorder's default). */
function rgbBytes(css: string, k: number): [number, number, number, number] {
  const c = rgb(rgb(css).darker(k).formatHex());
  return [Math.round(c.r), Math.round(c.g), Math.round(c.b), 255];
}
