import { describe, it, expect } from "vitest";
import { rgb } from "d3-color";
import { buildStateGraph } from "../state-graph.js";
import { physicalPieWedges } from "../pie.js";
import { physicalPieInstances, physicalPieSelected } from "../glyphs.js";

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

// #175: the pie's per-wedge `selected` column must line up with physicalPieInstances' wedge order
// (overlapping physical nodes only, in physical order, each node's wedges contiguous) — the shader
// reads instance w's flag against instance w's wedge, so a skew dims the wrong pie.
describe("physicalPieSelected (#175)", () => {
  // Three overlapping physical nodes around one single-module node, so skipping the disc is exercised.
  const g3 = buildStateGraph({
    stateCount: 7,
    stateToPhysical: [0, 0, 1, 2, 2, 2, 3],
    source: [0, 3],
    target: [3, 6],
    nodeFlow: [1, 1, 1, 1, 1, 1, 1],
  });
  const m3 = [
    { id: 0, path: [1, 1] },
    { id: 1, path: [2, 1] }, // physical 0 spans modules 1 + 2
    { id: 2, path: [1, 2] }, // physical 1: single module ⇒ disc, no wedges emitted
    { id: 3, path: [1, 3] },
    { id: 4, path: [2, 2] },
    { id: 5, path: [3, 1] }, // physical 2 spans modules 1 + 2 + 3
    { id: 6, path: [3, 2] }, // physical 3: single module ⇒ disc
  ];
  const w3 = physicalPieWedges(g3, m3, { by: "count" });
  const pie = physicalPieInstances(w3, new Float32Array(8), 4);

  it("flags every wedge of a selected physical node, in physicalPieInstances' instance order", () => {
    const sel = new Set([2]);
    const flags = physicalPieSelected(w3, (p) => sel.has(p));
    expect(flags.length).toBe(pie.count); // one flag per emitted wedge instance
    expect(Array.from(flags)).toEqual([0, 0, 1, 1, 1]); // p0's two wedges, then p2's three
    // Instance-for-instance agreement with the group column the shader matches the hover against.
    const groups = pie.groups ?? new Float32Array(0);
    for (let w = 0; w < pie.count; w++) expect(flags[w]).toBe(sel.has(groups[w] ?? -1) ? 1 : 0);
  });

  it("is all zeros with no selection, and asks the predicate once per overlapping node", () => {
    expect(Array.from(physicalPieSelected(w3, null))).toEqual([0, 0, 0, 0, 0]);
    const asked: number[] = [];
    physicalPieSelected(w3, (p) => (asked.push(p), false));
    expect(asked).toEqual([0, 2]); // single-module discs (1, 3) carry no wedge instance
  });
});
