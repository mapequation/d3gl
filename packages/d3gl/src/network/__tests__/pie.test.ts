import { describe, it, expect } from "vitest";
import { buildStateGraph } from "../state-graph.js";
import { physicalPieWedges } from "../pie.js";
import { moduleColors } from "../module-colors.js";

// Physical A(0): state 0,1,2. Physical B(1): state 3,4.
const graph = buildStateGraph({
  stateCount: 5,
  stateToPhysical: [0, 0, 0, 1, 1],
  source: [0, 3],
  target: [3, 0],
  nodeFlow: [0.4, 0.4, 0.2, 0.5, 0.5],
});

// Top-level modules: A's state nodes span modules 1 (nodes 0,1) and 2 (node 2) → overlapping.
// B's state nodes are both in module 2 → single module → solid disc.
const modules = [
  { id: 0, path: [1, 1] },
  { id: 1, path: [1, 2] },
  { id: 2, path: [2, 1] },
  { id: 3, path: [2, 2] },
  { id: 4, path: [2, 3] },
];

describe("physicalPieWedges", () => {
  it("emits one wedge per distinct module a physical node's state nodes span", () => {
    const pie = physicalPieWedges(graph, modules);
    expect(Array.from(pie.wedgeCount)).toEqual([2, 1]); // A overlaps 2 modules, B is single-module
    expect(Array.from(pie.offset)).toEqual([0, 2, 3]);
  });

  it("sizes wedges by summed state-node flow, closing the last at exactly 1", () => {
    const pie = physicalPieWedges(graph, modules, { by: "flow" });
    // A: module 1 = 0.4+0.4 = 0.8, module 2 = 0.2; total 1.0 → cumulative ends 0.8, 1.0.
    expect(pie.end[0]).toBeCloseTo(0.8);
    expect(pie.end[1]).toBe(1); // last wedge closes at exactly 1
    // B: single module → one wedge closing at 1.
    expect(pie.end[2]).toBe(1);
    expect(pie.moduleKey.slice(0, 2)).toEqual(["1", "2"]);
  });

  it("can size by count instead of flow", () => {
    const pie = physicalPieWedges(graph, modules, { by: "count" });
    // A: module 1 has 2 nodes, module 2 has 1 → cumulative 2/3, 1.
    expect(pie.end[0]).toBeCloseTo(2 / 3);
    expect(pie.end[1]).toBe(1);
  });

  it("colours a single-module disc the same family hue moduleColors gives that top module", () => {
    const pie = physicalPieWedges(graph, modules);
    // B is single-module (module 2). Its disc colour must match moduleColors' top-module-2 arc so a
    // solid disc and a wedge for module 2 read identically. A node whose enclosing module IS the top
    // module (path length 2) gets exactly the top arc centre from moduleColors.
    const nodeColors = moduleColors([{ id: 0, path: [1, 1] }, { id: 1, path: [2, 1] }]);
    expect(pie.color[2]).toBe(nodeColors[1]); // module-2 wedge == module-2 node colour
    expect(pie.color[1]).toBe(nodeColors[1]); // A's module-2 wedge matches too
  });

  it("requires a module record for every state node", () => {
    expect(() => physicalPieWedges(graph, modules.slice(0, 4))).toThrow(/no module record for state node 4/);
  });
});
