import { describe, it, expect } from "vitest";
import { nodeCircles, linkLines } from "../glyphs.js";
import { buildGraph } from "../graph.js";

describe("nodeCircles", () => {
  it("builds per-node radii and parsed RGBA colours, sharing the graph positions buffer", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    g.positions.set([10, 20, 30, 40]);

    const c = nodeCircles(g, { radius: 5, fill: "#ff0000" });

    expect(c.count).toBe(2);
    expect(c.centers).toBe(g.positions); // shares the buffer — no copy
    expect(Array.from(c.radii)).toEqual([5, 5]);
    expect(Array.from(c.colors)).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
  });

  it("parses named/rgb colours and applies opacity to the alpha byte", () => {
    const g = buildGraph({ nodeCount: 1, source: [], target: [] });
    const c = nodeCircles(g, { radius: 3, fill: "rgba(0, 128, 255, 0.5)" });

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
