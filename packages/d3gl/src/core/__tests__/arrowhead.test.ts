import { describe, it, expect } from "vitest";
import {
  arrowHead,
  arrowOutline,
  arrowShaft,
  barbOverhang,
  fadedBend,
  headHalfWidth,
  headLength,
  legCubic,
  offsetCubic,
  shaftSetback,
  traceArrowOutline,
  type ArrowParams,
} from "../arrowhead.js";
import { PathRecorder } from "../path-recorder.js";
import { outlineGap } from "./outline-gap.js";
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

describe("fadedBend (short bent links)", () => {
  /** ρ = r1 + h and the closed-form floor, computed independently. */
  function floorOf(bend: number, radius: number, size: number, width: number): { rho: number; floor: number } {
    const rho = radius + 2 * size;
    const x = Math.min(0.99, (1.2 * (width / 2 + 2 * Math.sqrt(width))) / rho);
    return { rho, floor: Math.min(Math.abs(bend), (0.5 * x) / Math.sqrt(1 - x * x)) };
  }
  const CASES: [number, number, number][] = [
    // radius, size, width
    [12, 4, 2],
    [5, 3, 1],
    [20, 6, 8],
  ];

  it("is the bend itself, bit for bit, once D ≥ 4ρ", () => {
    for (const [r, size, w] of CASES) {
      const { rho } = floorOf(1, r, size, w);
      for (const bend of [0, 0.2, -0.35, 0.5, 1e-7]) {
        for (const d of [4 * rho, 4 * rho + 1e-9, 10 * rho, 1e6]) expect(Object.is(fadedBend(bend, d, r, size, w), bend)).toBe(true);
      }
    }
  });

  it("is the floor for D ≤ 2ρ, and keeps the sign", () => {
    for (const [r, size, w] of CASES) {
      for (const bend of [0.25, 0.5, 2]) {
        const { rho, floor } = floorOf(bend, r, size, w);
        expect(floor).toBeLessThan(bend); // the floor binds for these bends
        for (const d of [0, rho, 1.5 * rho, 2 * rho]) {
          expect(fadedBend(bend, d, r, size, w)).toBeCloseTo(floor, 12);
          expect(fadedBend(-bend, d, r, size, w)).toBeCloseTo(-floor, 12);
        }
      }
    }
    // A bend below the floor stays as it is.
    expect(fadedBend(0.01, 0, 12, 4, 2)).toBeCloseTo(0.01, 15);
  });

  it("is continuous across both ends of the fade and monotonic between", () => {
    for (const [r, size, w] of CASES) {
      const bend = 0.5;
      const { rho, floor } = floorOf(bend, r, size, w);
      const e = 1e-6 * rho;
      expect(fadedBend(bend, 2 * rho + e, r, size, w)).toBeCloseTo(floor, 9);
      expect(fadedBend(bend, 4 * rho - e, r, size, w)).toBeCloseTo(bend, 9);
      let prev = fadedBend(bend, 2 * rho, r, size, w);
      for (let i = 1; i <= 64; i++) {
        const b = fadedBend(bend, 2 * rho + (2 * rho * i) / 64, r, size, w);
        expect(b).toBeGreaterThanOrEqual(prev);
        expect(b - prev).toBeLessThan(0.05 * (bend - floor)); // no jump
        prev = b;
      }
      // smoothstep's midpoint: halfway between the floor and the bend.
      expect(fadedBend(bend, 3 * rho, r, size, w)).toBeCloseTo((floor + bend) / 2, 12);
    }
  });

  it("keeps an opposite pair's heads apart: each head stays on its own side of the chord", () => {
    for (const [r, size, w] of CASES) {
      for (const bend of [0.25, 0.5]) {
        const { rho } = floorOf(bend, r, size, w);
        for (const k of [1.2, 1.5, 2, 2.5, 3, 3.5, 4, 6]) {
          const d = k * rho;
          // A = (0, 0), B = (d, 0): A→B bends to +y, B→A (the same bend) to −y.
          const ab = head({ sx: 0, sy: 0, tx: d, ty: 0, radius: r, width: w, size, bend });
          const ba = head({ sx: d, sy: 0, tx: 0, ty: 0, radius: r, width: w, size, bend });
          for (let i = 0; i < 3; i++) {
            expect(ab[2 * i + 1]).toBeGreaterThan(0);
            expect(ba[2 * i + 1]).toBeLessThan(0);
          }
        }
      }
    }
  });

  it("drives the whole arrow: shaft on the faded cubic, head on its end tangent", () => {
    const p: ArrowParams = { sx: 0, sy: 0, tx: 50, ty: 20, radius: 6, width: 2, size: 4, bend: 0.5 };
    const beff = fadedBend(p.bend, Math.hypot(50, 20), p.radius, p.size, p.width);
    expect(beff).toBeLessThan(p.bend); // D ≈ 3.9ρ: in the fade
    const faded = { ...p, bend: beff };
    const [ux, uy] = bentEndTangent(p.sx, p.sy, p.tx, p.ty, beff);
    const h = head(p);
    expect(h[2]).toBeCloseTo(p.tx - ux * p.radius, 9);
    expect(h[3]).toBeCloseTo(p.ty - uy * p.radius, 9);
    const m = 6;
    const out = new Float64Array(4 * m);
    arrowShaft(out, 0, p, headLength(p.size), m);
    const c = linkCubic(faded, p.radius + headLength(p.size));
    for (let i = 0; i < m; i++) {
      const [x, y] = cubicAt(c, i / (m - 1));
      expect(((out[4 * i] ?? 0) + (out[4 * i + 2] ?? 0)) / 2).toBeCloseTo(x, 9);
      expect(((out[4 * i + 1] ?? 0) + (out[4 * i + 3] ?? 0)) / 2).toBeCloseTo(y, 9);
    }
    const outline = new Float64Array(2 * (2 * m + 3));
    arrowOutline(outline, 0, p, m);
    for (let k = 0; k < 6; k++) expect(outline[2 * m + k]).toBeCloseTo(h[k] ?? NaN, 12);
  });

  it("stays finite for a head wider than ρ (x clamps at 0.99), and for a degenerate ρ = 0", () => {
    const b = fadedBend(5, 1, 1, 0.1, 400);
    expect(Number.isFinite(b)).toBe(true);
    expect(b).toBeCloseTo((0.5 * 0.99) / Math.sqrt(1 - 0.99 * 0.99), 12);
    expect(fadedBend(-0.3, 0, 0, 0, 3)).toBe(-0.3);
    expect(fadedBend(0, 0, 4, 2, 3)).toBe(0);
  });
});

describe("traceArrowOutline (#542: each edge ONE cubic)", () => {
  const M = 800; // the dense sampled outline stands in for the exact offset
  const dense = new Float64Array(2 * (2 * M + 3));
  const traced = (p: ArrowParams, tolerance: number, scale = 1): number[] => {
    const rec = new PathRecorder(tolerance);
    traceArrowOutline(rec, p, scale);
    expect(rec.subpaths).toHaveLength(1);
    expect(rec.subpaths[0]?.closed).toBe(true);
    return rec.subpaths[0]?.points ?? [];
  };

  it("keeps within 0.03·w (0.15 px) of the exact offset: bends 0.1–0.5, widths 1–10, links of 40–400 px", () => {
    for (const bend of [0.1, 0.25, 0.5])
      for (const width of [1, 4, 10])
        for (const len of [40, 100, 400]) {
          const p: ArrowParams = { sx: 3, sy: -2, tx: 3 + len * Math.cos(0.7), ty: -2 + len * Math.sin(0.7), radius: 5, width, size: 5 * Math.cbrt(width), bend };
          const n = arrowOutline(dense, 0, p, M);
          const pts = traced(p, 0.002);
          const gap = outlineGap(pts, pts.length / 2, dense, n);
          expect(gap, `bend ${bend} width ${width} len ${len}`).toBeLessThan(Math.min(0.03 * width, 0.15));
        }
  });

  it("starts, meets the head and ends exactly where arrowOutline does; a straight link is the same 7 points", () => {
    const p: ArrowParams = { sx: 0, sy: 0, tx: 120, ty: 30, radius: 6, width: 3, size: 4, bend: 0.3 };
    const n = arrowOutline(dense, 0, p, M);
    const pts = traced(p, 0.25);
    const k = pts.length / 2;
    // First point = the left edge's start; the head's 5 points (base corner, barb, tip, barb, base corner) are the
    // sampled outline's M−1 … M+3; the last point = the right edge's start.
    expect(pts[0]).toBeCloseTo(dense[0] ?? NaN, 9);
    expect(pts[1]).toBeCloseTo(dense[1] ?? NaN, 9);
    expect(pts[2 * (k - 1)]).toBeCloseTo(dense[2 * (n - 1)] ?? NaN, 9);
    expect(pts[2 * (k - 1) + 1]).toBeCloseTo(dense[2 * (n - 1) + 1] ?? NaN, 9);
    for (let j = 0; j < 5; j++) {
      const w = M - 1 + j;
      const found = Array.from({ length: k }, (_, i) => Math.hypot((pts[2 * i] ?? 0) - (dense[2 * w] ?? 0), (pts[2 * i + 1] ?? 0) - (dense[2 * w + 1] ?? 0)));
      expect(Math.min(...found), `head point ${j}`).toBeLessThan(1e-9);
    }

    const straight: ArrowParams = { ...p, bend: 0 };
    const sn = arrowOutline(dense, 0, straight, 2);
    const sp = traced(straight, 0.25, 0.5);
    expect(sp).toHaveLength(2 * sn);
    for (let i = 0; i < 2 * sn; i++) expect(sp[i]).toBeCloseTo((dense[i] ?? 0) * 0.5, 9);
  });

  it("stores a 40 px link in fewer points than the 24-sample outline, and flattens by the recorder's tolerance", () => {
    const p: ArrowParams = { sx: 0, sy: 0, tx: 40, ty: 0, radius: 5, width: 2, size: 5 * Math.cbrt(2), bend: 0.25 };
    expect(traced(p, 0.25).length / 2).toBeLessThan(2 * 24 + 3);
    const long = { ...p, tx: 300 };
    expect(traced(long, 0.05).length).toBeGreaterThan(traced(long, 0.25).length);
  });

  it("offsetCubic: offset 0 is the cubic itself; a straight cubic shifts exactly", () => {
    const c = [0, 0, 10, 5, 30, 5, 40, 0];
    const out = new Float64Array(8);
    offsetCubic(c, 0, 0, out, 0);
    c.forEach((v, i) => expect(out[i]).toBeCloseTo(v, 12));
    offsetCubic([0, 0, 10, 0, 20, 0, 30, 0], 0, 2, out, 0);
    expect(Array.from(out)).toEqual([0, 2, 10, 2, 20, 2, 30, 2]);
  });
});
