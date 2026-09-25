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
