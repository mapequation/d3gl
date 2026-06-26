// packages/d3gl/src/map/__tests__/points-lane.test.ts
import { describe, it, expect } from "vitest";
import { plotPointsCircles, declutterPointsStrategy } from "../points-lane.js";

const X = [0, 10, 20, 100];
const Y = [0, 0, 0, 0];
const xOf = (_d: number, i: number) => X[i]!;
const yOf = (_d: number, i: number) => Y[i]!;
// pointRadiusOf: world-space radius used for pick (screen radius = r * k)
const pointROf = (_d: number, _i: number) => 4;
// declutterPxOf: centre-to-centre exclusion distance; strategy passes this/2 to declutterScreen
// so two glyphs collide when dist < declutterPx (i.e. rᵢ + rⱼ = declutterPx/2 + declutterPx/2).
// Points at x=0,10,20 are 10–20px apart at k=1; declutterPx=22 → threshold=22 → both within → dropped.
const declutterPxOf = (_d: number, _i: number) => 22;
const data = [0, 1, 2, 3];

describe("plotPointsCircles (#108-C)", () => {
  it("gathers x/y/r/color into InstancedCirclesData for the given visible indices", () => {
    const c = plotPointsCircles(
      data,
      Uint32Array.from([0, 3]),
      xOf,
      yOf,
      pointROf,
      () => "#ff0000",
      2,
    );
    expect(c.count).toBe(2);
    expect(Array.from(c.centers)).toEqual([0, 0, 100, 0]);
    expect(Array.from(c.radii)).toEqual([4, 4]);
    // RGBA: #ff0000 → [255, 0, 0, 255]
    expect(Array.from(c.colors.slice(0, 4))).toEqual([255, 0, 0, 255]);
  });
});

describe("declutterPointsStrategy (#108-C)", () => {
  // world-sized strategy: pick hit radius scales with k (r × k). select is sizeMode-independent,
  // so the select cases below use this one regardless of the screenSized flag.
  const strat = declutterPointsStrategy(
    data,
    xOf,
    yOf,
    pointROf,
    declutterPxOf,
    undefined,
    900,
    450,
    false,
  );
  // screen-sized strategy: pick hit radius is constant px (r as-is, NOT × k).
  const stratScreen = declutterPointsStrategy(
    data,
    xOf,
    yOf,
    pointROf,
    declutterPxOf,
    undefined,
    900,
    450,
    true,
  );

  it("select drops points overlapping a higher-priority kept point (screen space)", () => {
    // k=1: points at x=0,10,20 have screen-space distances 10 and 20 — both < threshold=22
    // → points 1 and 2 are occluded by point 0. Point 3 at x=100 is far (dist=100 > 22) → kept.
    const vis = strat.select({ k: 1, x: 0, y: 0 }, 900, 450);
    expect(Array.from(vis)).toContain(0);
    expect(Array.from(vis)).toContain(3);
    expect(Array.from(vis)).not.toContain(1); // within exclusion of point 0
    expect(Array.from(vis)).not.toContain(2); // within exclusion of point 0
  });

  it("select returns more points as zoom separates them", () => {
    // k=10: screen positions are x=0,100,200,1000 — all > threshold=22 apart → all kept
    const vis = strat.select({ k: 10, x: 0, y: 0 }, 900, 450);
    expect(Array.from(vis).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("pick (world-sized): hit radius scales with zoom (r × k)", () => {
    const t = { k: 10, x: 0, y: 0 };
    const vis = strat.select(t, 900, 450); // all 4 kept at k=10
    // point 1: world x=10 → screen x=100; pointRadius=4, world-sized → screen radius=40; pick(100,0) → hit
    expect(strat.pick(100, 0, t, vis)).toBe(1);
    // pick at (50,0): dist=50 from point 1's centre (sx=100) > 40 → miss
    expect(strat.pick(50, 0, t, vis)).toBe(-1);
  });

  it("pick (screen-sized): hit radius is constant px (r as-is, NOT × k)", () => {
    const t = { k: 10, x: 0, y: 0 };
    const vis = stratScreen.select(t, 900, 450); // all 4 kept at k=10
    // point 1: world x=10 → screen x=100; pointRadius=4, screen-sized → hit radius=4px (NOT 40px)
    expect(stratScreen.pick(102, 0, t, vis)).toBe(1); // dist=2 ≤ 4 → hit
    expect(stratScreen.pick(106, 0, t, vis)).toBe(-1); // dist=6 > 4 → miss (would hit at 40px world radius)
  });
});
