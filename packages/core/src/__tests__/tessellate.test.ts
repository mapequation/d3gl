import { describe, it, expect } from "vitest";
import { tessellateFill } from "../tessellate.js";
import type { Subpath } from "../path-context.js";

function square(): Subpath {
  return { points: [0, 0, 10, 0, 10, 10, 0, 10], closed: true };
}

describe("tessellateFill", () => {
  it("triangulates a square into 2 triangles (6 indices, 4 vertices)", () => {
    const { vertices, indices } = tessellateFill([square()]);
    expect(vertices).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
    expect(indices.length).toBe(6);
    // every index references a real vertex
    const vertexCount = vertices.length / 2;
    for (const i of indices) expect(i).toBeLessThan(vertexCount);
  });

  it("treats a polygon with a hole as outer ring + hole ring", () => {
    const outer: Subpath = { points: [0, 0, 10, 0, 10, 10, 0, 10], closed: true };
    const hole: Subpath = { points: [3, 3, 7, 3, 7, 7, 3, 7], closed: true };
    // Holes are signalled by winding; tessellateFill takes (outer, holes[]).
    const { indices } = tessellateFill([outer], [[hole]]);
    // A square-with-square-hole triangulates into 8 triangles = 24 indices.
    expect(indices.length).toBe(24);
  });

  it("offsets indices when given multiple independent polygons", () => {
    const a = square();
    const b: Subpath = { points: [20, 20, 30, 20, 30, 30, 20, 30], closed: true };
    const { vertices, indices } = tessellateFill([a, b]);
    expect(vertices.length / 2).toBe(8);
    // second polygon's indices must reference vertices 4..7
    expect(Math.max(...indices)).toBe(7);
  });

  it("ignores open subpaths (a fill needs a closed ring)", () => {
    const open: Subpath = { points: [0, 0, 10, 0, 10, 10], closed: false };
    const { indices } = tessellateFill([open]);
    expect(indices.length).toBe(0);
  });
});
