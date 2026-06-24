import { describe, it, expect } from "vitest";
import { buildGraph } from "../graph.js";
import { buildModuleLODTree } from "../modules.js";
import { computeLODGeometry } from "../lod.js";
import { superEdges } from "../glyphs.js";

const HALF = { linkStyle: "half-arrow" as const, directed: true, colorOf: (): [number, number, number, number] => [10, 20, 30, 255], arrowSize: 3 };
const ALL = { minX: -1e6, maxX: 1e6, minY: -1e6, maxY: 1e6 }; // everything on-screen

/** Leaves 0,1 in module 4; leaves 2,3 in module 5; root 6. */
const RECORDS = [
  { id: 0, path: [1, 1] },
  { id: 1, path: [1, 2] },
  { id: 2, path: [2, 1] },
  { id: 3, path: [2, 2] },
];

describe("superEdges (half-arrow style) over a module tree", () => {
  it("emits a directed half-arrow per visible module super-edge, pairing reciprocals for oppositeWidth", () => {
    // Reciprocal cross-module flow: 0→2 (flow 3) ⇒ module 4→5 flow 3; 2→0 (flow 1) ⇒ 5→4 flow 1.
    const graph = buildGraph({ nodeCount: 4, source: [0, 2], target: [2, 0], weight: [3, 1], directed: true });
    graph.positions.set([0, 0, 10, 0, 100, 0, 110, 0]); // module 4 at left, module 5 at right
    const tree = buildModuleLODTree(4, RECORDS, graph);
    computeLODGeometry(tree, graph, new Float32Array(4).fill(4));

    const frontier = Uint32Array.from([4, 5]); // both modules visible
    const d = superEdges(tree, frontier, { ...HALF, widthOf: (w) => w, bend: 12 }, ALL).halfArrows!;

    expect(d.count).toBe(2); // 4→5 and 5→4
    // widths = [width, oppositeWidth] per edge: 4→5 carries 3 (opp 1); 5→4 carries 1 (opp 3).
    expect(Array.from(d.widths)).toEqual([3, 1, 1, 3]);
    expect(Array.from(d.bends)).toEqual([12, 12]);
    expect(Array.from(d.colors)).toEqual([10, 20, 30, 255, 10, 20, 30, 255]);
    // First edge is 4→5: source is module 4's centroid (left, x≈5), target module 5's (right, x≈105).
    expect(d.sources[0]!).toBeLessThan(d.targets[0]!);
    expect(d.targets[0]!).toBeGreaterThan(50);
    // radii carry each module's draw radius (its area-additive aggregate radius > 0).
    expect(d.radii[0]!).toBeGreaterThan(0);
    expect(d.radii[1]!).toBeGreaterThan(0);
  });

  it("draws only super-edges whose both endpoints are in the visible frontier", () => {
    const graph = buildGraph({ nodeCount: 4, source: [0, 2], target: [2, 0], weight: [3, 1], directed: true });
    graph.positions.set([0, 0, 10, 0, 100, 0, 110, 0]);
    const tree = buildModuleLODTree(4, RECORDS, graph);
    computeLODGeometry(tree, graph, new Float32Array(4).fill(4));

    // Only module 4 visible → its super-edge to 5 is skipped (5 not present).
    const d = superEdges(tree, Uint32Array.from([4]), { ...HALF, widthOf: (w) => w, bend: 12 }, ALL).halfArrows;
    expect(d ? d.count : 0).toBe(0);
  });
});
