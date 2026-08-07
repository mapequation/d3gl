/**
 * #45 — the build-time curve bake and the tolerance that controls it.
 *
 * Curves are flattened ONCE, in world units; the view transform only scales the result. These
 * pin the arithmetic that makes `curveTolerance` meaningful (a facet of `t` world units is `t·k`
 * screen px at zoom `k`) and the seams that carry the tolerance. The engine-level wiring and the
 * pixel proof live in `map/curve-tolerance.browser.test.ts`; this file is the leg CI runs (the
 * node suite), so keep the deterministic signatures here.
 */
import { describe, it, expect } from "vitest";
import { Scene, DEFAULT_CURVE_TOLERANCE, pieToDrawables, instancedVectorLayers } from "../index.js";
import type { InstancedPieData } from "../backend.js";

/** Largest deviation between a closed polyline and the circle of radius `r` about (cx, cy). */
function maxSagitta(points: readonly number[], cx: number, cy: number, r: number): number {
  let worst = 0;
  for (let i = 0; i + 3 < points.length; i += 2) {
    // Mid-chord is the farthest point of a chord from the arc it subtends.
    const mx = (points[i]! + points[i + 2]!) / 2;
    const my = (points[i + 1]! + points[i + 3]!) / 2;
    worst = Math.max(worst, r - Math.hypot(mx - cx, my - cy));
  }
  return worst;
}

/** The single subpath a one-arc drawable records into a Scene group. */
function arcPolyline(tolerance: number, r: number): readonly number[] {
  const scene = new Scene(tolerance);
  scene.group("g", (g) => {
    g.drawable("a", (ctx) => {
      ctx.moveTo(r, 0);
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.closePath();
    });
  });
  const sp = scene.drawables("g")[0]?.subpaths[0];
  if (!sp) throw new Error("no subpath recorded");
  return sp.points;
}

const pie = (r: number): InstancedPieData => ({
  count: 1,
  centers: new Float32Array([0, 0]),
  radii: new Float32Array([r]),
  angles: new Float32Array([0, 1]),
  colors: new Uint8Array([0, 0, 0, 255]),
});

describe("#45 build-time curve bake", () => {
  it("the default tolerance is 0.25 world units", () => {
    expect(DEFAULT_CURVE_TOLERANCE).toBe(0.25);
  });

  it("a recorded arc stays within its tolerance — in WORLD units, which zoom scales", () => {
    const R = 11;
    const coarse = maxSagitta(arcPolyline(DEFAULT_CURVE_TOLERANCE, R), 0, 0, R);
    expect(coarse).toBeLessThanOrEqual(DEFAULT_CURVE_TOLERANCE);
    // The defect: the bake is in world units, so the on-screen facet grows with k. At the
    // website ancestral-ranges max zoom (40) the default bake is ~9.6px off a true circle.
    expect(coarse * 40).toBeGreaterThan(5);

    // The fix: declare the deepest zoom and the same arc is sub-pixel there.
    const fine = maxSagitta(arcPolyline(DEFAULT_CURVE_TOLERANCE / 40, R), 0, 0, R);
    expect(fine * 40).toBeLessThan(0.25);
  });

  it("segment count grows as 1/sqrt(tolerance), not 1/tolerance", () => {
    const R = 11;
    const at = (kMax: number): number => arcPolyline(DEFAULT_CURVE_TOLERANCE / kMax, R).length / 2;
    const base = at(1);
    // 100× finer must cost ~10×, not ~100× — the whole reason this is affordable at all.
    // (Measured: 15 → 148 vertices.)
    const ratio = at(100) / base;
    expect(ratio).toBeGreaterThan(7);
    expect(ratio).toBeLessThan(14);
  });

  it("the export converter bakes wedges at the tolerance it is given", () => {
    // Regression: `pieToDrawables`/`instancedVectorLayers` used to hard-code the default, so a
    // WebGL export of a network pie stayed faceted while its Canvas/SVG Scene twin refined.
    const coarse = pieToDrawables(pie(11), false)[0]?.subpaths[0]?.points.length ?? 0;
    const fine = pieToDrawables(pie(11), false, DEFAULT_CURVE_TOLERANCE / 40)[0]?.subpaths[0]?.points.length ?? 0;
    expect(coarse).toBeGreaterThan(0);
    expect(fine).toBeGreaterThan(coarse * 4);

    const layers = instancedVectorLayers(
      [{ name: "pies", primitive: "pie", pie: pie(11), sizeMode: "world" }],
      1,
      DEFAULT_CURVE_TOLERANCE / 40,
    );
    expect(layers[0]?.drawables[0]?.subpaths[0]?.points.length).toBe(fine);
  });
});
