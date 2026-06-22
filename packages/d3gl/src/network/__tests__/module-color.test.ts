import { describe, it, expect } from "vitest";
import { buildGraph } from "../graph.js";
import { resolveNodeColors, nodeCircles } from "../glyphs.js";
import { buildModuleLODTree } from "../modules.js";
import { computeLODStyle } from "../lod.js";

describe("resolveNodeColors", () => {
  it("packs a per-node colour accessor into RGBA bytes", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    const colors = resolveNodeColors(g, (i) => (i === 0 ? "#ff0000" : "#0000ff"));
    expect(Array.from(colors)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });
});

describe("LOD colour aggregation (computeLODStyle)", () => {
  it("propagates a uniform module colour to its aggregate, and averages a mixed parent", () => {
    // Module 4 = {0,1} red; module 5 = {2,3} blue; root 6 = {4,5}.
    const tree = buildModuleLODTree(4, [
      { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
    ]);
    const red = [200, 0, 0, 255];
    const blue = [0, 0, 200, 255];
    const leafColors = new Uint8Array([...red, ...red, ...blue, ...blue]);
    computeLODStyle(tree, new Float32Array([4, 4, 4, 4]), new Float32Array([1, 1, 1, 1]), undefined, leafColors);
    // Uniform children keep the colour exactly…
    expect(Array.from(tree.color.slice(4 * 4, 4 * 4 + 4))).toEqual(red); // module 4
    expect(Array.from(tree.color.slice(5 * 4, 5 * 4 + 4))).toEqual(blue); // module 5
    // …the root averages its two children (red+blue)/2.
    expect(Array.from(tree.color.slice(6 * 4, 6 * 4 + 4))).toEqual([100, 0, 100, 255]);
  });
});

describe("constant border", () => {
  it("emits a ring of fixed px width as a fraction of each node's radius", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    const data = nodeCircles(g, {
      radii: new Float32Array([10, 4]),
      fill: "#000",
      constBorder: { width: 1, color: [255, 255, 255, 255] },
    });
    expect(data.borders![0]).toBeCloseTo(0.1); // 1px / r10
    expect(data.borders![1]).toBeCloseTo(0.25); // 1px / r4
    expect(Array.from(data.borderColors!.slice(0, 4))).toEqual([255, 255, 255, 255]);
  });

  it("uses a per-node colour buffer for the fill when provided", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    const colors = resolveNodeColors(g, (i) => (i === 0 ? "#ff0000" : "#00ff00"));
    const data = nodeCircles(g, { radii: new Float32Array([5, 5]), fill: "#000", colors });
    expect(data.colors).toBe(colors); // used directly, no recolour
  });
});
