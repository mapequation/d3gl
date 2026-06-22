import { describe, it, expect } from "vitest";
import { buildGraph } from "../graph.js";
import { linkLines, linkArrows, bezierControl, bentEndTangent } from "../glyphs.js";

describe("bent-link geometry helpers", () => {
  it("bezierControl offsets the chord midpoint ⟂ by bend·|chord| (and sits on the chord when straight)", () => {
    // chord (0,0)→(10,0): ⟂(10,0) = (0,10); control = midpoint (5,0) + (0,10)·0.2 = (5,2).
    expect(bezierControl(0, 0, 10, 0, 0.2)).toEqual([5, 2]);
    expect(bezierControl(0, 0, 10, 0, 0)).toEqual([5, 0]);
  });

  it("bentEndTangent is the chord direction when straight, and rotates toward the bend otherwise", () => {
    expect(bentEndTangent(0, 0, 10, 0, 0)).toEqual([1, 0]);
    // endTan = (0.5·10 + 0·0.2, 0.5·0 − 10·0.2) = (5, −2), normalised.
    const [ux, uy] = bentEndTangent(0, 0, 10, 0, 0.2);
    const n = Math.hypot(5, -2);
    expect(ux).toBeCloseTo(5 / n);
    expect(uy).toBeCloseTo(-2 / n);
  });
});

describe("linkLines bend", () => {
  it("adds a per-line bend and raises the strip sample count when bent", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    g.positions.set([0, 0, 10, 0]);
    const d = linkLines(g, { widthOf: () => 1, colorOf: () => [153, 153, 153, 255], bend: 0.2 });
    expect(d.bends).toHaveLength(1);
    expect(d.bends![0]).toBeCloseTo(0.2, 6); // Float32 storage
    expect(d.samples).toBeGreaterThan(2);
  });

  it("omits bends/samples for straight links (unchanged at scale)", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
    const d = linkLines(g, { widthOf: () => 1, colorOf: () => [153, 153, 153, 255] });
    expect(d.bends).toBeUndefined();
    expect(d.samples).toBeUndefined();
  });
});

describe("linkArrows bend", () => {
  it("sets the tip back along the bent end-tangent and flags a per-arrow bend + half head", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: true });
    g.positions.set([0, 0, 10, 0]);
    const d = linkArrows(g, { size: 3, nodeRadii: new Float32Array([2, 2]), colorOf: () => [153, 153, 153, 255], bend: 0.2, half: true });
    expect(d.half).toBe(true);
    expect(d.bends![0]).toBeCloseTo(0.2, 6); // Float32 storage
    const [ux, uy] = bentEndTangent(0, 0, 10, 0, 0.2);
    expect(d.targets[0]).toBeCloseTo(10 - ux * 2); // tip set back by target radius along the tangent
    expect(d.targets[1]).toBeCloseTo(0 - uy * 2);
  });

  it("matches the straight arrow when bend=0 (tip set back along the chord)", () => {
    const g = buildGraph({ nodeCount: 2, source: [0], target: [1], directed: true });
    g.positions.set([0, 0, 10, 0]);
    const d = linkArrows(g, { size: 3, nodeRadii: new Float32Array([2, 2]), colorOf: () => [153, 153, 153, 255] });
    expect(d.bends).toBeUndefined();
    expect(d.half).toBeUndefined();
    expect(d.targets[0]).toBeCloseTo(8); // 10 − radius 2
    expect(d.targets[1]).toBeCloseTo(0);
  });
});
