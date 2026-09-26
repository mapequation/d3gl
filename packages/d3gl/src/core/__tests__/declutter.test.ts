import { describe, it, expect } from "vitest";
import { declutterScreen, declutterMembers, declutterScratch } from "../declutter.js";

const run = (count: number, sx: number[], sy: number[], radius: number | Float64Array, order: number[] | undefined, spacing = 1) =>
  Array.from(declutterScreen(count, sx, sy, radius, order, 100, 100, spacing, new Uint8Array(count)));

describe("declutterScreen", () => {
  it("drops a later glyph that overlaps a kept one (centre dist < rᵢ + rⱼ)", () => {
    // r=10 each at x=0 and x=15 → dist 15 < 20 ⇒ overlap; visiting [0,1] keeps 0.
    expect(run(2, [0, 15], [0, 0], 10, [0, 1])).toEqual([1, 0]);
  });

  it("keeps both when they don't overlap", () => {
    expect(run(2, [0, 30], [0, 0], 10, undefined)).toEqual([1, 1]); // dist 30 > 20
  });

  it("visits in the given order, so the higher-importance glyph survives a tie", () => {
    expect(run(2, [0, 15], [0, 0], 10, [1, 0])).toEqual([0, 1]); // order favours glyph 1
  });

  it("keeps an off-screen-centre glyph and lets it not occlude on-screen ones", () => {
    // glyph 0 off-screen (x=-50) would overlap glyph 1 if counted; it's kept but excluded from occlusion.
    expect(run(2, [-50, 5], [0, 0], 10, [0, 1])).toEqual([1, 1]);
  });

  it("honours per-glyph radii", () => {
    expect(run(2, [0, 5], [0, 0], new Float64Array([2, 2]), [0, 1])).toEqual([1, 1]); // dist 5 > 4
    expect(run(2, [0, 5], [0, 0], new Float64Array([3, 3]), [0, 1])).toEqual([1, 0]); // dist 5 < 6
  });

  it("scales the exclusion by spacing", () => {
    expect(run(2, [0, 25], [0, 0], 10, [0, 1], 1)).toEqual([1, 1]); // 25 > 20
    expect(run(2, [0, 25], [0, 0], 10, [0, 1], 1.5)).toEqual([1, 0]); // 25 < 30
  });

  it("records winners: a hidden glyph maps to the kept glyph that occluded it; a kept glyph to itself", () => {
    // Three glyphs in a row, r=10: 0 kept; 1 (x=15) and 2 (x=18) both within 20 of glyph 0 ⇒ absorbed by 0.
    const winners = new Int32Array(3);
    declutterScreen(3, [0, 15, 18], [0, 0, 0], 10, [0, 1, 2], 100, 100, 1, new Uint8Array(3), undefined, undefined, winners);
    expect(Array.from(winners)).toEqual([0, 0, 0]);
    // members(): the kept survivor (0) represents itself + both absorbed glyphs; an unrelated index is empty.
    expect(declutterMembers(winners, 0, 3)).toEqual([0, 1, 2]);
  });

  it("winners point each cluster to its own survivor", () => {
    // Two separate clusters: {0 keeps 1} near x≈0, {2 keeps 3} near x≈60.
    const winners = new Int32Array(4);
    declutterScreen(4, [0, 12, 60, 72], [0, 0, 0, 0], 10, [0, 1, 2, 3], 100, 100, 1, new Uint8Array(4), undefined, undefined, winners);
    expect(declutterMembers(winners, 0, 4)).toEqual([0, 1]);
    expect(declutterMembers(winners, 2, 4)).toEqual([2, 3]);
  });
});

/**
 * The single-grid per-glyph declutter every release before the radius-class grid shipped: one uniform
 * grid with cell = 2·spacing·maxR, a 3×3 neighbourhood scan in (column, row) order and each cell's
 * kept glyphs newest first. The radius-class grid must reproduce it exactly — the same kept set AND
 * the same `winners` (the first occluder this scan meets).
 */
function singleGridReference(
  count: number,
  sx: ArrayLike<number>,
  sy: ArrayLike<number>,
  radii: ArrayLike<number>,
  order: ArrayLike<number> | undefined,
  width: number,
  height: number,
  spacing: number,
  ignore?: (i: number, j: number) => boolean,
): { kept: Uint8Array; winners: Int32Array; probes: number } {
  const kept = new Uint8Array(count);
  const winners = new Int32Array(count).fill(-7);
  let maxR = 1;
  for (let i = 0; i < count; i++) maxR = Math.max(maxR, radii[i] ?? 0);
  const cell = Math.max(2 * maxR * spacing, 1);
  const cols = Math.floor(width / cell) + 3;
  const rows = Math.floor(height / cell) + 3;
  const head = new Int32Array(cols * rows).fill(-1);
  const next = new Int32Array(count);
  let probes = 0;
  for (let oi = 0; oi < count; oi++) {
    const i = order ? (order[oi] ?? 0) : oi;
    const x = sx[i] ?? 0;
    const y = sy[i] ?? 0;
    const r = radii[i] ?? 0;
    if (x < 0 || y < 0 || x > width || y > height) {
      kept[i] = 1;
      winners[i] = i;
      continue;
    }
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / cell) + 1));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(y / cell) + 1));
    let occluder = -1;
    for (let gx = cx - 1; gx <= cx + 1 && occluder < 0; gx++) {
      if (gx < 0 || gx >= cols) continue;
      for (let gy = cy - 1; gy <= cy + 1 && occluder < 0; gy++) {
        if (gy < 0 || gy >= rows) continue;
        for (let p = head[gy * cols + gx] ?? -1; p !== -1; p = next[p] ?? -1) {
          probes++;
          const dx = (sx[p] ?? 0) - x;
          const dy = (sy[p] ?? 0) - y;
          const thresh = spacing * (r + (radii[p] ?? 0));
          if (dx * dx + dy * dy < thresh * thresh && !(ignore && ignore(i, p))) {
            occluder = p;
            break;
          }
        }
      }
    }
    if (occluder < 0) {
      kept[i] = 1;
      winners[i] = i;
      const c = cy * cols + cx;
      next[i] = head[c] ?? -1;
      head[c] = i;
    } else {
      winners[i] = occluder;
    }
  }
  return { kept, winners, probes };
}

/** A dense LOD-frontier-like screen: mostly 2-3 px leaves packed well past overlap, plus a share of
 *  aggregates up to the 26 px cap (the network default), some centres off-screen. Deterministic. */
function mixedFrontier(n: number, width: number, height: number, bigShare: number, seed = 11): { sx: Float64Array; sy: Float64Array; radii: Float64Array; order: Uint32Array } {
  let s = seed >>> 0;
  const rng = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const radii = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    sx[i] = rng() * (width + 60) - 30;
    sy[i] = rng() * (height + 60) - 30;
    radii[i] = rng() < bigShare ? 5 + rng() * 21 : 2 + rng();
  }
  // Importance order: aggregates first (as an LOD frontier's summed weights put them), then leaves.
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => (radii[b] ?? 0) - (radii[a] ?? 0));
  return { sx, sy, radii, order };
}

describe("declutterScreen per-glyph radius grid", () => {
  const W = 1104;
  const H = 900;

  it("keeps exactly the single-grid set and winners across radius mixes, orders, spacings and ignores", () => {
    const n = 20_000;
    const ignore = (i: number, j: number): boolean => (i * 7 + j) % 13 === 0;
    const cases: { name: string; bigShare: number; spacing: number; ordered: boolean; ignore?: (i: number, j: number) => boolean; radiusScale?: number }[] = [
      { name: "leaves + capped aggregates", bigShare: 0.05, spacing: 1, ordered: true },
      { name: "no aggregates (all 2-3 px)", bigShare: 0, spacing: 1, ordered: true },
      { name: "all aggregates", bigShare: 1, spacing: 1, ordered: true },
      { name: "index order + spacing 1.5", bigShare: 0.1, spacing: 1.5, ordered: false },
      { name: "cross-fade ignore", bigShare: 0.05, spacing: 1, ordered: true, ignore },
      { name: "sub-pixel radii (world sizeMode, low zoom)", bigShare: 0.05, spacing: 1, ordered: true, radiusScale: 0.05 },
      { name: "one huge glyph among leaves", bigShare: 0.0001, spacing: 1, ordered: true, radiusScale: 8 },
    ];
    for (const c of cases) {
      const { sx, sy, radii, order } = mixedFrontier(n, W, H, c.bigShare);
      if (c.radiusScale) for (let i = 0; i < n; i++) radii[i] = (radii[i] ?? 0) * c.radiusScale;
      radii[3] = 0; // a zero-radius glyph (still occluded by any glyph whose disc covers its centre)
      const ord = c.ordered ? order : undefined;
      const ref = singleGridReference(n, sx, sy, radii, ord, W, H, c.spacing, c.ignore);
      const out = new Uint8Array(n);
      const winners = new Int32Array(n).fill(-7);
      declutterScreen(n, sx, sy, radii, ord, W, H, c.spacing, out, declutterScratch(), c.ignore, winners);
      expect(firstMismatch(out, ref.kept), `${c.name}: kept`).toBe(-1);
      expect(firstMismatch(winners, ref.winners), `${c.name}: winners`).toBe(-1);
      // Without winners (the network LOD call shape) the kept set is the same.
      const bare = new Uint8Array(n);
      declutterScreen(n, sx, sy, radii, ord, W, H, c.spacing, bare, declutterScratch(), c.ignore);
      expect(firstMismatch(bare, ref.kept), `${c.name}: kept, no winners`).toBe(-1);
    }
  });

  it("tests each glyph against O(1) kept neighbours, not the whole 2·maxR cell (probe signature)", () => {
    // 5% aggregates up to 26 px set the single-grid cell to 52 px, so every rejected 2-3 px leaf used to
    // scan the ~9 · 52² px of kept leaves around it. The radius-class grid scans only its own class's
    // few cells (plus the sparse aggregate classes) — probes per glyph stay bounded as the leaves pack.
    const n = 200_000;
    const { sx, sy, radii, order } = mixedFrontier(n, W, H, 0.05);
    const scratch = declutterScratch();
    declutterScreen(n, sx, sy, radii, order, W, H, 1, new Uint8Array(n), scratch);
    const ref = singleGridReference(n, sx, sy, radii, order, W, H, 1);
    const perGlyph = scratch.probes / n;
    // Measured: single grid 52.6 probes/glyph here; radius-class grid 3.2.
    expect(ref.probes / n, "the fixture really is dense for the single grid").toBeGreaterThan(30);
    expect(perGlyph, `${perGlyph.toFixed(2)} probes/glyph`).toBeLessThan(8);
  });

  it("reuses the scratch across calls without reallocating once warm", () => {
    const n = 5_000;
    const { sx, sy, radii, order } = mixedFrontier(n, W, H, 0.05);
    const scratch = declutterScratch();
    const out = new Uint8Array(n);
    declutterScreen(n, sx, sy, radii, order, W, H, 1, out, scratch);
    const refs = { head: scratch.head, next: scratch.next, levelCell: scratch.levelCell, levelMaxR: scratch.levelMaxR, levelCols: scratch.levelCols, levelRows: scratch.levelRows, levelBase: scratch.levelBase };
    for (let k = 0; k < 4; k++) declutterScreen(n, sx, sy, radii, order, W, H, 1, out, scratch);
    expect(scratch.head).toBe(refs.head);
    expect(scratch.next).toBe(refs.next);
    expect(scratch.levelCell).toBe(refs.levelCell);
    expect(scratch.levelMaxR).toBe(refs.levelMaxR);
    expect(scratch.levelCols).toBe(refs.levelCols);
    expect(scratch.levelRows).toBe(refs.levelRows);
    expect(scratch.levelBase).toBe(refs.levelBase);
  });
});

function firstMismatch(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}
