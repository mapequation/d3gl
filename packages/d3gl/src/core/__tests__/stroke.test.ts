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

  it("miters an interior corner of an open polyline (bevel + miter apex)", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 10, 10], closed: false };
    const { vertices, indices } = expandStroke(sp, 2); // default join "miter"
    // 2 segment quads (12) + 1 join: inner bevel (6) + outer miter, 2 tris (6) = 24
    expect(indices.length).toBe(24);
    const vertexCount = vertices.length / 2;
    for (const i of indices) expect(i).toBeLessThan(vertexCount);
  });

  it("bevels interior corners when join is 'bevel' (no miter apex)", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 10, 10], closed: false };
    const { indices } = expandStroke(sp, 2, { join: "bevel" });
    // 2 segment quads (12) + 1 bevel joint (6) = 18
    expect(indices.length).toBe(18);
  });

  it("miters all corners of a closed ring (no caps)", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 10, 10, 0, 10], closed: true };
    const { vertices, indices } = expandStroke(sp, 2);
    // 4 segment quads (24) + 4 joins × (bevel 6 + miter 6) = 72
    expect(indices.length).toBe(72);
    const vertexCount = vertices.length / 2;
    for (const i of indices) expect(i).toBeLessThan(vertexCount);
  });

  it("falls back to bevel when the miter exceeds the miter limit (acute spike)", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 0, 1], closed: false }; // ~5° spike at (10,0)
    // Default limit 10: the acute miter is too long → bevel only (12 + 6 = 18).
    expect(expandStroke(sp, 2).indices.length).toBe(18);
    // A generous limit admits the miter apex (12 + bevel 6 + miter 6 = 24).
    expect(expandStroke(sp, 2, { miterLimit: 50 }).indices.length).toBe(24);
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
