import { describe, it, expect } from "vitest";
import { moduleAggregateColors, nodeModules } from "../module-colors.js";
import { moduleFillColors, modulePalette, paletteRGBA, pathRGBA, resolveNodeFill } from "../glyphs.js";
import { buildModuleLODTree } from "../modules.js";
import { buildLODTree, computeLODStyle } from "../lod.js";
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

  // #494 review: a module tree's aggregates are modules, and take their own module's colour.
  describe("module LOD aggregates", () => {
    const fiveRecords = [
      { id: 0, path: [1, 1, 1] },
      { id: 1, path: [1, 1, 2] },
      { id: 2, path: [1, 2, 1] },
      { id: 3, path: [2, 1] },
      { id: 4, path: [2, 2] },
    ];
    const palette: Record<string, string> = { "": "#000000", "1": "#ff0000", "2": "#0000ff", "1,1": "#ffa500", "1,2": "#800080" };
    /** An aggregate's path, walked up `parent` + `branch`, as a hit's `path` reads it. */
    const pathOf = (tree: ReturnType<typeof buildModuleLODTree>, g: number): number[] => {
      const { parent = new Int32Array(0), branch = new Int32Array(0) } = tree;
      const out: number[] = [];
      for (let n = g; n >= 0 && (parent[n] ?? -1) >= 0; n = parent[n] ?? -1) out.push(branch[n] ?? -1);
      return out.reverse();
    };

    it("moduleAggregateColors names every aggregate by its path, once each", () => {
      const tree = buildModuleLODTree(5, fiveRecords);
      const asked: string[] = [];
      const rgba = moduleAggregateColors(tree, [], () => [0, 0, 0, 0], (path) => (asked.push(path.join(",")), [path.length, path[0] ?? 0, path[1] ?? 0, 255]));
      expect(rgba).not.toBeNull();
      const aggregates = tree.size - tree.leafCount;
      expect(asked.length).toBe(aggregates);
      expect(new Set(asked).size).toBe(aggregates);
      for (let g = tree.leafCount; g < tree.size; g++) {
        const path = pathOf(tree, g);
        expect(Array.from(rgba?.subarray(4 * (g - tree.leafCount), 4 * (g - tree.leafCount) + 4) ?? [])).toEqual([path.length, path[0] ?? 0, path[1] ?? 0, 255]);
      }
    });

    it("is null for a tree whose aggregates are no modules (structural)", () => {
      const graph = buildGraph({ nodeCount: 5, source: [0, 1, 2, 3], target: [1, 2, 3, 4], directed: false });
      expect(moduleAggregateColors(buildLODTree(graph), [], () => [0, 0, 0, 0], () => [0, 0, 0, 0])).toBeNull();
    });

    it("computeLODStyle copies them over the members' mean, and a shared palette asks each module once", () => {
      const tree = buildModuleLODTree(5, fiveRecords);
      const asked: string[] = [];
      const modules = nodeModules(5, fiveRecords);
      const color = (path: readonly number[]) => (asked.push(path.join(",")), palette[path.join(",")]);
      const pal = modulePalette(modules.paths, color, "#999999");
      const leafColors = moduleFillColors(modules, color, "#999999", pal);
      const aggregateRGBA = moduleAggregateColors(tree, pal.paths, (m) => paletteRGBA(pal, m), (path) => pathRGBA(pal, path)) ?? new Uint8Array(0);
      // Leaves asked [1,1], [1,2], [2]; the aggregates only what no leaf held: the root and [1].
      expect(asked.sort()).toEqual(["", "1", "1,1", "1,2", "2"]);
      computeLODStyle(tree, new Float32Array(5).fill(1), new Float32Array(5).fill(1), undefined, leafColors, undefined, { aggregateRGBA });
      const colorOf = (path: string) => {
        for (let g = tree.leafCount; g < tree.size; g++) if (pathOf(tree, g).join(",") === path) return Array.from(tree.color.subarray(4 * g, 4 * g + 4));
        return null;
      };
      expect(colorOf("1"), "module [1]: red, not the mean of orange and purple").toEqual([255, 0, 0, 255]);
      expect(colorOf("1,1")).toEqual([255, 165, 0, 255]);
      expect(colorOf("2")).toEqual([0, 0, 255, 255]);
      expect(colorOf("")).toEqual([0, 0, 0, 255]);
    });
  });
});
