import { describe, it, expect } from "vitest";
import { instancedVectorLayers } from "../instanced-vector.js";
import type { InstancedLayer } from "../backend.js";

// #200: the GPU-instanced lanes have no retained Scene, so toSVG() on WebGL needs a vector view of
// the SoA the lane emitted. These are the conversions the export-only stash serializes.
describe("instancedVectorLayers (#200)", () => {
  it("circles: one <circle>-shaped drawable per instance, carrying the instance colour", () => {
    const layer: InstancedLayer = {
      name: "nodes",
      primitive: "circles",
      circles: {
        centers: Float32Array.from([10, 20, 30, 40]),
        radii: Float32Array.from([5, 7]),
        colors: Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 128]),
        count: 2,
      },
    };
    const [out] = instancedVectorLayers([layer], 1);
    expect(out?.name).toBe("nodes");
    expect(out?.drawables).toHaveLength(2);
    expect(out?.drawables[0]?.circles).toEqual([{ x: 10, y: 20, r: 5 }]);
    expect(out?.drawables[0]?.fill).toEqual([255, 0, 0, 255]);
    expect(out?.drawables[1]?.circles).toEqual([{ x: 30, y: 40, r: 7 }]);
    expect(out?.drawables[1]?.fill).toEqual([0, 0, 255, 128]);
    expect(out?.drawables[0]?.lineWidth).toBe(0); // no border ⇒ a plain filled disc
    expect(out?.drawables.every((d) => (d.flags & 1) !== 0)).toBe(true); // the emitted set IS the visible set
  });

  it("circles with a border ring: stroked on the ring centreline, so the annulus lands on [r(1-b), r]", () => {
    const layer: InstancedLayer = {
      name: "nodes",
      primitive: "circles",
      circles: {
        centers: Float32Array.from([0, 0]),
        radii: Float32Array.from([10]),
        colors: Uint8Array.from([1, 2, 3, 255]),
        borders: Float32Array.from([0.4]), // ring = 40% of the radius
        borderColors: Uint8Array.from([9, 8, 7, 255]),
        count: 1,
      },
    };
    const d = instancedVectorLayers([layer], 1)[0]?.drawables[0];
    expect(d?.circles[0]?.r).toBeCloseTo(8, 5); // centreline r·(1 − b/2)
    expect(d?.lineWidth).toBeCloseTo(4, 5); // r·b — outer edge 8+2 = 10, inner edge 8−2 = 6 = r·(1−b)
    expect(d?.stroke).toEqual([9, 8, 7, 255]);
    expect(d?.fill).toEqual([1, 2, 3, 255]);
  });

  it("a transparent-fill ring (the LOD aggregate halo) stays a ring, not a filled disc", () => {
    const layer: InstancedLayer = {
      name: "node-halos",
      primitive: "circles",
      circles: {
        centers: Float32Array.from([0, 0]),
        radii: Float32Array.from([20]),
        colors: new Uint8Array(4), // alpha 0 — the halo has no fill
        borders: Float32Array.from([0.1]),
        borderColors: Uint8Array.from([58, 63, 82, 255]),
        count: 1,
      },
    };
    const d = instancedVectorLayers([layer], 1)[0]?.drawables[0];
    expect(d?.fill[3]).toBe(0); // serializes as fill="none"
    expect(d?.stroke).toEqual([58, 63, 82, 255]);
    expect(d?.lineWidth).toBeCloseTo(2, 5);
  });

  it("lines: a stroked segment per link, bowing into a quadratic when bent", () => {
    const base = {
      sources: Float32Array.from([0, 0, 0, 0]),
      targets: Float32Array.from([10, 0, 10, 0]),
      widths: Float32Array.from([2, 2]),
      colors: new Uint8Array(8).fill(255),
      count: 2,
    };
    const straight = instancedVectorLayers([{ name: "links", primitive: "lines", lines: base }], 1)[0];
    expect(straight?.drawables[0]?.subpaths[0]?.points).toEqual([0, 0, 10, 0]);
    expect(straight?.drawables[0]?.lineWidth).toBe(2);

    const bent = instancedVectorLayers(
      [{ name: "links", primitive: "lines", lines: { ...base, bends: Float32Array.from([0.2, 0]) } }],
      1,
    )[0];
    const pts = bent?.drawables[0]?.subpaths[0]?.points ?? [];
    expect(pts.length).toBeGreaterThan(4); // flattened curve, not a two-point segment
    expect(Math.max(...pts.filter((_, i) => i % 2 === 1))).toBeGreaterThan(0); // bowed off the chord
    expect(bent?.drawables[1]?.subpaths[0]?.points).toEqual([0, 0, 10, 0]); // bend 0 stays straight
  });

  it("arrows (#542): ONE filled outline per whole arrow, shaft to the head's base then barb, tip, barb", () => {
    const arrows = {
      sources: Float32Array.from([0, 0]),
      targets: Float32Array.from([100, 0]),
      widths: Float32Array.from([4]),
      colors: Uint8Array.from([0, 0, 0, 128]),
      radii: Float32Array.from([10]),
      arrowSize: 5, // head length 10; half-width 4/2 + 2·√4 = 6
      count: 1,
    };
    const close = (got: readonly number[] | undefined, want: number[]): void => {
      expect(got?.length).toBeGreaterThanOrEqual(want.length);
      want.forEach((v, i) => expect(got?.[i] ?? NaN).toBeCloseTo(v, 5));
    };
    const world = instancedVectorLayers([{ name: "links", primitive: "arrows", arrows }], 3)[0];
    const d = world?.drawables[0];
    expect(world?.sizeMode).toBeUndefined();
    expect(d?.fill).toEqual([0, 0, 0, 128]);
    expect(d?.lineWidth ?? 0).toBe(0); // filled, not stroked: a translucent arrow blends once
    expect(d?.subpaths).toHaveLength(1);
    // shaft left edge (0,2)→(80,2) ends ON the base, inside the barb; left barb, tip = target − radius, right barb, back.
    close(d?.subpaths[0]?.points, [0, 2, 80, 2, 80, 6, 90, 0, 80, -6, 80, -2, 0, -2]);

    // Screen sizeMode: solved in px at k = 2 and emitted ÷k as world coordinates.
    const screen = instancedVectorLayers([{ name: "links", primitive: "arrows", sizeMode: "screen", arrows }], 2)[0];
    expect(screen?.sizeMode).toBe("world");
    close(screen?.drawables[0]?.subpaths[0]?.points, [0, 1, 90, 1, 90, 3, 95, 0, 90, -3, 90, -1, 0, -1]);

    // Bent: still one outline whose tip sits `radius` from the target along the curve's end tangent.
    const bent = instancedVectorLayers([{ name: "links", primitive: "arrows", arrows: { ...arrows, bends: Float32Array.from([0.2]), samples: 8 } }], 1)[0];
    const pts = bent?.drawables[0]?.subpaths[0]?.points ?? [];
    expect(pts.length).toBeGreaterThanOrEqual(2 * (2 * 8 + 3));
    const tip = 8 + 1; // points 0…7 left edge, 8 left barb, 9 tip
    expect(Math.hypot((pts[2 * tip] ?? 0) - 100, pts[2 * tip + 1] ?? 0)).toBeCloseTo(10, 5);
  });

  it("pie: a filled arc sector per wedge, anchored in screen sizeMode", () => {
    const pie = {
      centers: Float32Array.from([5, 5, 5, 5]),
      radii: Float32Array.from([10, 10]),
      angles: Float32Array.from([0, 0.5, 0.5, 1]),
      colors: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]),
      count: 2,
    };
    const out = instancedVectorLayers([{ name: "pie", primitive: "pie", sizeMode: "screen", pie }], 2)[0];
    expect(out?.sizeMode).toBe("screen"); // circles/pies place at a projected anchor, no bake needed
    expect(out?.drawables).toHaveLength(2);
    expect(out?.drawables[0]?.anchor).toEqual([5, 5]);
    expect(out?.drawables[0]?.subpaths[0]?.closed).toBe(true);
    expect(out?.drawables[1]?.fill).toEqual([0, 255, 0, 255]);
  });

  it("half-arrows: one filled map-glyph shape per link", () => {
    const halfArrows = {
      sources: Float32Array.from([0, 0]),
      targets: Float32Array.from([200, 0]),
      radii: Float32Array.from([20, 30]),
      widths: Float32Array.from([10, 10]),
      bends: Float32Array.from([30]),
      colors: Uint8Array.from([17, 34, 51, 255]),
      count: 1,
    };
    const out = instancedVectorLayers([{ name: "links", primitive: "half-arrows", halfArrows }], 1)[0];
    expect(out?.drawables).toHaveLength(1);
    expect(out?.drawables[0]?.fill).toEqual([17, 34, 51, 255]);
    expect(out?.drawables[0]?.subpaths[0]?.points.length).toBeGreaterThan(8); // a traced shape, not a stub
    expect(out?.drawables[0]?.lineWidth).toBe(0); // filled, never stroked
  });

  it("keeps the lane's emit order — the draw order the GPU used", () => {
    const circles = { centers: new Float32Array(2), radii: Float32Array.from([1]), colors: new Uint8Array(4), count: 1 };
    const lines = { sources: new Float32Array(2), targets: new Float32Array(2), widths: Float32Array.from([1]), colors: new Uint8Array(4), count: 1 };
    const out = instancedVectorLayers(
      [
        { name: "links", primitive: "lines", lines },
        { name: "nodes", primitive: "circles", circles },
      ],
      1,
    );
    expect(out.map((l) => l.name)).toEqual(["links", "nodes"]);
  });
});
