import { describe, it, expect } from "vitest";
import { nodeCircles, linkLines, linkArrows, networkLayers, resolveNodeRadii, type ResolvedNetworkStyle } from "../glyphs.js";
import { buildGraph } from "../graph.js";

/** A resolved style with a uniform radius for `n` nodes (defaults applied elsewhere). */
const style = (n: number): ResolvedNetworkStyle => ({
  nodeRadii: new Float32Array(n).fill(4),
  nodeFill: "#000000",
  linkWidth: 1,
  linkStroke: "#999999",
  arrowSize: 3,
  arrowFill: "#999999",
  directed: false,
  sizeMode: "world",
});

describe("nodeCircles", () => {
  it("shares both the positions buffer and the resolved radii buffer (no copies)", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    g.positions.set([10, 20, 30, 40]);
    const radii = new Float32Array([5, 9]);

    const c = nodeCircles(g, { radii, fill: "#ff0000" });

    expect(c.count).toBe(2);
    expect(c.centers).toBe(g.positions); // shares the buffer — no copy
    expect(c.radii).toBe(radii); // shares the resolved radii — no copy
    expect(Array.from(c.colors)).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
  });

  it("parses named/rgb colours and applies opacity to the alpha byte", () => {
    const g = buildGraph({ nodeCount: 1, source: [], target: [] });
    const c = nodeCircles(g, { radii: new Float32Array([3]), fill: "rgba(0, 128, 255, 0.5)" });

    expect(Array.from(c.colors)).toEqual([0, 128, 255, 128]);
  });
});

describe("linkLines", () => {
  it("gathers each edge's endpoints from node positions by index", () => {
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2] });
    g.positions.set([0, 0, 10, 10, 20, 20]); // nodes 0,1,2

    const l = linkLines(g, { width: 2, stroke: "#000000" });

    expect(l.count).toBe(2);
    expect(Array.from(l.sources)).toEqual([0, 0, 10, 10]); // edge0 src=node0, edge1 src=node1
    expect(Array.from(l.targets)).toEqual([10, 10, 20, 20]); // edge0 tgt=node1, edge1 tgt=node2
    expect(Array.from(l.widths)).toEqual([2, 2]);
    expect(Array.from(l.colors)).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
  });
});

describe("linkArrows", () => {
  it("sets the tip back from the target by the *target* node's radius, oriented from the source", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: true });
    g.positions.set([0, 0, 10, 0]); // node0 at origin, node1 at (10,0)

    // node0 radius 5, node1 (the target) radius 2 → setback uses the target's 2, not the source's 5.
    const a = linkArrows(g, { size: 4, nodeRadii: new Float32Array([5, 2]), fill: "#ff0000" });

    expect(a.count).toBe(1);
    expect(Array.from(a.sources)).toEqual([0, 0]);
    expect(Array.from(a.targets)).toEqual([8, 0]); // 10 - dir(1,0) * targetRadius(2)
    expect(Array.from(a.sizes)).toEqual([4]);
    expect(Array.from(a.colors)).toEqual([255, 0, 0, 255]);
  });
});

describe("networkLayers", () => {
  it("emits links then nodes for an undirected graph (no arrows)", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    const layers = networkLayers(g, { ...style(2), directed: false });

    expect(layers.map((l) => l.name)).toEqual(["links", "nodes"]);
    expect(layers.map((l) => l.primitive)).toEqual(["lines", "circles"]);
  });

  it("inserts arrows between links and nodes for a directed graph", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: true });
    const layers = networkLayers(g, { ...style(2), directed: true });

    expect(layers.map((l) => l.name)).toEqual(["links", "arrows", "nodes"]);
    expect(layers.map((l) => l.primitive)).toEqual(["lines", "arrows", "circles"]);
  });

  it("emits only nodes when there are no edges", () => {
    const g = buildGraph({ nodeCount: 1, source: [], target: [] });
    const layers = networkLayers(g, { ...style(1), directed: true });

    expect(layers.map((l) => l.name)).toEqual(["nodes"]);
  });

  it("threads sizeMode to nodes + links; arrows stay world-sized (their screen shader is pending)", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: true });
    const layers = networkLayers(g, { ...style(2), directed: true, sizeMode: "screen" });

    const bySize = Object.fromEntries(layers.map((l) => [l.name, l.sizeMode]));
    expect(bySize).toEqual({ links: "screen", arrows: "world", nodes: "screen" });
  });
});

describe("resolveNodeRadii", () => {
  // star: node 1 is the hub (degree 3, strength 6 via weights 1/2/3); leaves degree 1.
  const star = () => buildGraph({ nodeCount: 4, source: [0, 1, 1], target: [1, 2, 3], weight: [1, 2, 3] });

  it("fills a constant radius for a number", () => {
    expect(Array.from(resolveNodeRadii(star(), 7))).toEqual([7, 7, 7, 7]);
  });

  it("uses a supplied Float32Array as-is (no copy) and validates its length", () => {
    const g = star();
    const radii = new Float32Array([1, 2, 3, 4]);
    expect(resolveNodeRadii(g, radii)).toBe(radii);
    expect(() => resolveNodeRadii(g, new Float32Array([1, 2]))).toThrow(/length 2 !== nodeCount 4/);
  });

  it("passes the node's degree to a function accessor (a bare d3 scale fits here)", () => {
    const g = star();
    // degree-driven: radius = 2 * degree. Hub (deg 3) → 6; leaves (deg 1) → 2.
    const radii = resolveNodeRadii(g, (degree) => 2 * degree);
    expect(Array.from(radii)).toEqual([2, 6, 2, 2]);
  });

  it("scales by degree / strength / a custom metric via { by, scale }", () => {
    const g = star();
    const double = (v: number) => v * 2;
    expect(Array.from(resolveNodeRadii(g, { by: "degree", scale: double }))).toEqual([2, 6, 2, 2]);
    // strength = summed incident weights: node0=1, hub=1+2+3=6, node2=2, node3=3.
    expect(Array.from(resolveNodeRadii(g, { by: "strength", scale: double }))).toEqual([2, 12, 4, 6]);
    expect(Array.from(resolveNodeRadii(g, { by: (i) => i, scale: double }))).toEqual([0, 2, 4, 6]);
  });

  it("sizes by app-provided flow, and errors clearly when none was supplied", () => {
    const withFlow = buildGraph({ nodeCount: 4, source: [0, 1, 1], target: [1, 2, 3], nodeFlow: [0.1, 0.4, 0.2, 0.3] });
    const radii = resolveNodeRadii(withFlow, { by: "flow", scale: (v) => v * 10 });
    expect(Array.from(radii)).toEqual([1, 4, 2, 3]);
    expect(() => resolveNodeRadii(star(), { by: "flow", scale: (v) => v })).toThrow(/requires nodeFlow/);
  });
});
