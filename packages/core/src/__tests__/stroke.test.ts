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

  it("adds a bevel join at an interior corner of an open polyline", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 10, 10], closed: false };
    const { vertices, indices } = expandStroke(sp, 2);
    // 2 segment quads (12 indices) + 1 bevel joint (6 indices) = 18
    expect(indices.length).toBe(18);
    const vertexCount = vertices.length / 2;
    for (const i of indices) expect(i).toBeLessThan(vertexCount);
  });

  it("joins all corners of a closed ring (no caps)", () => {
    const sp: Subpath = { points: [0, 0, 10, 0, 10, 10, 0, 10], closed: true };
    const { vertices, indices } = expandStroke(sp, 2);
    // 4 segment quads (24 indices) + 4 bevel joints (24 indices) = 48
    expect(indices.length).toBe(48);
    const vertexCount = vertices.length / 2;
    for (const i of indices) expect(i).toBeLessThan(vertexCount);
  });

  it("returns empty geometry for zero width or a single point", () => {
    expect(expandStroke({ points: [0, 0, 10, 0], closed: false }, 0).indices).toHaveLength(0);
    expect(expandStroke({ points: [0, 0], closed: false }, 2).indices).toHaveLength(0);
  });
});
