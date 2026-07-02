import { describe, it, expect } from "vitest";
import { rgb } from "d3-color";
import { buildStateGraph } from "../state-graph.js";
import { physicalPieWedges } from "../pie.js";
import { physicalPieInstances } from "../glyphs.js";

// Physical A(0): state 0,1,2 spanning modules 1 (0,1) and 2 (2) → overlapping (pie).
// Physical B(1): state 3,4 both in module 2 → single-module (solid disc, no pie).
const graph = buildStateGraph({
  stateCount: 5,
  stateToPhysical: [0, 0, 0, 1, 1],
  source: [0, 3],
  target: [3, 0],
  nodeFlow: [0.4, 0.4, 0.2, 0.5, 0.5],
});
const modules = [
  { id: 0, path: [1, 1] },
  { id: 1, path: [1, 2] },
  { id: 2, path: [2, 1] },
  { id: 3, path: [2, 2] },
  { id: 4, path: [2, 3] },
];
const wedges = physicalPieWedges(graph, modules, { by: "flow" });

describe("physicalPieInstances", () => {
  it("emits one instance per wedge for overlapping nodes only (single-module nodes skipped)", () => {
    const positions = new Float32Array([10, 20, 100, 200]); // A at (10,20), B at (100,200)
    const pie = physicalPieInstances(wedges, positions, 8);
    expect(pie.count).toBe(2); // A's two wedges; B (single module) is not a pie
    // Both wedges share A's centre and radius.
    expect(Array.from(pie.centers)).toEqual([10, 20, 10, 20]);
    expect(Array.from(pie.radii)).toEqual([8, 8]);
    // Group id = physical node id (A = 0), so a hover/select lights both wedges.
    expect(Array.from(pie.groups!)).toEqual([0, 0]);
  });

  it("packs cumulative [start,end] angular ranges matching the wedge fractions", () => {
    const pie = physicalPieInstances(wedges, new Float32Array([0, 0, 0, 0]), 8);
    // Flow: module 1 = 0.8, module 2 = 0.2 → wedges [0,0.8] then [0.8,1].
    expect(pie.angles[0]).toBeCloseTo(0);
    expect(pie.angles[1]).toBeCloseTo(0.8);
    expect(pie.angles[2]).toBeCloseTo(0.8);
    expect(pie.angles[3]).toBe(1);
  });

  it("packs each wedge's colour as RGBA bytes", () => {
    const pie = physicalPieInstances(wedges, new Float32Array([0, 0, 0, 0]), 8);
    const c0 = rgb(wedges.color[0]!);
    expect(pie.colors[0]).toBe(Math.round(c0.r) & 255);
    expect(pie.colors[1]).toBe(Math.round(c0.g) & 255);
    expect(pie.colors[2]).toBe(Math.round(c0.b) & 255);
    expect(pie.colors[3]).toBe(255); // opaque
  });

  it("accepts a per-physical radius array", () => {
    const radii = new Float32Array([12, 5]); // A → 12, B → 5 (unused, B skipped)
    const pie = physicalPieInstances(wedges, new Float32Array([0, 0, 0, 0]), radii);
    expect(Array.from(pie.radii)).toEqual([12, 12]);
  });
});
