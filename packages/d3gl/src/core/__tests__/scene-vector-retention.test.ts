import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";

/**
 * Semantics of the retained vector view (#280).
 *
 * `Scene.drawables(name)` hands out the SAME array (and the same element objects) until the
 * drawable set changes, instead of materializing a fresh `DrawableVector` per drawable on every
 * call. `DrawableVector` stores style as plain data, so the retention only holds up if a later
 * `setFill`/`setStroke`/`setFlag`/`writeDeclutterFlags` is re-applied to it. These pin exactly
 * that: identity is stable, and the values are never stale.
 *
 * The wall-clock/allocation side lives in `vector-view-perf.test.ts`.
 */
function twoRects(): Scene {
  const scene = new Scene();
  scene.group("g", (b) => {
    b.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10), { lineWidth: 2 });
    b.drawable("b", (ctx) => ctx.rect(20, 0, 10, 10));
  });
  return scene;
}

describe("Scene retained vector view (#280)", () => {
  it("returns the same array and the same drawable objects while nothing changes", () => {
    const scene = twoRects();
    const first = scene.drawables("g");
    const second = scene.drawables("g");
    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("re-applies a setFill/setStroke made AFTER the view was first read", () => {
    const scene = twoRects();
    const view = scene.drawables("g");
    expect(view[0]!.fill).toEqual([0, 0, 0, 0]); // default transparent

    scene.setFill("g", "a", "rgb(255, 0, 0)");
    scene.setStroke("g", "a", "rgba(0, 0, 255, 0.5)");
    const after = scene.drawables("g");

    expect(after).toBe(view); // same array — no re-materialization
    expect(after[0]).toBe(view[0]); // same object
    expect(after[0]!.fill).toEqual([255, 0, 0, 255]); // …carrying the new colour
    expect(after[0]!.stroke).toEqual([0, 0, 255, 128]);
    expect(after[1]!.fill).toEqual([0, 0, 0, 0]); // untouched drawable stays untouched
  });

  it("re-applies setFlag and writeDeclutterFlags", () => {
    const scene = new Scene();
    scene.group("g", (b) => {
      b.point("a", 0, 0, 2);
      b.point("b", 100, 0, 2);
    });
    const view = scene.drawables("g");
    expect(view.map((d) => d.flags)).toEqual([1, 1]);

    scene.setFlag("g", "b", 0);
    expect(scene.drawables("g")).toBe(view);
    expect(view.map((d) => d.flags)).toEqual([1, 0]);

    // Declutter writes the whole flags table in one pass (the per-frame path).
    const { groupOf } = scene.declutterIndex("g");
    const verdict = new Uint8Array(1 + Math.max(...groupOf)).fill(1);
    verdict[groupOf[0]!] = 0;
    scene.writeDeclutterFlags("g", verdict);
    expect(scene.drawables("g")).toBe(view);
    expect(view.map((d) => d.flags)).toEqual([0, 1]);
  });

  it("replaces the view when the drawable set changes (rebuild or append)", () => {
    const scene = twoRects();
    const view = scene.drawables("g");

    scene.appendToGroup("g", (b) => b.drawable("c", (ctx) => ctx.rect(40, 0, 10, 10)));
    const grown = scene.drawables("g");
    expect(grown).not.toBe(view);
    expect(grown.map((d) => d.id)).toEqual(["a", "b", "c"]);

    scene.group("g", (b) => b.drawable("z", (ctx) => ctx.rect(0, 0, 1, 1)));
    const rebuilt = scene.drawables("g");
    expect(rebuilt).not.toBe(grown);
    expect(rebuilt.map((d) => d.id)).toEqual(["z"]);
  });

  it("hands the append TAIL fresh objects, so a backend can own and grow its own array", () => {
    // CanvasBackend.appendToLayer pushes the tail into the array it already holds. That array is
    // the one this Scene handed it, so the Scene must NOT also grow it — it drops its reference
    // on append instead (see Scene.appendToGroup).
    const scene = twoRects();
    const before = scene.drawables("g");
    scene.appendToGroup("g", (b) => b.drawable("c", (ctx) => ctx.rect(40, 0, 10, 10)));

    const tail = scene.drawables("g", 2);
    expect(tail.map((d) => d.id)).toEqual(["c"]);
    expect(tail).not.toBe(before);
    // A backend growing its own retained array with the tail lands at the right length.
    expect([...before, ...tail].map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(scene.drawables("g").length).toBe(3);
  });

  it("retains buffers().pointCenters per drawable set and rebuilds it on append", () => {
    const scene = new Scene();
    scene.group("g", (b) => b.point("a", 1, 2, 3));
    const first = scene.buffers("g").pointCenters;
    expect(Array.from(first)).toEqual([1, 2, 3, 0]);
    expect(scene.buffers("g").pointCenters).toBe(first); // retained, not re-assembled

    scene.setFill("g", "a", "red"); // style can't stale a geometry-only array
    expect(scene.buffers("g").pointCenters).toBe(first);

    scene.appendToGroup("g", (b) => b.point("b", 4, 5, 6));
    const grown = scene.buffers("g").pointCenters;
    expect(grown).not.toBe(first);
    expect(Array.from(grown)).toEqual([1, 2, 3, 0, 4, 5, 6, 1]);
    // The append DELTA stays O(new) and independent of the retained full array.
    expect(Array.from(scene.appendedBuffers("g", 1).pointCenters)).toEqual([4, 5, 6, 1]);
  });
});
