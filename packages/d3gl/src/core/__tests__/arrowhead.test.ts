import { describe, it, expect } from "vitest";
import {
  arrowHead,
  arrowOutline,
  arrowShaft,
  barbOverhang,
  headHalfWidth,
  headLength,
  shaftSetback,
  type ArrowParams,
} from "../arrowhead.js";
import { bentEndTangent, halfLinkGeometry } from "../half-link.js";

const EPS = 1e-9;

/** (width, size) pairs, incl. a width larger than the arrow size. */
const SIZES: [number, number][] = [
  [0.5, 3],
  [1, 4],
  [3, 5],
  [8, 2],
  [20, 3],
];
const BENDS = [0, 0.2, -0.35];

function params(width: number, size: number, bend: number): ArrowParams {
  return { sx: 10, sy: 20, tx: 210, ty: 120, radius: 12, width, size, bend };
}

/** Distance of (px,py) from the segment a→b and its projection parameter along it. */
function onSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): { dist: number; u: number } {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const u = ((px - ax) * vx + (py - ay) * vy) / len2;
  const dist = Math.abs((px - ax) * vy - (py - ay) * vx) / Math.sqrt(len2);
  return { dist, u };
}

function head(p: ArrowParams): number[] {
  const h = [0, 0, 0, 0, 0, 0];
  expect(arrowHead(h, 0, p)).toBe(3);
  return h;
}

describe("arrowhead sizes", () => {
  it("the barb overhang is the half-arrow's barb", () => {
    for (const w of [1, 4, 7, 13]) {
      const g = halfLinkGeometry({ x0: 0, y0: 0, r0: 10, x1: 300, y1: 40, r1: 10, width: w, bend: 30 });
      expect(g).not.toBeNull();
      if (!g) continue;
      expect(Math.hypot(g.x14 - g.x13, g.y14 - g.y13)).toBeCloseTo(barbOverhang(w), 12);
      expect(headHalfWidth(w) - w / 2).toBeCloseTo(barbOverhang(w), 12);
    }
  });

  it("the setback never goes past the head's base, and the head is as wide as the line there", () => {
    for (const w of [0.1, 1, 5, 20, 100, 1000]) {
      for (const size of [0.5, 2, 6]) {
        const s = shaftSetback(w, size);
        expect(s).toBeGreaterThan(0);
        expect(s).toBeLessThan(headLength(size));
        expect((headHalfWidth(w) * s) / headLength(size)).toBeCloseTo(w / 2, 9);
      }
    }
    expect(shaftSetback(0, 3)).toBe(0);
  });
});

describe("arrowHead", () => {
  it("is symmetric about the curve's end tangent, tip on the target boundary", () => {
    for (const bend of BENDS) {
      for (const [w, size] of SIZES) {
        const p = params(w, size, bend);
        const [ux, uy] = bentEndTangent(p.sx, p.sy, p.tx, p.ty, bend);
        const h = head(p);
        const tipX = h[2] ?? NaN;
        const tipY = h[3] ?? NaN;
        expect(tipX).toBeCloseTo(p.tx - ux * p.radius, 9);
        expect(tipY).toBeCloseTo(p.ty - uy * p.radius, 9);
        const along = (x: number, y: number) => (x - tipX) * ux + (y - tipY) * uy;
        const across = (x: number, y: number) => -(x - tipX) * uy + (y - tipY) * ux;
        const [lx = NaN, ly = NaN, , , rx = NaN, ry = NaN] = h;
        expect(along(lx, ly)).toBeCloseTo(-headLength(size), 9);
        expect(along(rx, ry)).toBeCloseTo(-headLength(size), 9);
        expect(across(lx, ly)).toBeCloseTo(headHalfWidth(w), 9);
        expect(across(rx, ry)).toBeCloseTo(-headHalfWidth(w), 9);
      }
    }
  });

  it("writes nothing for a zero-length link", () => {
    const p: ArrowParams = { sx: 5, sy: 5, tx: 5, ty: 5, radius: 3, width: 2, size: 4, bend: 0.3 };
    expect(arrowHead([], 0, p)).toBe(0);
    expect(arrowShaft([], 0, p, 1, 4)).toBe(0);
    expect(arrowOutline([], 0, p, 4)).toBe(0);
  });
});

describe("arrowShaft (strip)", () => {
  it("ends s back from the tip with its corners on the head's side edges", () => {
    for (const bend of BENDS) {
      for (const [w, size] of SIZES) {
        const p = params(w, size, bend);
        const h = head(p);
        const m = 8;
        const out = new Float64Array(4 * m);
        expect(arrowShaft(out, 0, p, shaftSetback(w, size), m)).toBe(2 * m);
        const [blx = NaN, bly = NaN, tipX = NaN, tipY = NaN, brx = NaN, bry = NaN] = h;
        const left = onSegment(out[4 * m - 4] ?? NaN, out[4 * m - 3] ?? NaN, tipX, tipY, blx, bly);
        const right = onSegment(out[4 * m - 2] ?? NaN, out[4 * m - 1] ?? NaN, tipX, tipY, brx, bry);
        for (const c of [left, right]) {
          expect(c.dist).toBeLessThan(1e-6);
          expect(c.u).toBeGreaterThan(EPS); // not at the tip: no line edge beside it
          expect(c.u).toBeLessThan(1 - EPS); // strictly inside the barb
        }
        // The first pair straddles the source by half the width.
        expect(Math.hypot((out[0] ?? 0) - (out[2] ?? 0), (out[1] ?? 0) - (out[3] ?? 0))).toBeCloseTo(w, 9);
        expect(((out[0] ?? 0) + (out[2] ?? 0)) / 2).toBeCloseTo(p.sx, 9);
      }
    }
  });

  it("samples lie on the quadratic P0 → C → B, B on the head's axis, so the shaft meets the head along it", () => {
    const p = params(4, 3, 0.3);
    const s = shaftSetback(4, 3);
    const m = 5;
    const out = new Float64Array(4 * m);
    arrowShaft(out, 0, p, s, m);
    const cx = (p.sx + p.tx) / 2 - (p.ty - p.sy) * p.bend;
    const cy = (p.sy + p.ty) / 2 + (p.tx - p.sx) * p.bend;
    const el = Math.hypot(p.tx - cx, p.ty - cy);
    const ux = (p.tx - cx) / el;
    const uy = (p.ty - cy) / el;
    const bx = p.tx - ux * (p.radius + s);
    const by = p.ty - uy * (p.radius + s);
    for (let i = 0; i < m; i++) {
      const t = i / (m - 1);
      const a = 1 - t;
      expect(((out[4 * i] ?? 0) + (out[4 * i + 2] ?? 0)) / 2).toBeCloseTo(a * a * p.sx + 2 * a * t * cx + t * t * bx, 9);
      expect(((out[4 * i + 1] ?? 0) + (out[4 * i + 3] ?? 0)) / 2).toBeCloseTo(a * a * p.sy + 2 * a * t * cy + t * t * by, 9);
    }
    // C, B and the tip are collinear: the shaft's end tangent B − C is the head's axis (no step, no corner).
    const h = head(p);
    const tipX = h[2] ?? NaN;
    const tipY = h[3] ?? NaN;
    expect((bx - cx) * (tipY - by) - (by - cy) * (tipX - bx)).toBeCloseTo(0, 9);
  });

  it("is the straight P0 → B when the head reaches back past C, and the output stays finite", () => {
    const p: ArrowParams = { sx: 0, sy: 0, tx: 10, ty: 0, radius: 30, width: 3, size: 4, bend: 0.2 };
    const out = new Float64Array(16);
    expect(arrowShaft(out, 0, p, shaftSetback(3, 4), 4)).toBe(8);
    expect(out.every(Number.isFinite)).toBe(true);
    // Sample 1 of 4 sits a third of the way from the source to the end.
    const ex = ((out[12] ?? NaN) + (out[14] ?? NaN)) / 2;
    const ey = ((out[13] ?? NaN) + (out[15] ?? NaN)) / 2;
    expect(((out[4] ?? NaN) + (out[6] ?? NaN)) / 2).toBeCloseTo(ex / 3, 9);
    expect(((out[5] ?? NaN) + (out[7] ?? NaN)) / 2).toBeCloseTo(ey / 3, 9);
  });

  it("is exact for a straight link: the end is at radius + s from the target", () => {
    const p = params(6, 4, 0);
    const s = shaftSetback(6, 4);
    const m = 4;
    const out = new Float64Array(4 * m);
    arrowShaft(out, 0, p, s, m);
    const ex = ((out[4 * m - 4] ?? 0) + (out[4 * m - 2] ?? 0)) / 2;
    const ey = ((out[4 * m - 3] ?? 0) + (out[4 * m - 1] ?? 0)) / 2;
    expect(Math.hypot(p.tx - ex, p.ty - ey)).toBeCloseTo(p.radius + s, 9);
  });
});

describe("arrowOutline (one filled shape)", () => {
  it("is shaft-left, left barb, tip, right barb, shaft-right with the shaft corners on the head's base", () => {
    for (const bend of BENDS) {
      for (const [w, size] of SIZES) {
        const p = params(w, size, bend);
        const h = head(p);
        const m = 6;
        const out = new Array<number>(2 * (2 * m + 3)).fill(NaN);
        expect(arrowOutline(out, 0, p, m)).toBe(2 * m + 3);
        expect(out.every(Number.isFinite)).toBe(true);
        // The head sits between the two shaft edges.
        for (let k = 0; k < 6; k++) expect(out[2 * m + k]).toBeCloseTo(h[k] ?? NaN, 12);
        const [blx = NaN, bly = NaN, , , brx = NaN, bry = NaN] = h;
        const left = onSegment(out[2 * m - 2] ?? NaN, out[2 * m - 1] ?? NaN, blx, bly, brx, bry);
        const right = onSegment(out[2 * m + 6] ?? NaN, out[2 * m + 7] ?? NaN, blx, bly, brx, bry);
        for (const c of [left, right]) {
          expect(c.dist).toBeLessThan(1e-6);
          expect(c.u).toBeGreaterThan(EPS); // inside the barbs: no gap, no notch
          expect(c.u).toBeLessThan(1 - EPS);
        }
        // Closes back at the source's right corner.
        const n = 2 * m + 3;
        const mx = ((out[0] ?? 0) + (out[2 * (n - 1)] ?? 0)) / 2;
        const my = ((out[1] ?? 0) + (out[2 * (n - 1) + 1] ?? 0)) / 2;
        expect(mx).toBeCloseTo(p.sx, 9);
        expect(my).toBeCloseTo(p.sy, 9);
      }
    }
  });

  it("writes at an offset into a caller buffer", () => {
    const p = params(2, 3, 0);
    const out = new Float32Array(4 + 14);
    expect(arrowOutline(out, 4, p, 2)).toBe(7);
    expect(out[0]).toBe(0);
    expect(out[4]).toBeCloseTo(p.sx + (-(p.ty - p.sy) / Math.hypot(200, 100)) * 1, 4);
  });
});
