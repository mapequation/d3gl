// Shared screen-space declutter — one engine for the network LOD frontier (per-glyph radius +
// importance) and the map/geo layers (uniform centre-exclusion), so there are not two parallel
// implementations. The caller projects glyphs to screen pixels and supplies a visit order (importance
// descending); this keeps the survivor of each overlapping cluster.

/** Reusable grid scratch so a per-frame caller (geo declutter runs on every zoom) allocates nothing. */
export interface DeclutterScratch {
  head: Int32Array;
  next: Int32Array;
}

/** A fresh, empty scratch (grown lazily on first use). Hold one per engine and pass it in to reuse it. */
export function declutterScratch(): DeclutterScratch {
  return { head: new Int32Array(0), next: new Int32Array(0) };
}

/**
 * Greedy screen-space declutter. Visits glyphs in `order` (importance descending; omitted ⇒ index
 * order) and keeps each unless its centre is within `spacing·(rᵢ + rⱼ)` of an already-kept glyph — so
 * the drawn circles don't overlap and the most important glyph in a cluster survives. A glyph whose
 * centre is off-screen is always kept and never occludes others (so panning never culls what's barely
 * out of view). O(n) via a uniform grid sized to the largest exclusion radius, so any overlapping pair
 * falls in the 3×3 cell neighbourhood.
 *
 * `sx`/`sy` are screen-pixel centres. `radius` is the per-glyph exclusion radius in px — a number for
 * the uniform case (a point layer's fixed spacing is passed as **half** the centre-to-centre distance,
 * since two glyphs collide when `dist < rᵢ + rⱼ`). `out` (length ≥ `count`, written in index order) and
 * `scratch` are reused across frames by the caller. Returns `out`.
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
): Uint8Array {
  const radAt = typeof radius === "number" ? (_i: number) => radius : (i: number) => radius[i]!;
  let maxR = 1;
  for (let i = 0; i < count; i++) {
    const r = radAt(i);
    if (r > maxR) maxR = r;
  }

  // Cell = the largest possible exclusion threshold (2·spacing·maxR), so any colliding pair lands in
  // the 3×3 neighbourhood. Intrusive linked list of kept glyphs per cell (no per-cell allocation).
  const cell = Math.max(2 * maxR * spacing, 1);
  const cols = Math.floor(width / cell) + 3;
  const rows = Math.floor(height / cell) + 3;
  const nCells = cols * rows;
  if (scratch.head.length < nCells) scratch.head = new Int32Array(nCells);
  if (scratch.next.length < count) scratch.next = new Int32Array(count);
  const head = scratch.head;
  const next = scratch.next;
  head.fill(-1, 0, nCells);

  for (let oi = 0; oi < count; oi++) {
    const i = order ? order[oi]! : oi;
    const x = sx[i]!;
    const y = sy[i]!;
    const r = radAt(i);
    if (x < 0 || y < 0 || x > width || y > height) {
      out[i] = 1; // off-screen centre ⇒ keep, and don't insert (so it can't occlude on-screen glyphs)
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
          const dx = sx[p]! - x;
          const dy = sy[p]! - y;
          const thresh = spacing * (r + radAt(p)); // circles must not overlap
          if (dx * dx + dy * dy < thresh * thresh) {
            occluded = true;
            break;
          }
        }
      }
    }
    if (!occluded) {
      out[i] = 1;
      const c = cy * cols + cx;
      next[i] = head[c]!;
      head[c] = i;
    } else {
      out[i] = 0;
    }
  }
  return out;
}
