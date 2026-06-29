import { describe, it, expect } from "vitest";
import { dimOthers } from "../selection-dim.js";

/** Build a `count`-instance RGBA buffer, all alpha 200. */
function colors(count: number): Uint8Array {
  const c = new Uint8Array(count * 4);
  for (let k = 0; k < count; k++) { c[k * 4] = 10; c[k * 4 + 1] = 20; c[k * 4 + 2] = 30; c[k * 4 + 3] = 200; }
  return c;
}

describe("dimOthers (#162 selection.others on instanced lanes)", () => {
  it("multiplies the alpha of non-kept instances and leaves kept ones full", () => {
    const c = colors(4);
    const kept = new Set([1, 3]);
    dimOthers(c, 4, 0.3, (k) => kept.has(k));
    // kept (1, 3) keep alpha 200; others (0, 2) → round(200 * 0.3) = 60.
    expect([c[3], c[7], c[11], c[15]]).toEqual([60, 200, 60, 200]);
    // RGB is untouched on every instance — only alpha changes.
    expect([c[0], c[1], c[2]]).toEqual([10, 20, 30]);
  });

  it("composes multiplicatively with a prior alpha (e.g. the LOD cross-fade)", () => {
    const c = colors(1);
    c[3] = 100; // a prior fade already halved this instance's alpha
    dimOthers(c, 1, 0.5, () => false); // not kept → another ×0.5
    expect(c[3]).toBe(50);
  });

  it("is a no-op when opacity >= 1 (nothing to dim)", () => {
    const c = colors(3);
    dimOthers(c, 3, 1, () => false);
    expect([c[3], c[7], c[11]]).toEqual([200, 200, 200]);
  });

  it("is a no-op when the colour buffer is absent (e.g. a layer without borders)", () => {
    expect(() => dimOthers(undefined, 5, 0.3, () => false)).not.toThrow();
  });

  it("touches exactly `count` instances — O(count), independent of any larger backing array", () => {
    // A scratch buffer sized for capacity N, but only `count` instances are live this frame.
    const N = 1000;
    const c = colors(N);
    let visited = 0;
    dimOthers(c, 8, 0.3, (k) => { visited++; return k % 2 === 0; });
    expect(visited).toBe(8); // the predicate runs once per live instance, never over the whole capacity
    // Instances >= count are untouched (still full alpha).
    expect(c[8 * 4 + 3]).toBe(200);
  });
});
