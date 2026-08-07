import { describe, it, expect } from "vitest";
import { PathRecorder } from "../path-recorder.js";
import { flattenArcTo, DEFAULT_CURVE_TOLERANCE } from "../flatten.js";
import { SvgPathContext } from "../../svg/svg-context.js";

/**
 * `arcTo` tangent-arc flattening (#86). The reference is the Canvas-2D
 * `arcTo(x1, y1, x2, y2, radius)` algorithm: line to the tangent point on the
 * incoming segment, then the shortest arc of the circle tangent to BOTH
 * half-infinite lines, ending on the outgoing segment.
 *
 * The pixel-level comparison against the browser's own `arcTo` lives in
 * `core/arc-to.browser.test.ts`; this file pins the geometry and the degenerate
 * branches without a DOM.
 */

/** Points of the recorder's single subpath, as [x, y] pairs. */
function pairs(pts: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i += 2) out.push([pts[i] ?? NaN, pts[i + 1] ?? NaN]);
  return out;
}

/** Flatten one arcTo in isolation (start point excluded, end point included). */
function arcToPoints(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  radius: number,
  tolerance = DEFAULT_CURVE_TOLERANCE,
): [number, number][] {
  const out: number[] = [];
  flattenArcTo(x0, y0, x1, y1, x2, y2, radius, tolerance, out);
  return pairs(out);
}

/** Parse an SvgPathContext `d` string of M/L commands back into points. */
function pointsOfD(d: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) out.push([Number(m[1]), Number(m[2])]);
  return out;
}

/** A rounded rectangle traced the CSS way: moveTo a straight edge, arcTo each corner. */
function roundedRect(ctx: PathRecorder | SvgPathContext, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

describe("flattenArcTo — Canvas-2D tangent-arc semantics", () => {
  it("starts at the tangent point on the incoming segment and ends on the outgoing one", () => {
    // Corner (100,0) between the segments (20,0)->(100,0) and (100,0)->(100,100).
    // A 90° corner has tangent distance r / tan(45°) = r, so the tangent points are
    // (80,0) and (100,20) and the arc centre is (80,20).
    const pts = arcToPoints(20, 0, 100, 0, 100, 100, 20);
    expect(pts.length).toBeGreaterThan(2);
    expect(pts[0]?.[0]).toBeCloseTo(80, 9);
    expect(pts[0]?.[1]).toBeCloseTo(0, 9);
    expect(pts.at(-1)?.[0]).toBeCloseTo(100, 9);
    expect(pts.at(-1)?.[1]).toBeCloseTo(20, 9);
  });

  it("keeps every emitted point on the tangent circle", () => {
    const pts = arcToPoints(20, 0, 100, 0, 100, 100, 20);
    for (const [x, y] of pts) expect(Math.hypot(x - 80, y - 20)).toBeCloseTo(20, 6);
  });

  it("turns the short way (the arc stays inside the corner)", () => {
    // The 90° corner's arc spans a quarter turn: no point may pass beyond the tangent
    // points' bounding box, which is what a wrong sweep direction (270°) would do.
    for (const [x, y] of arcToPoints(20, 0, 100, 0, 100, 100, 20)) {
      expect(x).toBeGreaterThanOrEqual(80 - 1e-9);
      expect(x).toBeLessThanOrEqual(100 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(0 - 1e-9);
      expect(y).toBeLessThanOrEqual(20 + 1e-9);
    }
  });

  it("mirrors the sweep for a corner that turns the other way", () => {
    // Same corner, traversed from the other side: (100,100)->(100,0)->(20,0).
    const pts = arcToPoints(100, 100, 100, 0, 20, 0, 20);
    expect(pts[0]?.[0]).toBeCloseTo(100, 9);
    expect(pts[0]?.[1]).toBeCloseTo(20, 9);
    expect(pts.at(-1)?.[0]).toBeCloseTo(80, 9);
    expect(pts.at(-1)?.[1]).toBeCloseTo(0, 9);
    for (const [x, y] of pts) expect(Math.hypot(x - 80, y - 20)).toBeCloseTo(20, 6);
  });

  it("places the tangent points at r/tan(θ/2) for a non-right corner", () => {
    // 60° corner at the origin between (1,0) and (cos60°, sin60°).
    const r = 3;
    const theta = Math.PI / 3;
    const d = r / Math.tan(theta / 2);
    const pts = arcToPoints(10, 0, 0, 0, 10 * Math.cos(theta), 10 * Math.sin(theta), r);
    expect(pts[0]?.[0]).toBeCloseTo(d, 9);
    expect(pts[0]?.[1]).toBeCloseTo(0, 9);
    expect(pts.at(-1)?.[0]).toBeCloseTo(d * Math.cos(theta), 9);
    expect(pts.at(-1)?.[1]).toBeCloseTo(d * Math.sin(theta), 9);
  });

  it("honours the flattening tolerance (finer tolerance => more, closer points)", () => {
    const coarse = arcToPoints(20, 0, 100, 0, 100, 100, 20, 1);
    const fine = arcToPoints(20, 0, 100, 0, 100, 100, 20, 0.01);
    expect(fine.length).toBeGreaterThan(coarse.length);
    // Sagitta of each chord must stay inside the tolerance: r - sqrt(r^2 - (chord/2)^2).
    for (const [pts, tol] of [[coarse, 1], [fine, 0.01]] as const) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1] ?? [0, 0];
        const b = pts[i] ?? [0, 0];
        const half = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
        expect(20 - Math.sqrt(Math.max(0, 400 - half * half))).toBeLessThanOrEqual(tol + 1e-9);
      }
    }
  });

  it("collapses to a line at the corner for r=0, collinear and coincident points", () => {
    expect(arcToPoints(20, 0, 100, 0, 100, 100, 0)).toEqual([[100, 0]]);
    expect(arcToPoints(0, 0, 50, 0, 100, 0, 20)).toEqual([[50, 0]]); // collinear
    expect(arcToPoints(100, 0, 100, 0, 100, 100, 20)).toEqual([[100, 0]]); // p0 == p1
    expect(arcToPoints(20, 0, 100, 0, 100, 0, 20)).toEqual([[100, 0]]); // p1 == p2
  });

  it("throws on a negative radius and no-ops on non-finite arguments", () => {
    expect(() => arcToPoints(20, 0, 100, 0, 100, 100, -1)).toThrow(/radius/);
    expect(arcToPoints(20, 0, NaN, 0, 100, 100, 20)).toEqual([]);
    expect(arcToPoints(20, 0, Infinity, 0, 100, 100, 20)).toEqual([]);
  });
});

describe("PathRecorder.arcTo", () => {
  it("records a tangent arc instead of throwing (#86)", () => {
    const r = new PathRecorder();
    r.moveTo(20, 0);
    r.arcTo(100, 0, 100, 100, 20);
    const pts = pairs(r.subpaths[0]?.points ?? []);
    expect(pts[0]).toEqual([20, 0]);
    expect(pts[1]?.[0]).toBeCloseTo(80, 9);
    expect(pts.at(-1)?.[0]).toBeCloseTo(100, 9);
    expect(pts.at(-1)?.[1]).toBeCloseTo(20, 9);
  });

  it("traces a rounded rectangle whose corners stay within the box", () => {
    const r = new PathRecorder();
    roundedRect(r, 10, 10, 80, 60, 12);
    const sp = r.subpaths[0];
    expect(sp?.closed).toBe(true);
    const pts = pairs(sp?.points ?? []);
    expect(pts.length).toBeGreaterThan(20);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(x).toBeLessThanOrEqual(90 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(y).toBeLessThanOrEqual(70 + 1e-6);
    }
    // The corners are rounded, so no vertex may sit in the 12px corner squares.
    for (const [x, y] of pts) {
      const inCornerBox = (x < 10 + 12 - 1e-6 || x > 90 - 12 + 1e-6) && (y < 10 + 12 - 1e-6 || y > 70 - 12 + 1e-6);
      if (inCornerBox) {
        const cx = x < 50 ? 22 : 78;
        const cy = y < 40 ? 22 : 58;
        expect(Math.hypot(x - cx, y - cy)).toBeLessThanOrEqual(12 + 1e-6);
      }
    }
  });

  it("seeds a subpath at (x1, y1) when there is no current point", () => {
    const r = new PathRecorder();
    r.arcTo(10, 20, 30, 40, 5);
    expect(r.subpaths).toHaveLength(1);
    expect(r.subpaths[0]?.points).toEqual([10, 20]);
  });

  it("bakes translate() into the arc", () => {
    const a = new PathRecorder();
    a.moveTo(20, 0);
    a.arcTo(100, 0, 100, 100, 20);
    const b = new PathRecorder();
    b.translate(100, 50);
    b.moveTo(20, 0);
    b.arcTo(100, 0, 100, 100, 20);
    const pa = a.subpaths[0]?.points ?? [];
    const pb = b.subpaths[0]?.points ?? [];
    expect(pb.length).toBe(pa.length);
    for (let i = 0; i < pa.length; i += 2) {
      expect(pb[i]).toBeCloseTo((pa[i] ?? 0) + 100, 9);
      expect(pb[i + 1]).toBeCloseTo((pa[i + 1] ?? 0) + 50, 9);
    }
  });

  it("leaves the current point at the arc end for the next command", () => {
    const r = new PathRecorder();
    r.moveTo(20, 0);
    r.arcTo(100, 0, 100, 100, 20);
    r.lineTo(100, 100);
    const pts = pairs(r.subpaths[0]?.points ?? []);
    // The final lineTo must be a separate vertex, i.e. the arc did not already reach it.
    expect(pts.at(-1)).toEqual([100, 100]);
    expect(pts.at(-2)?.[0]).toBeCloseTo(100, 9);
    expect(pts.at(-2)?.[1]).toBeCloseTo(20, 9);
  });
});

describe("arcTo is identical across the recorder and the SVG path context (#86)", () => {
  it("emits the same rounded-rectangle polyline", () => {
    const rec = new PathRecorder();
    roundedRect(rec, 10, 10, 80, 60, 12);
    const svg = new SvgPathContext();
    roundedRect(svg, 10, 10, 80, 60, 12);
    const a = pairs(rec.subpaths[0]?.points ?? []);
    const b = pointsOfD(svg.toPath());
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) {
      expect(b[i]?.[0]).toBeCloseTo(a[i]?.[0] ?? NaN, 2);
      expect(b[i]?.[1]).toBeCloseTo(a[i]?.[1] ?? NaN, 2);
    }
    expect(svg.toPath().endsWith("Z")).toBe(true);
  });

  it("agrees on the degenerate branches too", () => {
    const svg = new SvgPathContext();
    svg.moveTo(0, 0);
    svg.arcTo(50, 0, 100, 0, 20); // collinear -> line to the corner
    expect(pointsOfD(svg.toPath())).toEqual([[0, 0], [50, 0]]);
  });

  it("honours translate() the same way", () => {
    const rec = new PathRecorder();
    rec.translate(7, 3);
    rec.moveTo(20, 0);
    rec.arcTo(100, 0, 100, 100, 20);
    const svg = new SvgPathContext();
    svg.translate(7, 3);
    svg.moveTo(20, 0);
    svg.arcTo(100, 0, 100, 100, 20);
    const a = pairs(rec.subpaths[0]?.points ?? []);
    const b = pointsOfD(svg.toPath());
    expect(b.length).toBe(a.length);
    expect(b[0]).toEqual([27, 3]);
    for (let i = 0; i < a.length; i++) {
      expect(b[i]?.[0]).toBeCloseTo(a[i]?.[0] ?? NaN, 2);
      expect(b[i]?.[1]).toBeCloseTo(a[i]?.[1] ?? NaN, 2);
    }
  });
});
