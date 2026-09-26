// Shared screen-space declutter — one engine for the network LOD frontier (per-glyph radius +
// importance) and the map/geo layers (uniform centre-exclusion), so there are not two parallel
// implementations. The caller projects glyphs to screen pixels and supplies a visit order (importance
// descending); this keeps the survivor of each overlapping cluster.

/** Most radius classes the per-glyph grid splits into (each class halves the cell of the one above). */
const MAX_LEVELS = 8;
/** The empty `seq` a call without `winners` indexes nothing from. */
const NO_SEQ = new Int32Array(0);

/**
 * Reusable grid scratch so a per-frame caller (geo declutter runs on every zoom) allocates nothing.
 * Only `head` and `next` are required — a hand-built `{ head, next }` works; the per-glyph form creates
 * the rest on first use. Build it with {@link declutterScratch} to have them from the start.
 */
export interface DeclutterScratch {
  /** Per-cell list heads (per-glyph radius form: every radius class's grid back to back). */
  head: Int32Array;
  /** Intrusive per-cell list link, per glyph. */
  next: Int32Array;
  /** Per-radius-class grid tables for the per-glyph radius form (created on first use). */
  levels?: DeclutterLevels;
  /** Insertion rank of each kept glyph — per-glyph radius form with `winners` only (grown on use). */
  seq?: Int32Array;
  /** Distance tests the last call ran — the deterministic cost signature per-frame guards assert. */
  probes?: number;
}

/** The per-radius-class tables of {@link DeclutterScratch} (at most {@link MAX_LEVELS} classes). */
export interface DeclutterLevels {
  /** Cell size in px, coarsest (= 2·spacing·maxR) first. */
  cell: Float64Array;
  /** 1 / cell size (cell indices multiply — no division per candidate). */
  inv: Float64Array;
  /** Largest radius inserted so far this call (−1 = empty class). */
  maxR: Float64Array;
  /** Grid columns, rows, and the offset of the class's cells in {@link DeclutterScratch.head}. */
  cols: Int32Array;
  rows: Int32Array;
  base: Int32Array;
}

function declutterLevels(): DeclutterLevels {
  return {
    cell: new Float64Array(MAX_LEVELS),
    inv: new Float64Array(MAX_LEVELS),
    maxR: new Float64Array(MAX_LEVELS),
    cols: new Int32Array(MAX_LEVELS),
    rows: new Int32Array(MAX_LEVELS),
    base: new Int32Array(MAX_LEVELS),
  };
}

/** A fresh, empty scratch (grown lazily on first use). Hold one per engine and pass it in to reuse it. */
export function declutterScratch(): DeclutterScratch {
  return { head: new Int32Array(0), next: new Int32Array(0), levels: declutterLevels(), seq: new Int32Array(0), probes: 0 };
}

/**
 * Greedy screen-space declutter. Visits glyphs in `order` (importance descending; omitted ⇒ index
 * order) and keeps each unless its centre is within `spacing·(rᵢ + rⱼ)` of an already-kept glyph — so
 * the drawn circles don't overlap and the most important glyph in a cluster survives. A glyph whose
 * centre is off-screen is always kept and never occludes others (so panning never culls what's barely
 * out of view). O(n): a uniform radius uses one grid sized to the exclusion radius, so any overlapping
 * pair falls in the 3×3 cell neighbourhood. Per-glyph radii use one grid per **radius class** (cell
 * sizes halving down from 2·spacing·maxR): each kept glyph goes into the class that fits its own
 * radius, and a candidate scans each class over its reach `spacing·(r + that class's largest radius)`.
 * So a small glyph beside a few big ones scans the few cells around it, not a cell sized to the biggest
 * glyph (with the network's 26 px aggregate cap and 2-3 px leaves that was ~9·52² px of packed kept
 * leaves per rejected leaf). Same kept set and winners as the single grid (the winner is the occluder
 * the single grid's scan order meets first).
 *
 * `sx`/`sy` are screen-pixel centres. `radius` is the per-glyph exclusion radius in px — a number for
 * the uniform case (a point layer's fixed spacing is passed as **half** the centre-to-centre distance,
 * since two glyphs collide when `dist < rᵢ + rⱼ`). A per-glyph radius below 0 counts as 0 (a point).
 * `out` (length ≥ `count`, written in index order) and `scratch` are reused across frames by the
 * caller. Returns `out`.
 *
 * `ignore(i, j)` (optional) drops a specific overlap from the test: when candidate `i` would be occluded
 * by an already-kept glyph `j`, returning true means "not a real overlap" so `i` is not culled by `j`
 * (but is still tested against every other glyph, and still occludes others). Used by the LOD cross-fade
 * (#133): a glyph transitioning across the expand threshold ignores its **ancestor** as an occluder — so
 * a fading parent doesn't cull its fading-in children — while children still declutter against siblings.
 * Omitted ⇒ no ignored pairs (zero added cost).
 *
 * `winners` (optional, length ≥ `count`) records, for each glyph, the **kept** glyph it is represented by:
 * a kept glyph maps to itself (`winners[i] = i`), a hidden glyph to the already-kept glyph that occluded
 * it (`winners[i] = p`). One extra store per glyph in the loop we already run. Lets a hit on the kept
 * survivor enumerate the glyphs absorbed under it (`members()`): scan for all `i` with `winners[i] === K`
 * (#105 N7c-2). Omitted ⇒ not tracked (zero added cost).
 */
export function declutterScreen(
  count: number,
  sx: ArrayLike<number>,
  sy: ArrayLike<number>,
  radius: ArrayLike<number> | number,
  order: ArrayLike<number> | undefined,
  width: number,
  height: number,
  spacing: number,
  out: Uint8Array,
  scratch: DeclutterScratch = declutterScratch(),
  ignore?: (i: number, j: number) => boolean,
  winners?: Int32Array,
): Uint8Array {
  // Branch once on the radius form and run a fully specialized loop per form (#233). Two V8
  // pitfalls make anything less allocate O(count + collision tests) transient HeapNumbers
  // (~40 MB/call at count = 300k, churned by every per-frame caller):
  //   1. reading through a `radAt` closure — each call returns a fresh non-Smi double across a
  //      non-inlined call boundary, which must be boxed;
  //   2. a mixed-representation ternary (`radii ? radii[i] : uniformR`) inside a shared loop —
  //      the phi forces the float64 array load to a tagged value, boxing one double per read
  //      even when the call is monomorphic (measured with the sampling heap profiler).
  // Direct monomorphic indexed reads inside per-form loops keep the doubles unboxed in registers.
  const radii = typeof radius === "number" ? undefined : radius;
  const uniformR = typeof radius === "number" ? radius : 0;
  let maxR = 1;
  let minR = Infinity;
  if (radii) {
    for (let i = 0; i < count; i++) {
      const r = Math.max(radii[i]!, 0); // a negative radius counts as a point (NaN stays NaN)
      if (r > maxR) maxR = r;
      if (r < minR) minR = r;
    }
  } else if (count > 0 && uniformR > maxR) {
    maxR = uniformR;
  }

  // Cell = the largest possible exclusion threshold (2·spacing·maxR), so any colliding pair lands in
  // the 3×3 neighbourhood. Intrusive linked list of kept glyphs per cell (no per-cell allocation).
  const cell = Math.max(2 * maxR * spacing, 1);
  const cols = Math.floor(width / cell) + 3;
  const rows = Math.floor(height / cell) + 3;
  if (scratch.next.length < count) scratch.next = new Int32Array(count);
  const next = scratch.next;
  let probes = 0;

  // The two loops below differ in how they find the kept glyphs near a candidate; the collision test
  // itself is identical — keep it in sync (the byte-identity tests in declutter-alloc.bench.test.ts and
  // core/__tests__/declutter.test.ts compare both against the single-grid reference).
  if (radii) {
    // Per-glyph radius (the network LOD frontier shape): one grid per radius class. Class 0 is the
    // single grid above; each finer class halves the cell, down to the smallest glyph's exclusion
    // diameter — or to ~one cell per glyph, past which a finer grid only adds empty cells to clear.
    const lv = (scratch.levels ??= declutterLevels());
    const levelCell = lv.cell;
    const levelInv = lv.inv;
    const levelMaxR = lv.maxR;
    const levelCols = lv.cols;
    const levelRows = lv.rows;
    const levelBase = lv.base;
    const minCell = Math.max(2 * spacing * minR, Math.sqrt((width * height) / Math.max(count, 4096)));
    let levels = 0;
    let nCells = 0;
    for (let c = cell; levels < MAX_LEVELS && (levels === 0 || c >= minCell); c /= 2) {
      const lc = Math.floor(width / c) + 3;
      const lr = Math.floor(height / c) + 3;
      levelCell[levels] = c;
      levelInv[levels] = 1 / c;
      levelCols[levels] = lc;
      levelRows[levels] = lr;
      levelBase[levels] = nCells;
      levelMaxR[levels] = -1;
      nCells += lc * lr;
      levels++;
    }
    if (scratch.head.length < nCells) scratch.head = new Int32Array(nCells);
    const head = scratch.head;
    head.fill(-1, 0, nCells);
    // `winners` records the occluder the single grid met first: its 3×3 cells in column-major order,
    // newest-kept first within a cell. The classes find every occluder, so rank them by that order —
    // (single-grid cell rank, insertion rank) — and keep the least.
    let seq = scratch.seq ?? NO_SEQ;
    if (winners && seq.length < count) seq = scratch.seq = new Int32Array(count);
    const rankSpan = count + 1;
    let inserted = 0;
    for (let oi = 0; oi < count; oi++) {
      const i = order ? order[oi]! : oi;
      const x = sx[i]!;
      const y = sy[i]!;
      const r = Math.max(radii[i]!, 0);
      if (x < 0 || y < 0 || x > width || y > height) {
        out[i] = 1; // off-screen centre ⇒ keep, and don't insert (so it can't occlude on-screen glyphs)
        if (winners) winners[i] = i; // a kept glyph represents itself
        continue;
      }
      let cx = 0;
      let cy = 0;
      if (winners) {
        cx = Math.floor(x / cell) + 1;
        cy = Math.floor(y / cell) + 1;
        cx = cx < 0 ? 0 : cx >= cols ? cols - 1 : cx;
        cy = cy < 0 ? 0 : cy >= rows ? rows - 1 : cy;
      }
      let occluder = -1;
      let best = 0; // the occluder's rank (winners only); meaningful once occluder ≥ 0
      // Finest class first: where small glyphs pack, a rejected one is usually covered by a kept
      // neighbour of its own size, so most rejections stop after scanning one class.
      scan: for (let L = levels - 1; L >= 0; L--) {
        const lr = levelMaxR[L]!;
        if (lr < 0) continue; // nothing kept in this class yet
        const inv = levelInv[L]!;
        const lc = levelCols[L]!;
        const base = levelBase[L]!;
        // Every glyph of this class that can overlap lies within `reach` of the centre (padded so the
        // cell arithmetic's rounding never drops a neighbour on a cell boundary; extra cells are harmless).
        const reach = spacing * (r + lr) * (1 + 1e-9) + 1e-6;
        let gx0 = Math.floor((x - reach) * inv) + 1;
        let gx1 = Math.floor((x + reach) * inv) + 1;
        let gy0 = Math.floor((y - reach) * inv) + 1;
        let gy1 = Math.floor((y + reach) * inv) + 1;
        if (gx0 < 0) gx0 = 0;
        if (gy0 < 0) gy0 = 0;
        if (gx1 >= lc) gx1 = lc - 1;
        if (gy1 >= levelRows[L]!) gy1 = levelRows[L]! - 1;
        for (let gx = gx0; gx <= gx1; gx++) {
          for (let gy = gy0; gy <= gy1; gy++) {
            for (let p = head[base + gy * lc + gx]!; p !== -1; p = next[p]!) {
              probes++;
              const dx = sx[p]! - x;
              const dy = sy[p]! - y;
              const thresh = spacing * (r + Math.max(radii[p]!, 0)); // circles must not overlap
              if (dx * dx + dy * dy < thresh * thresh) {
                if (ignore && ignore(i, p)) continue; // e.g. a cross-fading glyph ignores its ancestor
                if (!winners) {
                  occluder = p;
                  break scan;
                }
                let px = Math.floor(sx[p]! / cell) + 1;
                let py = Math.floor(sy[p]! / cell) + 1;
                px = px < 0 ? 0 : px >= cols ? cols - 1 : px;
                py = py < 0 ? 0 : py >= rows ? rows - 1 : py;
                const rank = ((px - cx + 1) * 3 + (py - cy + 1)) * rankSpan - seq[p]!;
                if (occluder < 0 || rank < best) {
                  best = rank;
                  occluder = p;
                }
              }
            }
          }
        }
      }
      if (occluder < 0) {
        out[i] = 1;
        if (winners) {
          winners[i] = i; // a kept glyph represents itself
          seq[i] = inserted++;
        }
        // Into the finest class whose cell still spans this glyph's exclusion diameter.
        const d = 2 * spacing * r;
        let L = 0;
        while (L + 1 < levels && levelCell[L + 1]! >= d) L++;
        const inv = levelInv[L]!;
        const lc = levelCols[L]!;
        const lr = levelRows[L]!;
        let gx = Math.floor(x * inv) + 1;
        let gy = Math.floor(y * inv) + 1;
        gx = gx < 0 ? 0 : gx >= lc ? lc - 1 : gx;
        gy = gy < 0 ? 0 : gy >= lr ? lr - 1 : gy;
        const k = levelBase[L]! + gy * lc + gx;
        next[i] = head[k]!;
        head[k] = i;
        if (r > levelMaxR[L]!) levelMaxR[L] = r;
      } else {
        out[i] = 0;
        if (winners) winners[i] = occluder; // absorbed under the kept glyph that occluded it
      }
    }
  } else {
    // Uniform radius (the geo/map and plot points-lane shape): the collision threshold is the
    // same for every pair, so hoist it (bit-identical to computing it per test).
    const nCells = cols * rows;
    if (scratch.head.length < nCells) scratch.head = new Int32Array(nCells);
    const head = scratch.head;
    head.fill(-1, 0, nCells);
    const thresh = spacing * (uniformR + uniformR);
    const thresh2 = thresh * thresh;
    for (let oi = 0; oi < count; oi++) {
      const i = order ? order[oi]! : oi;
      const x = sx[i]!;
      const y = sy[i]!;
      if (x < 0 || y < 0 || x > width || y > height) {
        out[i] = 1; // off-screen centre ⇒ keep, and don't insert (so it can't occlude on-screen glyphs)
        if (winners) winners[i] = i; // a kept glyph represents itself
        continue;
      }
      let cx = Math.floor(x / cell) + 1;
      let cy = Math.floor(y / cell) + 1;
      cx = cx < 0 ? 0 : cx >= cols ? cols - 1 : cx;
      cy = cy < 0 ? 0 : cy >= rows ? rows - 1 : cy;
      let occluded = false;
      for (let gx = cx - 1; gx <= cx + 1 && !occluded; gx++) {
        if (gx < 0 || gx >= cols) continue;
        for (let gy = cy - 1; gy <= cy + 1 && !occluded; gy++) {
          if (gy < 0 || gy >= rows) continue;
          for (let p = head[gy * cols + gx]!; p !== -1; p = next[p]!) {
            probes++;
            const dx = sx[p]! - x;
            const dy = sy[p]! - y;
            if (dx * dx + dy * dy < thresh2) {
              if (ignore && ignore(i, p)) continue; // e.g. a cross-fading glyph ignores its ancestor
              occluded = true;
              if (winners) winners[i] = p; // absorbed under the kept glyph that occluded it
              break;
            }
          }
        }
      }
      if (!occluded) {
        out[i] = 1;
        if (winners) winners[i] = i; // a kept glyph represents itself
        const c = cy * cols + cx;
        next[i] = head[c]!;
        head[c] = i;
      } else {
        out[i] = 0;
      }
    }
  }
  scratch.probes = probes;
  return out;
}

/**
 * Enumerate the glyphs a kept survivor represents from a {@link declutterScreen} `winners` array:
 * every glyph mapped to `kept` (including `kept` itself, which maps to itself). O(count) inverse scan —
 * run lazily on a hit (`members()`), never per frame. Returns indices in source order.
 */
export function declutterMembers(winners: Int32Array, kept: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (winners[i] === kept) out.push(i);
  return out;
}
