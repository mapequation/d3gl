import { describe, it, expect } from "vitest";
import { topLevelBounds, fitTransform } from "../fit.js";
import { buildLODTree, computeLODGeometry } from "../lod.js";
import { multilevelSeed } from "../coarsen.js";
import { buildGraph } from "../graph.js";

/**
 * Guards the pure core of fit-on-layout (#206), the per-frame reframe of a streaming layout.
 *
 * `topLevelBounds` is the per-frame hot path: it MUST read only the LOD tree's top-level (root) nodes,
 * so the reframe is O(top-level modules), NOT O(nodes). That is proved deterministically by **poisoning
 * every node below the top level** with a sentinel that would blow the bbox up if it were read, then
 * asserting the returned box is unaffected (it equals the top-level union). This is a non-flaky stand-in
 * for the AGENTS.md per-frame rule: it fails the instant someone changes the fit to scan all positions.
 */
function clusteredTree(n: number) {
  let s = 7 >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const source: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < n; i++) {
    source.push(i, i);
    target.push((i + 1) % n, (i + 1 + Math.floor(rng() * (n - 2))) % n);
  }
  const g = buildGraph({ nodeCount: n, source, target });
  multilevelSeed(g, { width: 2000, height: 2000 });
  const tree = buildLODTree(g, {});
  computeLODGeometry(tree, g, new Float32Array(n).fill(4));
  return tree;
}

describe("topLevelBounds", () => {
  const N = 5000;
  const tree = clusteredTree(N);

  it("coarsens to multiple levels with a top level far smaller than N", () => {
    expect(tree.levelCount).toBeGreaterThan(1);
    const top = tree.levelCount - 1;
    const topCount = tree.levelOffset[top + 1]! - tree.levelOffset[top]!;
    expect(topCount).toBeGreaterThan(0);
    expect(topCount).toBeLessThan(N / 10); // O(top-level) ≪ O(nodes)
  });

  it("unions the top-level roots' cx/cy ± extent", () => {
    const top = tree.levelCount - 1;
    const start = tree.levelOffset[top]!;
    const end = tree.levelOffset[top + 1]!;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let g = start; g < end; g++) {
      minX = Math.min(minX, tree.cx[g]! - tree.extent[g]!);
      minY = Math.min(minY, tree.cy[g]! - tree.extent[g]!);
      maxX = Math.max(maxX, tree.cx[g]! + tree.extent[g]!);
      maxY = Math.max(maxY, tree.cy[g]! + tree.extent[g]!);
    }
    expect(topLevelBounds(tree)).toEqual([minX, minY, maxX, maxY]);
  });

  it("reads ONLY the top level — poisoning every node below it does not change the box (O(top-level), not O(N))", () => {
    const poisoned = clusteredTree(N);
    const top = poisoned.levelCount - 1;
    const topStart = poisoned.levelOffset[top]!;
    const expected = topLevelBounds(poisoned);
    // Blow up every non-top node's geometry: if topLevelBounds scanned leaves, these would dominate.
    for (let g = 0; g < topStart; g++) {
      poisoned.cx[g] = 1e9;
      poisoned.cy[g] = -1e9;
      poisoned.extent[g] = 1e9;
    }
    expect(topLevelBounds(poisoned)).toEqual(expected);
  });
});

describe("fitTransform", () => {
  it("centres the box centre in the viewport", () => {
    const box: [number, number, number, number] = [100, 200, 300, 500];
    const w = 800, h = 600;
    const t = fitTransform(box, w, h);
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;
    expect(t.k * cx + t.x).toBeCloseTo(w / 2, 6);
    expect(t.k * cy + t.y).toBeCloseTo(h / 2, 6);
  });

  it("scales the longest side to 0.85 of the shorter viewport dimension", () => {
    const box: [number, number, number, number] = [0, 0, 400, 100]; // span 400 (x)
    const w = 800, h = 600;
    const t = fitTransform(box, w, h);
    expect(t.k * 400).toBeCloseTo(0.85 * Math.min(w, h), 6);
  });

  it("does not divide by zero for a degenerate (single-point) box", () => {
    const t = fitTransform([50, 50, 50, 50], 800, 600);
    expect(Number.isFinite(t.k)).toBe(true);
    expect(t.k * 50 + t.x).toBeCloseTo(400, 6);
  });
});
