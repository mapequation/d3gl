import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";

/** A scene with two initial drawables, then two appended (a stroked rect + a 2-circle point). */
function build(): Scene {
  const s = new Scene();
  s.group("g", (b) => {
    b.drawable("a", (c) => c.rect(0, 0, 10, 10), { lineWidth: 1 });
    b.point("p", 5, 5, 2);
  });
  s.appendToGroup("g", (b) => {
    b.drawable("c", (c) => c.rect(20, 0, 10, 10), { lineWidth: 1 });
    b.points("q", [[30, 30], [40, 40]], 3);
  });
  return s;
}

describe("Scene.appendedBuffers", () => {
  it("returns the tail slices of the full buffers, with group-absolute indices", () => {
    const s = build();
    const full = s.buffers("g");
    const delta = s.appendedBuffers("g", 2); // drawables "c" (2) and "q" (3)
    const rc = s.range("g", "c"); // first appended drawable's offsets

    // Fill/stroke verts+indices equal the full buffers from drawable "c"'s offset.
    expect(Array.from(delta.fillVertices)).toEqual(Array.from(full.fillVertices.slice(rc.fill.vertexOffset * 3)));
    expect(Array.from(delta.fillIndices)).toEqual(Array.from(full.fillIndices.slice(rc.fill.indexOffset)));
    expect(Array.from(delta.strokeVertices)).toEqual(Array.from(full.strokeVertices.slice(rc.stroke.vertexOffset * 3)));
    expect(Array.from(delta.strokeIndices)).toEqual(Array.from(full.strokeIndices.slice(rc.stroke.indexOffset)));
    expect(Array.from(delta.fillAnchors)).toEqual(Array.from(full.fillAnchors.slice(rc.fill.vertexOffset * 2)));

    // Per-drawable tables: only the 2 appended drawables.
    expect(delta.fillColors.length).toBe(2 * 4);
    expect(delta.strokeColors.length).toBe(2 * 4);
    expect(delta.flags.length).toBe(2);

    // Point centers: only "q"'s 2 circles, drawableId = its absolute group index (3).
    expect(delta.pointCenters.length).toBe(2 * 4);
    expect(Array.from(delta.pointCenters.slice(0, 4))).toEqual([30, 30, 3, 3]);
    expect(Array.from(delta.pointCenters.slice(4, 8))).toEqual([40, 40, 3, 3]);

    expect(delta.drawableCount).toBe(4);
    expect(delta.fromDrawable).toBe(2);
  });

  it("from=0 returns the whole group (matches buffers())", () => {
    const s = build();
    const full = s.buffers("g");
    const delta = s.appendedBuffers("g", 0);
    expect(Array.from(delta.fillVertices)).toEqual(Array.from(full.fillVertices));
    expect(Array.from(delta.fillIndices)).toEqual(Array.from(full.fillIndices));
    expect(Array.from(delta.pointCenters)).toEqual(Array.from(full.pointCenters));
    expect(delta.flags.length).toBe(full.drawableCount);
  });

  it("yields an empty delta when fromDrawable >= drawableCount", () => {
    const s = build();
    const delta = s.appendedBuffers("g", 4);
    expect(delta.fillVertices.length).toBe(0);
    expect(delta.fillIndices.length).toBe(0);
    expect(delta.pointCenters.length).toBe(0);
    expect(delta.flags.length).toBe(0);
    expect(delta.drawableCount).toBe(4);
  });

  it("appended-tail colors reflect setFill on appended drawables", () => {
    const s = build();
    s.setFill("g", "q", "rgb(0,255,0)");
    const delta = s.appendedBuffers("g", 2);
    // "q" is the 2nd appended drawable → fillColors bytes [4..8).
    expect(Array.from(delta.fillColors.slice(4, 8))).toEqual([0, 255, 0, 255]);
  });
});
