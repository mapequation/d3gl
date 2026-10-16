import { describe, it, expect } from "vitest";
import { nodeModules } from "../module-colors.js";
import { moduleFillColors, resolveNodeFill } from "../glyphs.js";
import { buildGraph } from "../graph.js";
import { buildStateGraph } from "../state-graph.js";
import { physicalPieWedges } from "../pie.js";

// `nodeFill: { by: "module", color }` (#494): a node takes its enclosing module's colour (its path minus the
// rank), the accessor is asked once per module, and a module without a colour takes the fallback.
describe("module fill", () => {
  const records = [
    { id: 0, path: [1, 1, 1] },
    { id: 1, path: [1, 1, 2] },
    { id: 2, path: [1, 2, 1] },
    { id: 3, path: [2, 1] },
    { id: 4, path: [7] }, // a node in no module: the root
  ];

  it("nodeModules interns each node's enclosing module once", () => {
    const { moduleOf, paths } = nodeModules(6, records);
    const of = (id: number) => (moduleOf[id]! >= 0 ? paths[moduleOf[id]!] : null);
    expect(of(0)).toEqual([1, 1]);
    expect(of(1)).toBe(of(0)); // the same interned path
    expect(of(2)).toEqual([1, 2]);
    expect(of(3)).toEqual([2]);
    expect(of(4)).toEqual([]);
    expect(of(5)).toBeNull(); // no record
  });

  it("moduleFillColors asks once per module and falls back for a missing colour", () => {
    const asked: string[] = [];
    const rgba = moduleFillColors(nodeModules(6, records), (path) => {
      asked.push(path.join(":"));
      return path.join(":") === "1:1" ? "#ff0000" : path.length === 1 ? "#0000ff" : undefined;
    }, "#00ff00");
    expect(asked.sort()).toEqual(["", "1:1", "1:2", "2"]);
    const at = (i: number) => Array.from(rgba.subarray(4 * i, 4 * i + 4));
    expect(at(0)).toEqual([255, 0, 0, 255]);
    expect(at(1)).toEqual([255, 0, 0, 255]);
    expect(at(2)).toEqual([0, 255, 0, 255]); // no colour for [1, 2]: the fallback
    expect(at(3)).toEqual([0, 0, 255, 255]);
    expect(at(5)).toEqual([0, 255, 0, 255]); // no record: the fallback
  });

  it("resolveNodeFill takes the module form only with a hierarchy", () => {
    const g = buildGraph({ nodeCount: 6, source: [0], target: [1] });
    const spec = { by: "module" as const, color: () => "#ff0000" };
    expect(resolveNodeFill(g, spec, "#123456").nodeColors).toBeUndefined();
    expect(resolveNodeFill(g, spec, "#123456", nodeModules(6, records)).nodeColors?.length).toBe(24);
  });

  it("pie wedges carry their module path, shared per module", () => {
    const graph = buildStateGraph({ stateCount: 3, stateToPhysical: [0, 0, 1], source: [0], target: [2] });
    const wedges = physicalPieWedges(graph, [
      { id: 0, path: [1, 2, 1] },
      { id: 1, path: [2, 1] },
      { id: 2, path: [1, 1, 1] },
    ]);
    expect(wedges.modulePath).toEqual([[1], [2], [1]]);
    expect(wedges.modulePath[0]).toBe(wedges.modulePath[2]);
  });
});
