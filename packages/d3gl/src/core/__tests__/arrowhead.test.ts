import { describe, it, expect } from "vitest";
import {
  arrowHead,
  arrowOutline,
  arrowShaft,
  barbOverhang,
  headHalfWidth,
  headLength,
  legCubic,
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

/** The link's cubic controls per the #542 spec, computed independently of `writeShaft`. */
function linkCubic(p: ArrowParams, back: number): number[] {
  const dx = p.tx - p.sx;
  const dy = p.ty - p.sy;
  const b = p.bend;
  const a0x = dx - 2 * b * dy;
  const a0y = dy + 2 * b * dx;
  const a1x = -dx - 2 * b * dy;
  const a1y = -dy + 2 * b * dx;
  const l = Math.hypot(a0x, a0y);
  const e1x = p.tx + (back * a1x) / l;
  const e1y = p.ty + (back * a1y) / l;
  const leg = (Math.hypot(e1x - p.sx, e1y - p.sy) * Math.sqrt(1 + 4 * b * b)) / 3;
  return [p.sx, p.sy, p.sx + (leg * a0x) / l, p.sy + (leg * a0y) / l, e1x + (leg * a1x) / l, e1y + (leg * a1y) / l, e1x, e1y];
}

/** Point and derivative/3 of the cubic `c` at `t`. */
function cubicAt(c: number[], t: number): [number, number, number, number] {
  const [x0 = NaN, y0 = NaN, x1 = NaN, y1 = NaN, x2 = NaN, y2 = NaN, x3 = NaN, y3 = NaN] = c;
  const a = 1 - t;
  return [
    a * a * a * x0 + 3 * a * a * t * x1 + 3 * a * t * t * x2 + t * t * t * x3,
    a * a * a * y0 + 3 * a * a * t * y1 + 3 * a * t * t * y2 + t * t * t * y3,
    a * a * (x1 - x0) + 2 * a * t * (x2 - x1) + t * t * (x3 - x2),
    a * a * (y1 - y0) + 2 * a * t * (y2 - y1) + t * t * (y3 - y2),
  ];
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

  it("samples lie on the settled cubic E0, E0 + ℓ·u0, E1 + ℓ·u1, E1, normals ⟂ its tangent", () => {
    for (const bend of BENDS) {
      for (const [w, size] of SIZES) {
        const p = params(w, size, bend);
        const m = 9;
        const out = new Float64Array(4 * m);
        expect(arrowShaft(out, 0, p, headLength(size), m)).toBe(2 * m);
        const c = linkCubic(p, p.radius + headLength(size));
        for (let i = 0; i < m; i++) {
          const t = i / (m - 1);
          const [x, y, gx, gy] = cubicAt(c, t);
          const lx = out[4 * i] ?? NaN;
          const ly = out[4 * i + 1] ?? NaN;
          const rx = out[4 * i + 2] ?? NaN;
          const ry = out[4 * i + 3] ?? NaN;
          expect((lx + rx) / 2).toBeCloseTo(x, 9);
          expect((ly + ry) / 2).toBeCloseTo(y, 9);
          // left − right = w·⟂(travel direction)
          const gl = Math.hypot(gx, gy);
          expect(lx - rx).toBeCloseTo((-gy / gl) * w, 9);
          expect(ly - ry).toBeCloseTo((gx / gl) * w, 9);
        }
      }
    }
  });

  it("ends on the head's axis with a radial end tangent: no step, no corner into the head", () => {
    for (const bend of BENDS) {
      const p = params(4, 3, bend);
      const back = p.radius + headLength(3);
      const c = linkCubic(p, back);
      const [, , , , p2x, p2y, p3x, p3y] = c;
      // E1 sits `back` out of the target centre, and P2 − P3 points along E1 − c1: the end tangent is radial.
      expect(Math.hypot(p3x - p.tx, p3y - p.ty)).toBeCloseTo(back, 9);
      expect((p2x - p3x) * (p3y - p.ty) - (p2y - p3y) * (p3x - p.tx)).toBeCloseTo(0, 9);
      expect((p2x - p3x) * (p3x - p.tx) + (p2y - p3y) * (p3y - p.ty)).toBeGreaterThan(0);
      // The head's tip lies on that same axis, on the target's rim.
      const h = head(p);
      const tipX = h[2] ?? NaN;
      const tipY = h[3] ?? NaN;
      expect(Math.hypot(tipX - p.tx, tipY - p.ty)).toBeCloseTo(p.radius, 9);
      expect((tipX - p.tx) * (p3y - p.ty) - (tipY - p.ty) * (p3x - p.tx)).toBeCloseTo(0, 9);
      // The strip's normals turn smoothly into the head's: the pair next to the end is nearly the base's.
      const m = 2001;
      const out = new Float64Array(4 * m);
      arrowShaft(out, 0, p, headLength(3), m);
      const nx = (out[4 * m - 8] ?? NaN) - (out[4 * m - 6] ?? NaN);
      const ny = (out[4 * m - 7] ?? NaN) - (out[4 * m - 5] ?? NaN);
      const ex = (out[4 * m - 4] ?? NaN) - (out[4 * m - 2] ?? NaN);
      const ey = (out[4 * m - 3] ?? NaN) - (out[4 * m - 1] ?? NaN);
      expect(Math.abs(nx * ey - ny * ex) / (4 * 4)).toBeLessThan(1e-2);
    }
  });

  it("with no head (E1 = c1) is exactly the quadratic P0 → C → P1", () => {
    for (const bend of BENDS) {
      const p: ArrowParams = { ...params(2, 3, bend), radius: 0 };
      const m = 7;
      const out = new Float64Array(4 * m);
      arrowShaft(out, 0, p, 0, m);
      const cx = (p.sx + p.tx) / 2 - (p.ty - p.sy) * bend;
      const cy = (p.sy + p.ty) / 2 + (p.tx - p.sx) * bend;
      for (let i = 0; i < m; i++) {
        const t = i / (m - 1);
        const a = 1 - t;
        expect(((out[4 * i] ?? 0) + (out[4 * i + 2] ?? 0)) / 2).toBeCloseTo(a * a * p.sx + 2 * a * t * cx + t * t * p.tx, 9);
        expect(((out[4 * i + 1] ?? 0) + (out[4 * i + 3] ?? 0)) / 2).toBeCloseTo(a * a * p.sy + 2 * a * t * cy + t * t * p.ty, 9);
      }
    }
  });

  it("is exact for a straight link: a uniform segment from the source to radius + h back from the target", () => {
    const p = params(6, 4, 0);
    const back = p.radius + headLength(4);
    const m = 4;
    const out = new Float64Array(4 * m);
    arrowShaft(out, 0, p, headLength(4), m);
    const len = Math.hypot(p.tx - p.sx, p.ty - p.sy);
    const dx = (p.tx - p.sx) / len;
    const dy = (p.ty - p.sy) / len;
    for (let i = 0; i < m; i++) {
      const s = ((len - back) * i) / (m - 1);
      expect(((out[4 * i] ?? 0) + (out[4 * i + 2] ?? 0)) / 2).toBeCloseTo(p.sx + dx * s, 9);
      expect(((out[4 * i + 1] ?? 0) + (out[4 * i + 3] ?? 0)) / 2).toBeCloseTo(p.sy + dy * s, 9);
      expect((out[4 * i] ?? 0) - (out[4 * i + 2] ?? 0)).toBeCloseTo(-dy * 6, 9);
      expect((out[4 * i + 1] ?? 0) - (out[4 * i + 3] ?? 0)).toBeCloseTo(dx * 6, 9);
    }
  });

  it("collapses to the straight E0 → E1 when r1 + h ≥ |d|, and the output stays finite", () => {
    for (const bend of BENDS) {
      for (const radius of [30, 6, 2]) {
        // |d| = 10, h = 8: r1 + h ≥ |d| for every radius here.
        const p: ArrowParams = { sx: 0, sy: 0, tx: 10, ty: 0, radius, width: 3, size: 4, bend };
        const out = new Float64Array(16);
        expect(arrowShaft(out, 0, p, headLength(4), 4)).toBe(8);
        expect(out.every(Number.isFinite)).toBe(true);
        const outline = new Float64Array(2 * (2 * 4 + 3));
        expect(arrowOutline(outline, 0, p, 4)).toBe(11);
        expect(outline.every(Number.isFinite)).toBe(true);
        // Sample 1 of 4 sits a third of the way from the source to the end.
        const ex = ((out[12] ?? NaN) + (out[14] ?? NaN)) / 2;
        const ey = ((out[13] ?? NaN) + (out[15] ?? NaN)) / 2;
        expect(((out[4] ?? NaN) + (out[6] ?? NaN)) / 2).toBeCloseTo(ex / 3, 9);
        expect(((out[5] ?? NaN) + (out[7] ?? NaN)) / 2).toBeCloseTo(ey / 3, 9);
      }
    }
    // The end landing exactly on the source: every sample at the base, still finite.
    const p: ArrowParams = { sx: 0, sy: 0, tx: 10, ty: 0, radius: 2, width: 3, size: 4, bend: 0 };
    const out = new Float64Array(16);
    arrowShaft(out, 0, p, headLength(4), 4);
    expect(out.every(Number.isFinite)).toBe(true);
  });
});

describe("legCubic", () => {
  it("writes E0, E0 + ℓ·u0, E1 + ℓ·u1, E1 with Ek = ck + ρk·uk, at an offset", () => {
    const out = new Array<number>(10).fill(NaN);
    legCubic(out, 2, 1, 2, 0.6, 0.8, 5, 10, 20, -1, 0, 3, 4);
    expect(out.slice(0, 2).every(Number.isNaN)).toBe(true);
    const want = [1 + 3, 2 + 4, 4 + 2.4, 6 + 3.2, 7 - 4, 20, 7, 20];
    for (let k = 0; k < 8; k++) expect(out[2 + k]).toBeCloseTo(want[k] ?? NaN, 12);
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
