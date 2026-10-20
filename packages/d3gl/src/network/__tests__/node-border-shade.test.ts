import { describe, it, expect } from "vitest";
import { buildGraph } from "../graph.js";
import { BORDER_DARKEN, resolveNodeBorder, resolveFlowBorder, nodeCircles, frontierCircles } from "../glyphs.js";
import { buildModuleLODTree } from "../modules.js";
import { computeLODStyle } from "../lod.js";

/** #506: a node border with no colour given is each glyph's own fill darkened, by the flow border's rule. */

const darkened = (c: readonly number[]): number[] => [
  Math.round(c[0]! * BORDER_DARKEN), Math.round(c[1]! * BORDER_DARKEN), Math.round(c[2]! * BORDER_DARKEN), c[3]!,
];
const rgbaAt = (a: Uint8Array | undefined, i: number): number[] => Array.from(a?.subarray(i * 4, i * 4 + 4) ?? []);

describe("resolveNodeBorder (#506)", () => {
  it("with no colour: darkens each glyph by the flow border's factor; the representative is the default fill darkened", () => {
    const b = resolveNodeBorder({ width: 2 }, "#4080c0");
    expect(b.darken).toBe(BORDER_DARKEN);
    const g = buildGraph({ nodeCount: 1, source: [], target: [] });
    expect(resolveFlowBorder(g, { flow: new Float32Array([1]), scale: (v) => v }, "#4080c0").darken).toBe(b.darken);
    expect(b.color).toEqual(darkened([0x40, 0x80, 0xc0, 255]));
  });

  it("with a colour: that colour on every ring, and no darkening (today's behaviour)", () => {
    expect(resolveNodeBorder({ width: 1, color: "#fff" }, "#4080c0")).toEqual({ width: 1, color: [255, 255, 255, 255] });
  });
});

describe("nodeCircles with a node border (LOD off, #506)", () => {
  const graph = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2] });
  const radii = new Float32Array([4, 8, 2]);
  // A translucent third node: the ring keeps its fill's alpha, as a flow border's does.
  const colors = new Uint8Array([200, 100, 50, 255, 10, 20, 30, 255, 255, 255, 255, 128]);

  it("each node's ring is its own fill darkened, alpha kept; ring width = width / radius", () => {
    const c = nodeCircles(graph, { radii, fill: "#000", colors, constBorder: resolveNodeBorder({ width: 1 }, "#000") });
    for (let i = 0; i < 3; i++) expect(rgbaAt(c.borderColors, i)).toEqual(darkened(rgbaAt(colors, i)));
    expect(Array.from(c.borders ?? [])).toEqual([0.25, 0.125, 0.5]);
    expect(c.borderColors).not.toBe(colors); // the fill is not darkened in place
    expect(Array.from(colors.subarray(0, 4))).toEqual([200, 100, 50, 255]);
  });

  it("an explicit colour: every ring that colour", () => {
    const c = nodeCircles(graph, { radii, fill: "#000", colors, constBorder: resolveNodeBorder({ width: 1, color: "#ffffff" }, "#000") });
    for (let i = 0; i < 3; i++) expect(rgbaAt(c.borderColors, i)).toEqual([255, 255, 255, 255]);
    expect(Array.from(c.borders ?? [])).toEqual([0.25, 0.125, 0.5]);
  });

  it("a single fill: every ring that fill darkened", () => {
    const c = nodeCircles(graph, { radii, fill: "#ff8000", constBorder: resolveNodeBorder({ width: 1 }, "#ff8000") });
    for (let i = 0; i < 3; i++) expect(rgbaAt(c.borderColors, i)).toEqual(darkened([255, 128, 0, 255]));
  });
});

describe("frontierCircles with a node border (LOD on, #506)", () => {
  // Module 4 = {0,1} red; module 5 = {2,3} blue.
  const tree = buildModuleLODTree(4, [
    { id: 0, path: [1, 1] }, { id: 1, path: [1, 2] }, { id: 2, path: [2, 1] }, { id: 3, path: [2, 2] },
  ]);
  const red = [200, 0, 0, 255];
  const blue = [0, 0, 200, 255];
  computeLODStyle(tree, new Float32Array([4, 4, 4, 4]), new Float32Array([1, 1, 1, 1]), undefined, new Uint8Array([...red, ...red, ...blue, ...blue]));
  const style = { nodeFill: "#000", aggregateFill: "#000", useTreeColor: true };

  it("each glyph's ring is its own (module) colour darkened: a collapsed module in its module's shade", () => {
    const frontier = new Uint32Array([4, 2, 3]); // module 4 collapsed, module 5 open
    const c = frontierCircles(tree, frontier, { ...style, constBorder: resolveNodeBorder({ width: 1 }, "#000") });
    for (let i = 0; i < frontier.length; i++) expect(rgbaAt(c.borderColors, i)).toEqual(darkened(rgbaAt(c.colors, i)));
    expect(rgbaAt(c.borderColors, 1)).toEqual(darkened(blue));
  });

  it("a cross-fade scales the ring's alpha as it scales the fill's", () => {
    const frontier = new Uint32Array([4, 5]);
    const fadeAlpha = new Float32Array(tree.size).fill(1);
    fadeAlpha[5] = 0.5;
    const c = frontierCircles(tree, frontier, { ...style, constBorder: resolveNodeBorder({ width: 1 }, "#000"), fadeAlpha });
    expect(rgbaAt(c.borderColors, 1)[3]).toBe(rgbaAt(c.colors, 1)[3]);
    expect(rgbaAt(c.colors, 1)[3]).toBeLessThan(255);
  });

  it("an explicit colour: every ring that colour", () => {
    const frontier = new Uint32Array([4, 5]);
    const c = frontierCircles(tree, frontier, { ...style, constBorder: resolveNodeBorder({ width: 1, color: "#fff" }, "#000") });
    expect(rgbaAt(c.borderColors, 0)).toEqual([255, 255, 255, 255]);
    expect(rgbaAt(c.borderColors, 1)).toEqual([255, 255, 255, 255]);
  });
});
