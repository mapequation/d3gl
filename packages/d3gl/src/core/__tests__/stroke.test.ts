import { describe, it, expect } from "vitest";
import { expandStroke } from "../stroke.js";
import type { Subpath } from "../path-context.js";

describe("expandStroke", () => {
  it("expands a single open segment into one quad (4 verts, 6 indices)", () => {
    const sp: Subpath = { points: [0, 0, 10, 0], closed: false };
    const { vertices, indices } = expandStroke(sp, 2);
    expect(vertices.length / 2).toBe(4);
    expect(indices.length).toBe(6);
    // half-width 1, horizontal segment => offsets in y by ±1
    expect(vertices).toEqual([0, 1, 0, -1, 10, 1, 10, -1]);
  });

  it("offsets a vertical segment along x (perpendicular sign on the other axis)", () => {
    const sp: Subpath = { points: [0, 0, 0, 10], closed: false };
    const { vertices } = expandStroke(sp, 2);
    // dir (0,1) => normal (-1,0): offsets in x by ∓1
    expect(vertices).toEqual([-1, 0, 1, 0, -1, 10, 1, 10]);
  });

  it("skips a zero-length segment and its dead join without corrupting indices", () => {
    const sp: Subpath = { points: [0, 0, 0, 0, 10, 0], closed: false };
    const { vertices, indices } = expandStroke(sp, 2);
    // only the live segment (pt1->pt2) survives; the repeated-point join is skipped
    expect(indices.length).toBe(6);
    expect(vertices).toEqual([0, 1, 0, -1, 10, 1, 10, -1]);
    const vertexCount = vertices.length / 2;
    for (const i of indices) expect(i).toBeLessThan(vertexCount);
  });

  it("bevels interior corners by default (one outer-gap triangle, no inner overlap)", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 10, 10], closed: false };
    const { indices } = expandStroke(sp, 2); // default join is "bevel"
    // 2 segment quads (12) + 1 outer-gap bevel triangle (3) = 15. (No redundant inner triangle.)
    expect(indices.length).toBe(15);
  });

  it("miters an interior corner when join is 'miter' (outer miter, no bevel under it)", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 10, 10], closed: false };
    const { vertices, indices } = expandStroke(sp, 2, { join: "miter" });
    // 2 segment quads (12) + outer miter, 2 tris (6) = 18 — the miter replaces the bevel.
    expect(indices.length).toBe(18);
    const vertexCount = vertices.length / 2;
    for (const i of indices) expect(i).toBeLessThan(vertexCount);
  });

  it("miters all corners of a closed ring (no caps)", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 10, 10, 0, 10], closed: true };
    const { vertices, indices } = expandStroke(sp, 2, { join: "miter" });
    // 4 segment quads (24) + 4 outer miters × 6 = 48.
    expect(indices.length).toBe(48);
    const vertexCount = vertices.length / 2;
    for (const i of indices) expect(i).toBeLessThan(vertexCount);
  });

  it("rounds interior corners with an arc fan when join is 'round'", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 10, 10], closed: false };
    const round = expandStroke(sp, 2, { join: "round" });
    // 2 quads (12) + an arc fan (≥ 1 triangle) → more than the bevel's 15.
    expect(round.indices.length).toBeGreaterThan(15);
    const vertexCount = round.vertices.length / 2;
    for (const i of round.indices) expect(i).toBeLessThan(vertexCount);
  });

  it("falls back to bevel when the miter exceeds the miter limit (acute spike)", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 0, 1], closed: false }; // ~5° spike at (10,0)
    // join "miter", default limit 10: the acute miter is too long → bevel triangle (12 + 3 = 15).
    expect(expandStroke(sp, 2, { join: "miter" }).indices.length).toBe(15);
    // A generous limit admits the miter (12 + miter 6 = 18).
    expect(expandStroke(sp, 2, { join: "miter", miterLimit: 50 }).indices.length).toBe(18);
  });

  it("adds no cap geometry for butt caps (default), a quad for square", () => {
    const sp: Subpath = { points: [0, 0, 10, 0], closed: false };
    const butt = expandStroke(sp, 2); // one quad, 6 indices, butt
    expect(butt.indices.length).toBe(6);
    const square = expandStroke(sp, 2, { cap: "square" });
    // + a quad (2 tris) at each of the 2 ends = 12 more indices.
    expect(square.indices.length).toBe(6 + 12);
  });

  it("tessellates round caps into a fan at each open end", () => {
    const sp: Subpath = { points: [0, 0, 10, 0], closed: false };
    const round = expandStroke(sp, 2, { cap: "round" });
    expect(round.indices.length).toBeGreaterThan(6); // base quad + two fans
    const vertexCount = round.vertices.length / 2;
    for (const i of round.indices) expect(i).toBeLessThan(vertexCount);
  });

  it("adds no caps to a closed subpath (no ends)", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 10, 10, 0, 10], closed: true };
    expect(expandStroke(sp, 2, { cap: "round" }).indices.length).toBe(expandStroke(sp, 2).indices.length);
  });

  it("returns empty geometry for zero width or a single point", () => {
    expect(expandStroke({ points: [0, 0, 10, 0], closed: false }, 0).indices).toHaveLength(0);
    expect(expandStroke({ points: [0, 0], closed: false }, 2).indices).toHaveLength(0);
  });
});
