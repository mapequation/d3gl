# Pass-through point rendering

**Date:** 2026-06-08
**Status:** Design approved, ready for implementation plan

## Problem

Rendering points caps out at ~4–7M and then fails: Canvas runs out of memory
around 6–7M, and WebGL silently stops drawing past ~4M while the record counter
keeps climbing (nothing shown on an empty map). The ceiling is **storage, not
rendering** — both backends read from `Scene`/`GroupData`, which retains every
point.

### Measured baseline

A node spike (`packages/d3gl/src/core/point-memory.bench.test.ts`) measured the
per-point heap cost of each representation (1M points; the CSV/one-drawable-per-row
case at 200K):

| Representation | Bytes/point | Crash ceiling @2GB / @4GB heap |
|---|---|---|
| Raw `Float32Array [x,y]` (user floor) | ~8 | ~250M+ |
| Raw `[{x,y}]` objects | 50 | 42M / 85M |
| d3gl `Scene.points()` batched (1 drawable) | 130 | 16.5M / 33M |
| `Scene.points()` + `buffers()` (both forms coexist) | 130 | 16.5M / 33M |
| d3gl `Scene.point()` — 1 drawable/point (CSV stream) | 481 | 4.5M / 8.9M |

The one-drawable-per-point streaming path costs **481 B/point — 60× the raw
floor** — and dies at ~4.5M, matching the observed ~4M WebGL cutoff. The
WebGL-specific cliff is compounded by the per-drawable color/flags **texture**
(fixed 256-wide, power-of-2 height → tens of GB at millions of drawables).

## Goal

A rendering mode that retains **zero** point data inside d3gl. The user owns the
raw data (ideally a `Float32Array`, ~8 B/pt); d3gl pulls from it to draw and
discards. This lifts the ceiling from ~4–16M to whatever the user's own array
costs (250M+ at the raw floor). Serves both huge static datasets and live
streaming through one path. Behaves identically on Canvas and WebGL.

This is the same data-ownership model as the pre-d3gl bioregions branch (user
keeps the data, redraws on demand), but folded into the library so userland stays
clean.

## API — additions only, no new methods

Two changes to the existing layer/`points()` API:

1. The **data argument accepts a function**, d3-style: `T[] | ((view?) => T[])`.
   A function is re-invoked on every full repaint, so the user grows/swaps their
   own array and d3gl always pulls the latest. The function **may** receive the
   current view (`transform` / viewport) so the user can cull/LOD — return only
   on-screen points. Optional.
2. A **`passThrough: true`** opt switches off retention for that layer.

```js
// user owns the data — d3gl stores a reference/closure, never a copy
chart.points("nodes", () => state.points, {
  x: d => d.lon, y: d => d.lat,
  radius: 2, fill: d => d.color,
  passThrough: true,            // ← do not retain in Scene
});

// streaming load: grow your own array, draw ONLY the new batch
for (const batch of csvBatches) {
  state.points.push(...batch);
  handle.append(batch);         // incremental: draws batch on top, O(new)
}
```

Same accessors (`x`/`y`/`radius`/`fill`), same handle. `passThrough` is the only
new concept.

### Two distinct draw operations

| Operation | Trigger | Cost | Reads |
|---|---|---|---|
| **Incremental draw** | `handle.append(batch)` | O(new) | the `batch` only |
| **Full repaint** | pan / zoom / resize / base-map redraw | O(total), time-sliced | the data callback (everything) |

`append` never clears; it draws the new batch on top of what's already there.
A full repaint clears and re-pulls the entire dataset via the callback.

## Internals

### Accumulation buffer (the persistence mechanism)

Each pass-through layer renders into a **screen-sized accumulation buffer** —
O(pixels), **not** O(points). This is what gives WebGL canvas-like persistence
without retaining points, and makes `append` O(new) on both backends.

- **Canvas** persists natively — the canvas *is* the accumulation buffer.
  `append` draws the batch straight on; no clear.
- **WebGL** clears every frame, so the layer renders into its own **offscreen
  FBO**. Every frame composites `[base map] + [points FBO]`. `append` draws the
  batch into the FBO; a full repaint clears the FBO and re-pulls all.

### Per-point draw path

On each repaint d3gl: pull array → apply accessors → project → draw → discard.
d3gl's per-point retained memory is **zero**.

- **Canvas:** iterate, `ctx.arc()` per point. Inherently streaming.
- **WebGL:** draw in fixed-size **chunks** (e.g. 1M points) through a single
  *reused* scratch buffer, **instanced** (1 vertex of per-point data, not the 4×
  quad expansion), looping until the batch is drawn. GPU memory stays O(chunk),
  reused across frames and repaints.
- **Per-point color is a vertex/instance attribute, not a texture-table lookup.**
  This removes the per-drawable color-texture growth that is the WebGL-specific
  multi-GB cliff.

### Interaction — snapshot-pan (Google-Maps style)

During pan/zoom d3gl does **not** re-pull or redraw points. It composites the
existing accumulation buffer (FBO / canvas snapshot) with the live transform
applied — a transformed blit, O(pixels), GPU-cheap. Points pan/zoom along with
the map as a slightly-stale raster (softens on large zooms), then snap to crisp
re-rendered points on gesture settle. The full 10M array is never touched
mid-gesture.

### Time-sliced full repaint

A full repaint of millions synchronously would freeze the main thread for
hundreds of ms+. Instead the full-repaint path draws in **chunks across
animation frames** (e.g. 1M/chunk through the reused scratch buffer), yielding
between chunks — points fill in progressively over a few frames, no freeze. A
new interaction **cancels** any in-flight sliced repaint and restarts it. During
streaming load each `append(batch)` is small (one frame, no slicing); slicing
only applies to whole-dataset repaints after a transform change.

## Standard vs pass-through: mechanics, speed, memory

Step-by-step for **1M point objects**. Memory bins (rough, estimate-for-now):
**Negligible** <5 MB · **Low** 5–50 MB · **Medium** 50–200 MB · **High** 200 MB+ ·
**Extreme** GBs / OOM. Speed bins per operation: **Instant** <1 ms · **Fast**
1–16 ms (one frame) · **Slow** 16–100 ms · **Janky** 100 ms+ (visible freeze).

### Standard mode (retained)

Shared build, then per-backend upload/draw.

| Step | What happens | Why | 1M cost |
|---|---|---|---|
| Accessors + project | map each datum → world coords | place the points | O(n), Slow |
| `Scene.addCircleDrawable` | retain in `GroupData` (objects + arrays + id Map) | enables recolor, append, hit-test, backend swap | O(n), **High** (~130 MB) |
| `Scene.buffers()` | assemble GPU-ready typed arrays (a second copy) | upload format | O(n), +Medium |

**Canvas**

| Step | What | Why | 1M cost |
|---|---|---|---|
| store drawables | keep array to redraw | canvas is immediate-mode | Medium (CPU) |
| `render()` | clear + `ctx.arc()` per point | rasterize | O(n) **Janky** |
| pan/zoom | full re-render (reproject all) | no retained vector transform | O(n)/gesture frame → **Janky** |
| `append(batch)` | draw batch on top, no clear | incremental | O(new), Fast |

**WebGL**

| Step | What | Why | 1M cost |
|---|---|---|---|
| expand + upload | quad/instance geometry → persistent `GrowBuffer`s | GPU vertex data | GPU **Medium** |
| color/flags texture | per-drawable attrs in 256-wide `GrowTexture` | shader lookup by id | GPU grows → **Extreme** at scale (the WebGL cliff) |
| draw frame | 1 draw call, transform as uniform | geometry stays world-space, reprojected in shader | **Instant**, crisp |
| pan/zoom | update uniform only | no re-upload, crisp at any zoom | **Instant** |
| `append(batch)` | grow buffers/texture by tail | incremental | O(new), Fast |

**SVG**: serializes one `<circle>` per point into the DOM. Infeasible well below
1M (DOM node limits ~100k); world pan/zoom is an O(1) `<g transform>` update.

### Pass-through mode

Common to all backends: store the data callback + accessors. **No `Scene` entry,
no typed-array copy. d3gl retention ≈ Negligible.**

**Canvas**

| Step | What | Why | 1M cost |
|---|---|---|---|
| full repaint | pull array → accessors → project → `ctx.arc`, **chunked across frames** | rasterize directly, retain nothing | O(n) but **time-sliced** (no single freeze), progressive fill-in |
| `append(batch)` | project + draw batch on top | incremental | O(new), Fast |
| pan/zoom | blit existing canvas snapshot with live transform | snapshot-pan, avoid O(n) re-pull mid-gesture | O(pixels) **Fast**, soft raster |
| memory | d3gl ≈ Negligible; canvas bitmap = screen-sized | flat in point count | **Low** |

**WebGL**

| Step | What | Why | 1M cost |
|---|---|---|---|
| full repaint | pull → accessors → project into **reused scratch buffer** → **instanced** draw in **chunks** into offscreen FBO, **time-sliced** | persistence via FBO; scratch bounded to chunk | O(n) time-sliced, progressive |
| color | per-point **instance attribute**, no texture table | removes the per-drawable texture cliff | — |
| `append(batch)` | draw batch into the FBO | incremental | O(new), Fast |
| pan/zoom | composite FBO with live transform (blit) | snapshot-pan | O(pixels) **Fast**, soft raster |
| memory | d3gl ≈ Negligible; screen-sized FBO + O(chunk) scratch | flat in point count | **Low** |

**SVG**: **not supported** — `passThrough` on an SVG backend throws (fail-fast).
SVG is a retained vector DOM for export/editing; the raster accumulation/snapshot
model does not apply and 1M nodes is infeasible. With the `auto` backend,
`passThrough` applies only to the canvas/WebGL surfaces.

### Summary @ 1M points

| | Standard Canvas | Standard WebGL | Pass-through Canvas | Pass-through WebGL |
|---|---|---|---|---|
| Initial load | Slow, High mem | Slow, High mem | Fast, flat mem | Fast, flat mem |
| Idle frame | free | free | free | free |
| Pan/zoom frame | **Janky** O(n) | **Instant**, crisp | Fast O(px), soft | Fast O(px), soft |
| Repaint after settle | O(n) | none needed | O(n) sliced, progressive | O(n) sliced, progressive |
| d3gl memory | High (~130 MB) | High + GPU texture | **Negligible** | **Negligible** |
| Ceiling before OOM | ~6–7M | ~4M | user-array bound (250M+) | user-array bound (250M+) |
| Crisp during pan | n/a (janky) | **yes** | no (soft until settle) | no (soft until settle) |
| Picking | yes | yes | no | no |
| Geometry | all | all | points/multipoints (v1) | points/multipoints (v1) |

## When to use which

**Standard mode** — best for interactivity and correctness up to a few million:
- Pros: always crisp; instant crisp pan/zoom on WebGL; picking; per-feature
  recolor/flags; all geometry (polygons, lines, points).
- Cons: retains 130–481 B/pt → caps ~4–16M; Canvas pan is janky at large n;
  WebGL color texture adds GPU pressure.
- **Use when** the dataset is up to a few million and you need crisp interaction,
  hit-testing, per-feature updates, or non-point geometry.

**Pass-through mode** — best for scale and streaming:
- Pros: ≈0 d3gl retention → scales to the user-array limit (250M+); flat memory
  regardless of count; `append` is O(new) (ideal for live ingestion); identical
  on canvas + WebGL.
- Cons: soft/stale raster during pan (crisp only after settle); every transform
  change triggers an O(n) repaint (time-sliced/progressive, not frozen); no
  picking; points/multipoints only (v1); the user must own and retain the raw
  data.
- **Use when** rendering huge point clouds (millions–tens of millions) or
  streaming/live data, where brief pan softness and re-render-on-settle are
  acceptable and picking is not needed.

One-liner: **standard = crisp + interactive but capped; pass-through = uncapped +
streaming but a stale raster during gestures.**

## Scope decisions

- **Geometry: points + multipoints in v1.** The architecture generalizes to any
  layer, but polygons/lines need per-frame tessellation/stroke-expansion
  (expensive every repaint). Ship points first — that is the OOM case — and
  leave heavier geometry as a documented follow-up rather than pretend it is
  free.
- **`pickable: false` for pass-through.** Hit-testing needs an O(N) spatial index
  = retention again. Pass-through layers are not pickable; callers needing
  picking hit-test against their own data (as bioregions did).
- **Optional culling hook.** The data callback may receive the current view
  (`transform` / viewport) to return only on-screen points for LOD/culling.

## Explicitly out of scope (orthogonal future work)

- **Web Worker / OffscreenCanvas rendering.** Time-slicing solves the
  main-thread freeze now. The chunked architecture is deliberately shaped so the
  chunk loop can later move into a worker (off-thread projection) or
  OffscreenCanvas (whole render off-thread) **without any API change** — the
  `passThrough` layer contract stays identical. Tracked separately.

## Documentation & examples

Pass-through is a user-facing feature, so it ships with docs and an example
(per the repo's "document new features on the website" rule):

- **Website example** under the **Streaming data** group — streaming is the
  natural showcase for pass-through. Extend/sibling the existing
  `website/src/examples/streaming-points/`, demonstrating `passThrough: true`
  with a data callback and `handle.append(batch)` ingestion, plus a
  point-count/memory overlay contrasting it with standard mode.
- **Guide page**: extend `website/src/content/docs/examples/map/streaming.mdx`
  (or a new pass-through page) covering the when/why — lead with the
  standard-vs-pass-through trade-off table and the "when to use which" guidance
  from this spec.
- **Reference**: document the new `passThrough` option and the data-callback form
  on the relevant option interfaces (`LayerOptions`, `PlotPointOptions`,
  React `PointsProps`) so they surface in the generated reference.

## Success criteria

- A `passThrough: true` points layer renders 10M+ points without OOM, with d3gl
  retaining no per-point data (verified: heap stays flat as point count grows;
  the user's array is the only O(N) cost).
- `handle.append(batch)` draws only the new batch (O(new)), on both backends.
- Pan/zoom is smooth at 10M points (snapshot-pan, no per-frame re-pull); a full
  repaint after settle fills in progressively without freezing the main thread.
- Identical visual behavior across Canvas and WebGL backends.
