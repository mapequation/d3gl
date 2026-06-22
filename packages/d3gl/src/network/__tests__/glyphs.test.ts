import { describe, it, expect } from "vitest";
import { nodeCircles, linkLines, linkArrows, halfArrowLinks, networkLayers, resolveNodeRadii, type ResolvedNetworkStyle } from "../glyphs.js";
import { buildGraph } from "../graph.js";

/** A resolved style with a uniform radius for `n` nodes (defaults applied elsewhere). */
const style = (n: number): ResolvedNetworkStyle => ({
  nodeRadii: new Float32Array(n).fill(4),
  nodeFill: "#000000",
  linkWidth: 1,
  linkWidthOf: () => 1,
  linkStroke: "#999999",
  linkColorOf: () => [153, 153, 153, 255],
  linkStrokeOf: () => "#999999",
  linkStyle: "line",
  arrowSize: 3,
  directed: false,
  sizeMode: "world",
  flowBorder: null,
  constBorder: null,
  linkBend: 0,
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

    const l = linkLines(g, { widthOf: () => 2, colorOf: () => [0, 0, 0, 255] });

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
    const a = linkArrows(g, { size: 4, nodeRadii: new Float32Array([5, 2]), colorOf: () => [255, 0, 0, 255] });

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

  it("emits one fused half-arrow links layer (no separate arrows) for linkStyle:'half-arrow'", () => {
    const g = buildGraph({ nodeCount: 2, source: [0, 1], target: [1, 0], directed: true });
    const layers = networkLayers(g, { ...style(2), directed: true, linkStyle: "half-arrow", linkBend: 30 });

    // The arrowhead is part of the filled shape, so there is no "arrows" layer; world-sized.
    expect(layers.map((l) => l.name)).toEqual(["links", "nodes"]);
    expect(layers.map((l) => l.primitive)).toEqual(["half-arrows", "circles"]);
    expect(layers.find((l) => l.name === "links")?.sizeMode).toBe("world");
  });
});

describe("halfArrowLinks", () => {
  it("packs per-edge endpoints, [r0,r1] radii, and pairs reciprocal widths via oppositeWidth", () => {
    const g = buildGraph({ nodeCount: 2, source: [0, 1], target: [1, 0], weight: [5, 2], directed: true });
    g.positions.set([0, 0, 10, 0]);
    const d = halfArrowLinks(g, {
      nodeRadii: new Float32Array([3, 1]),
      widthOf: (w) => w, // width == weight, so we can read pairing directly
      colorOf: () => [1, 2, 3, 255],
      bend: 30,
    });

    expect(d.count).toBe(2);
    // edge 0 (0→1): r0=node0=3, r1=node1=1; edge 1 (1→0): r0=node1=1, r1=node0=3.
    expect(Array.from(d.radii)).toEqual([3, 1, 1, 3]);
    // widths = [width, oppositeWidth]: edge0 carries 5 with opposite 2; edge1 carries 2 with opposite 5.
    expect(Array.from(d.widths)).toEqual([5, 2, 2, 5]);
    expect(Array.from(d.bends)).toEqual([30, 30]);
    expect(Array.from(d.colors)).toEqual([1, 2, 3, 255, 1, 2, 3, 255]);
  });

  it("falls back oppositeWidth to the edge's own width when there is no reciprocal link", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], weight: [4], directed: true });
    const d = halfArrowLinks(g, { nodeRadii: new Float32Array([2, 2]), widthOf: (w) => w, colorOf: () => [0, 0, 0, 255], bend: 10 });
    expect(Array.from(d.widths)).toEqual([4, 4]); // no 1→0 edge ⇒ oppositeWidth = own width
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
