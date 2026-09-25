import { describe, it, expect } from "vitest";
import { buildModuleLODTree, type ModuleLink, type ModuleNode } from "../modules.js";
import { nestedLayout } from "../nested-layout.js";
import type { LODTree } from "../lod.js";

/** Children of tree node `g`. */
function kids(tree: LODTree, g: number): number[] {
  return Array.from(tree.children.slice(tree.childOffset[g]!, tree.childOffset[g + 1]!));
}

function rootOf(tree: LODTree): number {
  const parent = tree.parent;
  if (!parent) throw new Error("module trees carry a parent map");
  for (let g = 0; g < tree.size; g++) if (parent[g]! < 0) return g;
  throw new Error("no root");
}

/**
 * Two-level map: 4 top modules × 6 leaves. Modules 1↔2 and 3↔4 are strongly linked; 1–3 weakly. Leaves
 * are chained inside each module. Only `.ftree`-style data: leaf links inside modules + module links.
 */
function twoLevel(): { tree: LODTree; nodeCount: number } {
  const records: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  for (let m = 0; m < 4; m++) {
    for (let j = 0; j < 6; j++) {
      const id = m * 6 + j;
      records.push({ id, path: [m + 1, j + 1] });
      if (j > 0) {
        source.push(id - 1);
        target.push(id);
        weight.push(1);
      }
    }
  }
  const links: ModuleLink[] = [
    { source: [1], target: [2], flow: 1 },
    { source: [3], target: [4], flow: 1 },
    { source: [1], target: [3], flow: 0.01 },
  ];
  return { tree: buildModuleLODTree(24, records, { source, target, weight }, links), nodeCount: 24 };
}

describe("nestedLayout (#324)", () => {
  const { tree, nodeCount } = twoLevel();
  const out = nestedLayout(tree);
  const root = rootOf(tree);
  const [m1, m2, m3, m4] = kids(tree, root).sort((a, b) => a - b);
  const dist = (a: number, b: number): number => Math.hypot(out.cx[a]! - out.cx[b]!, out.cy[a]! - out.cy[b]!);

  it("returns a position for every leaf", () => {
    expect(out.positions).toHaveLength(2 * nodeCount);
    expect(Array.from(out.positions).every(Number.isFinite)).toBe(true);
  });

  it("keeps every child disc inside its parent's disc", () => {
    const parent = tree.parent!;
    for (let g = 0; g < tree.size; g++) {
      const p = parent[g]!;
      if (p < 0) continue;
      expect(dist(g, p) + out.r[g]!).toBeLessThanOrEqual(out.r[p]! * 1.0001);
    }
  });

  it("places each leaf inside all of its ancestors' discs", () => {
    const parent = tree.parent!;
    for (let i = 0; i < nodeCount; i++) {
      for (let g = parent[i]!; g >= 0; g = parent[g]!) {
        const d = Math.hypot(out.positions[2 * i]! - out.cx[g]!, out.positions[2 * i + 1]! - out.cy[g]!);
        expect(d).toBeLessThanOrEqual(out.r[g]!);
      }
    }
  });

  it("does not overlap sibling discs", () => {
    for (let g = tree.leafCount; g < tree.size; g++) {
      const c = kids(tree, g);
      for (let a = 0; a < c.length; a++) {
        for (let b = a + 1; b < c.length; b++) {
          expect(dist(c[a]!, c[b]!)).toBeGreaterThanOrEqual((out.r[c[a]!]! + out.r[c[b]!]!) * 0.98);
        }
      }
    }
  });

  it("places strongly linked siblings closer than weakly or unlinked ones", () => {
    expect(dist(m1!, m2!)).toBeLessThan(dist(m1!, m4!));
    expect(dist(m3!, m4!)).toBeLessThan(dist(m2!, m3!));
  });

  it("is deterministic", () => {
    expect(Array.from(nestedLayout(tree).positions)).toEqual(Array.from(out.positions));
  });

  it("sizes discs by the size metric", () => {
    const size = new Float32Array(nodeCount).fill(1);
    for (let j = 0; j < 6; j++) size[j] = 10; // module 1 gets 10× the metric of each other module
    const sized = nestedLayout(tree, { size });
    expect(sized.r[m1!]! / sized.r[m2!]!).toBeCloseTo(Math.sqrt(10), 1);
  });

  it("streams depths top-down, leaves collapsed to their placed ancestor", () => {
    const depths: number[] = [];
    let firstFrame: Float32Array | null = null;
    nestedLayout(tree, {
      onDepth: (depth, positions) => {
        depths.push(depth);
        firstFrame ??= positions.slice();
      },
    });
    expect(depths).toEqual([1, 2]);
    // After depth 1 every leaf of module 1 sits at module 1's centre.
    const frame = firstFrame as Float32Array | null;
    expect(frame?.[0]).toBeCloseTo(out.cx[m1!]!);
    expect(frame?.[10]).toBeCloseTo(out.cx[m1!]!);
  });
});
