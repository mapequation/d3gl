import { describe, it, expect } from "vitest";
import { HitIndex } from "../hit-test.js";
import type { DrawableVector } from "../scene.js";
import type { ViewTransform } from "../backend.js";

// #216 regression guards for the HitIndex spatial grid. pick() runs on EVERY pointermove,
// so it must be O(candidates in a small neighbourhood), never O(all entries) — while
// returning EXACTLY what the pre-grid linear scan returned (topmost-first, ties, screen
// mode, tolerance, overflow entries, appends).

/** Deterministic LCG so failures reproduce. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const STYLE = {
  fill: [0, 0, 0, 1] as [number, number, number, number],
  stroke: [0, 0, 0, 1] as [number, number, number, number],
  lineJoin: "bevel" as const,
  miterLimit: 4,
  lineCap: "butt" as const,
};

function circle(id: number, x: number, y: number, r: number, flags = 1): DrawableVector {
  return { id, subpaths: [], lineWidth: 0, flags, circles: [{ x, y, r }], anchor: [x, y], ...STYLE };
}

function rect(id: number, x: number, y: number, w: number, h: number, lineWidth = 0, flags = 1): DrawableVector {
  return {
    id,
    subpaths: [{ points: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true }],
    lineWidth, flags, circles: [], anchor: null, ...STYLE,
  };
}

function polyline(id: number, pts: number[], lineWidth: number): DrawableVector {
  return { id, subpaths: [{ points: pts, closed: false }], lineWidth, flags: 1, circles: [], anchor: null, ...STYLE };
}

/** Heavily-overlapping random mix: circles, filled/bordered rects, polylines, exact-duplicate
 *  stacks (topmost tie-break), hidden drawables, and a few huge bboxes (grid overflow path). */
function makeFixture(n: number, world: number, rnd: () => number): DrawableVector[] {
  const out: DrawableVector[] = [];
  for (let i = 0; i < n; i++) {
    const x = rnd() * world, y = rnd() * world;
    const kind = rnd();
    if (kind < 0.4) out.push(circle(i, x, y, 0.5 + rnd() * 4));
    else if (kind < 0.7) out.push(rect(i, x, y, 1 + rnd() * 10, 1 + rnd() * 10, rnd() < 0.5 ? 2 : 0));
    else if (kind < 0.85) out.push(polyline(i, [x, y, x + rnd() * 20 - 10, y + rnd() * 20 - 10, x + rnd() * 20 - 10, y + rnd() * 20 - 10], 1 + rnd() * 3));
    else if (kind < 0.92) out.push(circle(i, x, y, 2, rnd() < 0.5 ? 1 : 0)); // sometimes hidden
    else if (kind < 0.97) {
      // exact duplicate of an earlier drawable's position → topmost (highest index) must win
      const prev = out[Math.floor(rnd() * out.length)];
      const c = prev?.circles[0];
      out.push(circle(i, c ? c.x : x, c ? c.y : y, 2));
    } else out.push(rect(i, 0, 0, world * (0.5 + rnd() * 0.5), world * (0.5 + rnd() * 0.5))); // huge → overflow
  }
  return out;
}

/** Brute-force reference: one singleton HitIndex per drawable — a 1-entry index degenerates
 *  to the pure geometric test (its grid is 1–4 cells the entry fully covers) — then topmost =
 *  highest-indexed drawable that hits. Uses only the public API; no grid pruning involved. */
function referencePick(singletons: HitIndex[], x: number, y: number, t: ViewTransform): string | number | null {
  for (let i = singletons.length - 1; i >= 0; i--) {
    const hit = singletons[i]?.pick(x, y, t);
    if (hit != null) return hit;
  }
  return null;
}

describe("HitIndex grid equivalence (#216)", () => {
  const WORLD = 300;

  function check(screenMode: boolean, seed: number): void {
    const rnd = lcg(seed);
    const drawables = makeFixture(400, WORLD, rnd);
    // Split construction: half at build, a quarter appended (incremental insert + doubling
    // rebuild), a quarter appended AND placed outside the built extent (edge-cell clamping).
    const shifted = drawables.slice(300).map((d) => {
      const dx = WORLD * 3, dy = WORLD * 2;
      return {
        ...d,
        subpaths: d.subpaths.map((s) => ({ ...s, points: s.points.map((v, j) => (j % 2 === 0 ? v + dx : v + dy)) })),
        circles: d.circles.map((c) => ({ ...c, x: c.x + dx, y: c.y + dy })),
        anchor: d.anchor ? [d.anchor[0] + dx, d.anchor[1] + dy] as [number, number] : null,
      };
    });
    const all = [...drawables.slice(0, 300), ...shifted];
    const idx = new HitIndex(all.slice(0, 200), 1, screenMode);
    idx.append(all.slice(200, 300));
    idx.append(all.slice(300));
    const singletons = all.map((d) => new HitIndex([d], 1, screenMode));

    const transforms: ViewTransform[] = [
      { k: 1, x: 0, y: 0 },
      { k: 2.5, x: -40, y: 25 },
      { k: 0.4, x: 10, y: -5 },
    ];
    let hits = 0;
    // Compare full-index pick vs reference at a screen point that corresponds to world point
    // (wx, wy) in the entry-geometry frame — projecting per the queried mode's semantics.
    const compare = (wx: number, wy: number, t: ViewTransform, anchor?: [number, number] | null): void => {
      // world mode: screen = world·k + offset. screen mode: constant px offsets around the
      // projected anchor — screen = project(anchor) + (world − anchor).
      const x = screenMode && anchor ? anchor[0] * t.k + t.x + (wx - anchor[0]) : wx * t.k + t.x;
      const y = screenMode && anchor ? anchor[1] * t.k + t.y + (wy - anchor[1]) : wy * t.k + t.y;
      const ref = referencePick(singletons, x, y, t);
      expect(idx.pick(x, y, t)).toBe(ref);
      if (ref != null) hits++;
    };
    for (const t of transforms) {
      for (let q = 0; q < 250; q++) {
        // Random points across (and beyond) both clusters, plus points ON entry centers.
        let wx: number, wy: number;
        if (q % 3 === 0) {
          const d = all[Math.floor(rnd() * all.length)];
          const c = d?.circles[0];
          wx = c ? c.x : (d?.subpaths[0]?.points[0] ?? 0) + 1;
          wy = c ? c.y : (d?.subpaths[0]?.points[1] ?? 0) + 1;
        } else {
          wx = rnd() * WORLD * 5 - WORLD;
          wy = rnd() * WORLD * 4 - WORLD;
        }
        compare(wx, wy, t);
      }
      // Boundary probes: the tolerance band is exactly where an under-inflated grid insert
      // (or an under-padded query window) silently loses hits, so probe just inside/outside
      // the precise hit boundary on every third entry, on all four axis directions.
      const EPS = 0.05, tol = 1;
      for (let di = 0; di < all.length; di += 3) {
        const d = all[di];
        if (!d || (d.flags & 1) === 0) continue;
        const c = d.circles[0];
        if (c) {
          for (const off of [c.r + tol - EPS, c.r + tol + EPS]) {
            compare(c.x + off, c.y, t, d.anchor);
            compare(c.x - off, c.y, t, d.anchor);
            compare(c.x, c.y + off, t, d.anchor);
            compare(c.x, c.y - off, t, d.anchor);
          }
        } else if (d.lineWidth > 0) {
          const p = d.subpaths[0]?.points ?? [];
          const off = d.lineWidth / 2 + tol - EPS; // just inside the stroke's hit band
          compare((p[0] ?? 0) + off, p[1] ?? 0, t, d.anchor);
          compare((p[0] ?? 0) - off, p[1] ?? 0, t, d.anchor);
          compare(p[0] ?? 0, (p[1] ?? 0) + off, t, d.anchor);
          compare(p[0] ?? 0, (p[1] ?? 0) - off, t, d.anchor);
        }
      }
    }
    expect(hits).toBeGreaterThan(200); // the comparison must not be vacuously all-miss
  }

  it("returns exactly what a brute-force scan returns — world mode", () => {
    check(false, 7);
    check(false, 1234);
  });

  it("returns exactly what a brute-force scan returns — screen mode", () => {
    check(true, 7);
    check(true, 99);
  });

  it("picks nothing on an empty index", () => {
    const idx = new HitIndex([]);
    expect(idx.pick(10, 10, { k: 1, x: 0, y: 0 })).toBe(null);
  });
});

describe("HitIndex grid per-pointer-event cost (#216)", () => {
  // AGENTS lifecycle §5: hover-move is a continuous interaction path. Realistic large input,
  // driven through the actual trigger (pick per pointer position), asserting both a wall-clock
  // budget and the deterministic signature: entries tested per pick stays ≪ N.
  const N = 1_000_000;
  const WORLD = 16_384;

  function makeLarge(): DrawableVector[] {
    const rnd = lcg(42);
    const out: DrawableVector[] = [];
    for (let i = 0; i < N; i++) {
      const x = rnd() * WORLD, y = rnd() * WORLD;
      if (rnd() < 0.7) out.push(circle(i, x, y, 0.5 + rnd() * 2.5));
      else out.push(rect(i, x, y, 1 + rnd() * 7, 1 + rnd() * 7, 1));
    }
    return out;
  }

  it("hover sweep at 1M drawables: tested-per-pick ≪ N and per-pick budget holds", { timeout: 120_000 }, () => {
    const idx = new HitIndex(makeLarge());
    const t = { k: 1, x: 0, y: 0 };
    const picks = 200;

    idx.pick(0, 0, t); // warm-up
    const testedBefore = idx.testedEntries;
    const start = performance.now();
    for (let i = 0; i < picks; i++) {
      const f = i / (picks - 1);
      idx.pick(f * WORLD, f * WORLD, t); // diagonal hover sweep, hits and misses
    }
    const elapsed = performance.now() - start;
    const testedPerPick = (idx.testedEntries - testedBefore) / picks;

    // Deterministic signature: the grid visits a small neighbourhood, not the whole layer.
    // (Measured ~2–5 tested/pick; the linear scan would be ~1,000,000.)
    expect(testedPerPick).toBeLessThan(2000);
    // Generous wall-clock ceiling per pick (measured ~0.001–0.005 ms; pre-grid was ~13 ms).
    expect(elapsed / picks).toBeLessThan(1.5);
  });

  it("screen-mode hover sweep at 1M drawables: tested-per-pick ≪ N", { timeout: 120_000 }, () => {
    const idx = new HitIndex(makeLarge(), 1, true);
    const t = { k: 2, x: -WORLD / 2, y: -WORLD / 2 };
    const picks = 200;

    idx.pick(0, 0, t); // warm-up
    const testedBefore = idx.testedEntries;
    const start = performance.now();
    for (let i = 0; i < picks; i++) {
      const f = i / (picks - 1);
      idx.pick(f * WORLD, f * WORLD, t);
    }
    const elapsed = performance.now() - start;
    const testedPerPick = (idx.testedEntries - testedBefore) / picks;

    expect(testedPerPick).toBeLessThan(2000);
    expect(elapsed / picks).toBeLessThan(1.5);
  });
});
