import { describe, it, expect } from "vitest";
import { makeMammalTree, assignBioregions, REGION_NAMES } from "./mammals-data.js";
import type { TreeNode } from "./tree.js";

function leaves(root: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode): void => (n.children ? n.children.forEach(walk) : void out.push(n));
  walk(root);
  return out;
}

describe("makeMammalTree", () => {
  it("produces exactly nTips leaves with finite branch lengths", () => {
    const t = makeMammalTree(300, 1);
    const ls = leaves(t);
    expect(ls.length).toBe(300);
    for (const l of ls) {
      expect(Number.isFinite(l.length)).toBe(true);
      expect(l.length).toBeGreaterThanOrEqual(0);
      expect(l.name).toMatch(/^[A-Z][a-z]+ [a-z]/); // binomial "Genus species"
    }
  });

  it("gives every species a unique name", () => {
    const names = leaves(makeMammalTree(500, 7)).map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("is deterministic per seed", () => {
    expect(makeMammalTree(200, 3)).toEqual(makeMammalTree(200, 3));
    expect(makeMammalTree(200, 3)).not.toEqual(makeMammalTree(200, 4));
  });
});

describe("assignBioregions", () => {
  it("assigns an in-range distribution to every leaf, mostly single-region", () => {
    const t = makeMammalTree(400, 2);
    const cps = assignBioregions(t, REGION_NAMES.length, 2);
    const ls = leaves(t);
    expect(Object.keys(cps).length).toBe(ls.length);

    let single = 0;
    const usedRegions = new Set<number>();
    for (const l of ls) {
      const set = cps[l.name]!;
      expect(set.clusters.length).toBeGreaterThanOrEqual(1);
      for (const r of set.clusters) {
        expect(r.clusterId).toBeGreaterThanOrEqual(0);
        expect(r.clusterId).toBeLessThan(REGION_NAMES.length);
        expect(r.count).toBeGreaterThanOrEqual(1); // synthetic occurrence count
        usedRegions.add(r.clusterId);
      }
      expect(set.totCount).toBe(set.clusters.reduce((s, r) => s + r.count, 0));
      if (set.clusters.length === 1) single++;
    }
    expect(single / ls.length).toBeGreaterThanOrEqual(0.6); // most species in one region
    expect(usedRegions.size).toBe(REGION_NAMES.length); // every bioregion represented
  });

  it("is deterministic per seed", () => {
    const a = assignBioregions(makeMammalTree(200, 5), 6, 5);
    const b = assignBioregions(makeMammalTree(200, 5), 6, 5);
    expect(a).toEqual(b);
  });
});
