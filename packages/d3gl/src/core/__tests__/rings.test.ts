import { describe, it, expect } from "vitest";
import { signedArea, pointInRing, groupRings, type RingGroup } from "../rings.js";
import { tessellateFill } from "../tessellate.js";
import type { Subpath } from "../path-context.js";

const ccwSquare = (): Subpath => ({
  // counter-clockwise outer ring, area > 0
  points: [0, 0, 10, 0, 10, 10, 0, 10],
  closed: true,
});
const cwHole = (): Subpath => ({
  // clockwise inner ring (opposite winding), area < 0, inside the square
  points: [3, 3, 3, 7, 7, 7, 7, 3],
  closed: true,
});

describe("signedArea", () => {
  it("is positive for CCW and negative for CW rings", () => {
    expect(signedArea(ccwSquare().points)).toBeGreaterThan(0);
    expect(signedArea(cwHole().points)).toBeLessThan(0);
  });
  it("equals the geometric area magnitude (100 for a 10x10 square)", () => {
    expect(Math.abs(signedArea(ccwSquare().points))).toBeCloseTo(100, 6);
  });
});

describe("pointInRing", () => {
  it("detects inside and outside points", () => {
    const r = ccwSquare().points;
    expect(pointInRing(5, 5, r)).toBe(true);
    expect(pointInRing(15, 5, r)).toBe(false);
  });
});

describe("groupRings", () => {
  it("returns a single outer with no holes for one ring", () => {
    const groups = groupRings([ccwSquare()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.holes).toHaveLength(0);
  });

  it("assigns a contained, opposite-wound ring as a hole of its container", () => {
    const groups = groupRings([ccwSquare(), cwHole()]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.holes).toHaveLength(1);
    expect(groups[0]!.outer.points).toEqual(ccwSquare().points);
  });

  it("assigns two separate interior rings as two holes of the same outer", () => {
    // big outer 0..30, two disjoint interior holes
    const outer: Subpath = { points: [0, 0, 30, 0, 30, 30, 0, 30], closed: true };
    const hole1: Subpath = { points: [3, 3, 3, 9, 9, 9, 9, 3], closed: true };
    const hole2: Subpath = { points: [20, 20, 20, 26, 26, 26, 26, 20], closed: true };
    const groups = groupRings([outer, hole1, hole2]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.holes).toHaveLength(2);
  });

  it("keeps two disjoint rings as two separate outers", () => {
    const a = ccwSquare();
    const b: Subpath = { points: [20, 20, 30, 20, 30, 30, 20, 30], closed: true };
    const groups = groupRings([a, b]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.holes.length === 0)).toBe(true);
  });

  it("ignores open and degenerate subpaths", () => {
    const open: Subpath = { points: [0, 0, 10, 0, 10, 10], closed: false };
    const tiny: Subpath = { points: [0, 0, 1, 0], closed: true };
    expect(groupRings([open, tiny])).toHaveLength(0);
  });
});

// --- Multi-level nesting (#73) -------------------------------------------------------
//
// Axis-aligned square rings, all concentric on (50,50), each ring wound OPPOSITE to the
// one enclosing it — the GeoJSON convention (AGENTS.md "GeoJSON winding"): land CW,
// lake CCW, island CW, pond CCW. `sq` builds them in projected/screen coordinates, so
// `cw` here is the screen-space orientation; what matters is that successive levels
// alternate, exactly as `geoPath` emits an exterior ring and its holes.
const sq = (half: number, cw: boolean): Subpath => {
  const lo = 50 - half;
  const hi = 50 + half;
  const ccwPts = [lo, lo, hi, lo, hi, hi, lo, hi];
  const pts = cw ? [lo, lo, lo, hi, hi, hi, hi, lo] : ccwPts;
  return { points: pts, closed: true };
};

/** Total triangle area of a tessellation — the amount of ink the fill actually covers. */
const filledArea = (groups: RingGroup[]): number => {
  const fg = tessellateFill(
    groups.map((g) => g.outer),
    groups.map((g) => g.holes),
  );
  let sum = 0;
  for (let i = 0; i < fg.indices.length; i += 3) {
    const a = fg.indices[i] ?? 0, b = fg.indices[i + 1] ?? 0, c = fg.indices[i + 2] ?? 0;
    const ax = fg.vertices[2 * a] ?? 0, ay = fg.vertices[2 * a + 1] ?? 0;
    const bx = fg.vertices[2 * b] ?? 0, by = fg.vertices[2 * b + 1] ?? 0;
    const cx = fg.vertices[2 * c] ?? 0, cy = fg.vertices[2 * c + 1] ?? 0;
    sum += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
  return sum;
};

describe("groupRings — nested islands in lakes (#73)", () => {
  const land = sq(40, true);   // 80x80 solid   → 6400
  const lake = sq(30, false);  // 60x60 hole    → 3600
  const island = sq(20, true); // 40x40 solid   → 1600
  const pond = sq(10, false);  // 20x20 hole    →  400

  it("makes a depth-2 island its own outer, not a second hole of the land", () => {
    const groups = groupRings([land, lake, island]);
    expect(groups).toHaveLength(2);
    const [outerGroup, islandGroup] = groups;
    expect(outerGroup?.outer.points).toEqual(land.points);
    expect(outerGroup?.holes.map((h) => h.points)).toEqual([lake.points]);
    expect(islandGroup?.outer.points).toEqual(island.points);
    expect(islandGroup?.holes).toHaveLength(0);
  });

  it("fills land minus lake plus island (not land minus lake minus island)", () => {
    // Correct: 6400 - 3600 + 1600 = 4400. Single-level nesting gives 6400-3600-1600 = 1200.
    expect(filledArea(groupRings([land, lake, island]))).toBeCloseTo(4400, 6);
  });

  it("alternates solid/hole at depth 3 (pond inside the island)", () => {
    const groups = groupRings([land, lake, island, pond]);
    expect(groups).toHaveLength(2);
    expect(groups[1]?.outer.points).toEqual(island.points);
    expect(groups[1]?.holes.map((h) => h.points)).toEqual([pond.points]);
    // 6400 - 3600 + 1600 - 400 = 4000
    expect(filledArea(groups)).toBeCloseTo(4000, 6);
  });

  it("is independent of input order", () => {
    const shuffled = groupRings([island, land, pond, lake]);
    expect(filledArea(shuffled)).toBeCloseTo(4000, 6);
  });

  it("keeps a same-wound nested ring solid, matching the Canvas/SVG nonzero fill rule", () => {
    // Two nested rings with the SAME winding: nonzero (what ctx.fill() and <path> do)
    // leaves the interior solid; the inner ring is not a hole.
    const groups = groupRings([sq(40, true), sq(20, true)]);
    expect(filledArea(groups)).toBeCloseTo(6400, 6);
  });
});
