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
import { Scene, DEFAULT_CURVE_TOLERANCE, anchoredCurveTolerance, pieToDrawables, instancedVectorLayers } from "../index.js";
import type { GroupBuilder, GroupOptions } from "../index.js";
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

/** A full-circle arc of radius `r` about (cx, cy), optionally anchored at its centre. */
function circle(g: GroupBuilder, id: string, r: number, anchored: boolean): void {
  g.drawable(
    id,
    (ctx) => {
      ctx.moveTo(r, 0);
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.closePath();
    },
    anchored ? { anchor: [0, 0] } : undefined,
  );
}

/** Recorded vertex count of each drawable of group "g", by id. */
function vertexCounts(scene: Scene, name = "g"): Map<string | number, number> {
  return new Map(scene.drawables(name).map((d) => [d.id, d.subpaths.reduce((n, s) => n + s.points.length / 2, 0)]));
}

/** Build group "g" (one anchored + one unanchored arc) in a Scene of `tolerance`. */
function mixedGroup(tolerance: number, opts?: GroupOptions): Map<string | number, number> {
  const scene = new Scene(tolerance);
  scene.group(
    "g",
    (g) => {
      circle(g, "anchored", 8, true);
      circle(g, "plain", 8, false);
    },
    opts,
  );
  return vertexCounts(scene);
}

describe("#283 anchored screen glyphs bake at a pixel tolerance, not the world one", () => {
  const FINE = DEFAULT_CURVE_TOLERANCE / 40;

  it("anchoredCurveTolerance floors a screen glyph at the default and leaves world geometry alone", () => {
    // Screen: the recorded offsets ARE pixels, so anything finer than the default's 0.25px
    // sagitta is invisible — floored, never refined.
    expect(anchoredCurveTolerance(FINE, true)).toBe(DEFAULT_CURVE_TOLERANCE);
    expect(anchoredCurveTolerance(DEFAULT_CURVE_TOLERANCE, true)).toBe(DEFAULT_CURVE_TOLERANCE);
    // World: the anchor is ignored and the drawable is world-scaled — it keeps the fine bake.
    expect(anchoredCurveTolerance(FINE, false)).toBe(FINE);
    // A COARSER setting still coarsens glyphs (a floor, not a replacement): the exemption can
    // never record more vertices than the plain tolerance would.
    expect(anchoredCurveTolerance(1, true)).toBe(1);
    expect(anchoredCurveTolerance(1, false)).toBe(1);
  });

  it("a group's anchoredTolerance governs ONLY its anchored drawables", () => {
    const base = mixedGroup(DEFAULT_CURVE_TOLERANCE);
    const exempt = mixedGroup(FINE, { anchoredTolerance: DEFAULT_CURVE_TOLERANCE });
    // The acceptance criterion at the Scene seam: same count as the default bake…
    expect(exempt.get("anchored")).toBe(base.get("anchored"));
    // …while an unanchored drawable in the SAME group (world-scaled geometry, even in a screen
    // layer) still refines, as 1/sqrt(tolerance) → ~6.3× at 0.25/40.
    expect(exempt.get("plain")).toBeGreaterThan((base.get("plain") ?? 0) * 4);
  });

  it("omitting the group option bakes exactly as before (anchored or not)", () => {
    const plain = mixedGroup(FINE);
    const explicit = mixedGroup(FINE, { anchoredTolerance: FINE });
    expect(plain).toEqual(explicit);
    expect(plain.get("anchored")).toBe(plain.get("plain"));
  });

  it("appendToGroup keeps the group's anchored tolerance", () => {
    const scene = new Scene(FINE);
    scene.group("g", (g) => circle(g, "first", 8, true), { anchoredTolerance: DEFAULT_CURVE_TOLERANCE });
    scene.appendToGroup("g", (g) => {
      circle(g, "appended", 8, true);
      circle(g, "appended-plain", 8, false);
    });
    const counts = vertexCounts(scene);
    const base = mixedGroup(DEFAULT_CURVE_TOLERANCE);
    expect(counts.get("first")).toBe(base.get("anchored"));
    expect(counts.get("appended")).toBe(base.get("anchored"));
    expect(counts.get("appended-plain")).toBeGreaterThan((base.get("plain") ?? 0) * 4);
  });

  it("the WebGL pie export floors screen wedges exactly as the Scene does", () => {
    // `pieToDrawables` is the export twin of a Scene pie: a screen wedge is an anchored glyph
    // there too, so it must take the same exemption or the WebGL and Canvas/SVG exports of one
    // network pie diverge (the #45 "same tolerance on both paths" invariant).
    const base = pieToDrawables(pie(11), true)[0]?.subpaths[0]?.points.length ?? 0;
    expect(base).toBeGreaterThan(0);
    expect(pieToDrawables(pie(11), true, FINE)[0]?.subpaths[0]?.points.length).toBe(base);
    // World-mode wedges are world-scaled: they refine.
    expect(pieToDrawables(pie(11), false, FINE)[0]?.subpaths[0]?.points.length ?? 0).toBeGreaterThan(base * 4);

    const layers = instancedVectorLayers([{ name: "pies", primitive: "pie", pie: pie(11), sizeMode: "screen" }], 1, FINE);
    expect(layers[0]?.drawables[0]?.subpaths[0]?.points.length).toBe(base);
  });
});
