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
  if (radii) {
    for (let i = 0; i < count; i++) {
      const r = radii[i]!;
      if (r > maxR) maxR = r;
    }
  } else if (count > 0 && uniformR > maxR) {
    maxR = uniformR;
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

  // The two loops below are identical except for how the exclusion radius is read — keep them in
  // sync (the byte-identity test in declutter-alloc.bench.test.ts compares both against a reference).
  if (radii) {
    // Per-glyph radius (the network LOD frontier shape).
    for (let oi = 0; oi < count; oi++) {
      const i = order ? order[oi]! : oi;
      const x = sx[i]!;
      const y = sy[i]!;
      const r = radii[i]!;
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
            const dx = sx[p]! - x;
            const dy = sy[p]! - y;
            const thresh = spacing * (r + radii[p]!); // circles must not overlap
            if (dx * dx + dy * dy < thresh * thresh) {
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
  } else {
    // Uniform radius (the geo/map and plot points-lane shape): the collision threshold is the
    // same for every pair, so hoist it (bit-identical to computing it per test).
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
