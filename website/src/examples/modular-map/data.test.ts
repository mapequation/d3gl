import { describe, it, expect } from "vitest";
import { asFtree, makeModularMap } from "./data.js";

describe("asFtree (the modular map as an .ftree carries it)", () => {
  const d = makeModularMap(1000);
  const f = asFtree(d);

  it("keeps only the links inside bottom modules as graph edges", () => {
    for (let e = 0; e < f.source.length; e++) expect(d.community[f.source[e]!]).toBe(d.community[f.target[e]!]);
    expect(f.source.length).toBeLessThan(d.source.length);
  });

  it("folds every other link into one sibling module link per pair, with no flow lost or counted twice", () => {
    const total = d.linkFlow.reduce((a, b) => a + b, 0);
    const kept = f.linkFlow.reduce((a, b) => a + b, 0) + f.moduleLinks.reduce((a, l) => a + l.flow, 0);
    expect(kept).toBeCloseTo(total, 3);
    const pairs = new Set<string>();
    for (const l of f.moduleLinks) {
      const s = Array.from(l.source);
      const t = Array.from(l.target);
      expect(s.length).toBe(t.length);
      expect(s.slice(0, -1)).toEqual(t.slice(0, -1)); // siblings: the same parent module
      expect(s.at(-1)).not.toBe(t.at(-1));
      const key = `${s}>${t}`;
      expect(pairs.has(key)).toBe(false);
      pairs.add(key);
    }
    expect(f.moduleLinks.length).toBeGreaterThan(0);
  });
});

describe("moduleEnterExit (each module's own boundary flow)", () => {
  const d = makeModularMap(1000);
  // Each module's members' enter/exit sum, by path — what a module's ring would draw without its own value.
  const memberSum = new Map<string, number>();
  for (const { id, path } of d.modulePaths) {
    for (let k = 1; k < path.length; k++) {
      const key = path.slice(0, k).join(":");
      memberSum.set(key, (memberSum.get(key) ?? 0) + d.enterExit[id]!);
    }
  }

  it("equals the members' sum for a bottom module (a community), whose members' boundary is its own", () => {
    for (const { path } of d.modulePaths) {
      const key = path.slice(0, -1).join(":");
      expect(d.moduleEnterExit.get(key) ?? 0).toBeCloseTo(memberSum.get(key)!, 5);
    }
  });

  it("is at most the members' sum for a super-module, and below it once flow runs between its submodules", () => {
    const supers = [...memberSum.keys()].filter((k) => !d.modulePaths.some(({ path }) => path.slice(0, -1).join(":") === k));
    expect(supers.length).toBeGreaterThan(0);
    let below = 0;
    for (const k of supers) {
      const own = d.moduleEnterExit.get(k) ?? 0;
      expect(own).toBeLessThanOrEqual(memberSum.get(k)! + 1e-6);
      if (own < memberSum.get(k)! - 1e-6) below++;
    }
    expect(below).toBeGreaterThan(0);
  });
});
