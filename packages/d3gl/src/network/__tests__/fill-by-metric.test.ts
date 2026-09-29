import { describe, it, expect } from "vitest";
import { buildGraph } from "../graph.js";
import { resolveNodeFill, resolveFlowBorder, moduleBorderValues, applyModuleBorder, treeBorderColors, frontierCircles } from "../glyphs.js";
import { buildModuleLODTree } from "../modules.js";
import { buildLODTree, buildMortonLODTree, computeLODPositions, computeLODStyle } from "../lod.js";

/** A colour scale over [0, 10]: red channel = 25·value, so a colour reads back as its value. */
const redOf = (v: number) => `rgb(${Math.round(25 * v)}, 0, 0)`;
const id = (v: number) => v;

/** Two modules of two leaves each under the root: leaves 0-3, module [1] = 4, module [2] = 5, root = 6. */
function fourLeafTree() {
  return buildModuleLODTree(4, [
    { id: 0, path: [1, 1] },
    { id: 1, path: [1, 2] },
    { id: 2, path: [2, 1] },
    { id: 3, path: [2, 2] },
  ]);
}

describe("resolveNodeFill (#445)", () => {
  const g = buildGraph({ nodeCount: 4, source: [0, 2], target: [1, 3], nodeFlow: [1, 2, 3, 0.5] });

  it("keeps the string and accessor forms as they were", () => {
    expect(resolveNodeFill(g, "#ff0000", "#000")).toEqual({ nodeFill: "#ff0000" });
    expect(resolveNodeFill(g, undefined, "#123456")).toEqual({ nodeFill: "#123456" });
    const acc = resolveNodeFill(g, (i) => (i === 0 ? "#00ff00" : "#0000ff"), "#000");
    expect(Array.from(acc.nodeColors!.slice(0, 8))).toEqual([0, 255, 0, 255, 0, 0, 255, 255]);
    expect(acc.fillAggregate).toBeUndefined(); // aggregates keep the hue mean
  });

  it("{ by, scale } fills each node with scale(metric) and carries the aggregate rule", () => {
    const r = resolveNodeFill(g, { by: "flow", scale: redOf }, "#000");
    expect([0, 1, 2, 3].map((i) => r.nodeColors![i * 4])).toEqual([25, 50, 75, 13]);
    expect(Array.from(r.fillAggregate!.leafValue)).toEqual([1, 2, 3, 0.5]);
    expect(r.fillAggregate!.rgbaOf(4)).toEqual([100, 0, 0, 255]);
  });

  it("{ by } takes any NodeMetric, and a custom accessor", () => {
    const byDegree = resolveNodeFill(g, { by: "degree", scale: redOf }, "#000");
    expect(byDegree.nodeColors![0]).toBe(25); // degree 1
    const custom = resolveNodeFill(g, { by: (i) => i * 2, scale: redOf }, "#000");
    expect(custom.nodeColors![3 * 4]).toBe(150);
  });
});

describe("computeLODStyle fill aggregation (#445)", () => {
  it("fills an aggregate with the scale on its summed metric, not its members' colour mean", () => {
    const g = buildGraph({ nodeCount: 4, source: [0, 2], target: [1, 3], nodeFlow: [1, 2, 3, 0.5] });
    const fill = resolveNodeFill(g, { by: "flow", scale: redOf }, "#000");
    const tree = fourLeafTree();
    const ones = new Float32Array(4).fill(1);
    computeLODStyle(tree, ones, ones, undefined, fill.nodeColors, undefined, fill.fillAggregate);
    expect(tree.color[4 * 4]).toBe(75); // module [1]: flow 1 + 2 = 3
    expect(tree.color[5 * 4]).toBe(88); // module [2]: 3 + 0.5 = 3.5 → 87.5
    expect(tree.color[6 * 4]).toBe(163); // root: 6.5
    expect(tree.color[1 * 4]).toBe(50); // a leaf keeps its own
    // Without the rule the same leaf colours average instead (the accessor form's behaviour).
    computeLODStyle(tree, ones, ones, undefined, fill.nodeColors);
    expect(tree.color[4 * 4]).toBeLessThan(75);
  });
});

describe("flowBorder.moduleFlow (#445)", () => {
  const g = buildGraph({ nodeCount: 4, source: [0, 2], target: [1, 3] });
  const flow = new Float32Array([1, 2, 3, 4]);

  it("replaces a module's summed border with its own value, keyed by Infomap path", () => {
    const seen: string[] = [];
    const border = resolveFlowBorder(g, {
      flow,
      scale: id,
      moduleFlow: (path) => {
        seen.push(path.join(":"));
        return path.length === 1 && path[0] === 1 ? 0.25 : undefined; // only module [1] has a value
      },
    }, "#000");
    const tree = fourLeafTree();
    computeLODStyle(tree, new Float32Array(4).fill(1), new Float32Array(4).fill(1), border.metric);
    const values = moduleBorderValues(tree, border)!;
    applyModuleBorder(tree, values);
    expect(seen.sort()).toEqual(["", "1", "2"]); // once per aggregate; the root's path is []
    expect(tree.border[4]).toBeCloseTo(0.25, 6); // module [1]: its value, not 1 + 2
    expect(tree.border[5]).toBe(7); // module [2]: no value → the sum 3 + 4
    expect(tree.border[6]).toBe(10); // root: no value → the leaf sum, unaffected by module [1]'s value
    expect(Array.from(tree.border.slice(0, 4))).toEqual([1, 2, 3, 4]); // leaves keep their own
  });

  it("is not read for a tree that is not a module tree, nor without moduleFlow", () => {
    let calls = 0;
    const border = resolveFlowBorder(g, { flow, scale: id, moduleFlow: () => (calls++, 1) }, "#000");
    expect(moduleBorderValues(buildLODTree(g, { minNodes: 2 }), border)).toBeNull();
    const spatial = buildMortonLODTree(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 4);
    expect(moduleBorderValues(spatial, border)).toBeNull();
    expect(calls).toBe(0);
    expect(moduleBorderValues(fourLeafTree(), resolveFlowBorder(g, { flow, scale: id }, "#000"))).toBeNull();
  });

  it("hands a colour accessor the value an aggregate's ring draws (its module value), with index −1", () => {
    const calls: [number, number][] = [];
    const border = resolveFlowBorder(g, {
      flow,
      scale: id,
      color: (v, i) => (calls.push([v, i]), redOf(v)),
      moduleFlow: (path) => (path.length === 1 && path[0] === 2 ? 0.4 : undefined),
    }, "#000");
    const tree = fourLeafTree();
    computeLODStyle(tree, new Float32Array(4).fill(1), new Float32Array(4).fill(1), border.metric);
    applyModuleBorder(tree, moduleBorderValues(tree, border)!);
    calls.length = 0; // drop the per-leaf resolution
    const ring = treeBorderColors(tree, border)!;
    expect(calls).toEqual([
      [3, -1], // module [1]: the sum 1 + 2
      [expect.closeTo(0.4, 6), -1], // module [2]: its module value
      [10, -1], // root: the leaf sum
    ]);
    expect(ring[5 * 4]).toBe(10); // 25 · 0.4
    expect(ring[2 * 4]).toBe(75); // leaf 2: its own per-node colour (flow 3)
  });
});

describe("frontierCircles ring colour lookup (#445)", () => {
  const g = buildGraph({ nodeCount: 4, source: [0, 2], target: [1, 3] });
  const flow = new Float32Array([1, 2, 3, 4]);
  const border = resolveFlowBorder(g, { flow, scale: id, color: (v) => redOf(v) }, "#000");
  const tree = fourLeafTree();
  computeLODPositions(tree, new Float32Array([0, 0, 1, 0, 2, 0, 3, 0]));
  computeLODStyle(tree, new Float32Array(4).fill(10), new Float32Array(4).fill(1), border.metric);
  const style = { nodeFill: "#00f", aggregateFill: "#999", border };

  it("reads each glyph's ring colour by its tree-node id, not its frontier position", () => {
    // Frontier order ≠ node order: glyph 0 is leaf 3, glyph 1 is leaf 2, glyph 2 is module [1].
    const frontier = Uint32Array.from([3, 2, 4]);
    const fc = frontierCircles(tree, frontier, { ...style, borderColors: treeBorderColors(tree, border) });
    expect([0, 1, 2].map((i) => fc.borderColors![i * 4])).toEqual([100, 75, 75]); // flows 4, 3, and 1 + 2
  });

  it("without a per-tree table, a leaf keeps its own colour and an aggregate the representative one", () => {
    const fc = frontierCircles(tree, Uint32Array.from([3, 4]), style);
    expect(fc.borderColors![0]).toBe(100); // leaf 3
    expect(fc.borderColors![4]).toBe(border.color[0]); // the highest-flow node's colour
  });
});
