import { describe, it, expect } from "vitest";
import { nodeCircles } from "../glyphs.js";
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
