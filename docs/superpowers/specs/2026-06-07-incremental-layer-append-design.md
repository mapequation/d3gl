# Incremental layer append — design

**Date:** 2026-06-07
**Branch:** `feat/incremental-rendering`
**Status:** Approved (design); ready for implementation plan

## Problem

`GeoMap.layer(name, …)` (and `Plot.layer`/`Plot.points`) fully re-register a layer on
every call: `registerLayer` → `Scene.group(name, build)` rebuilds the group from a fresh
`GroupData`, re-applies accessors over all data, rebuilds the `HitIndex` over all
drawables, and calls `backend.setLayers(<all layers>)`. The `build` closure
(`geoLayer`) **re-projects every feature**.

So adding `n` more features to a layer that already has `m` costs `O(m + n)` in
projection, tessellation/point-packing, hit-index, and GPU upload. Streaming species
occurrences into Infomap Bioregions (one batch after another) is therefore quadratic in
the total point count and cannot update live cheaply.

## Goal

Add an **incremental append** path so a streamed batch projects/builds **only the new
items** and re-pushes **only the affected layer** — existing features are never
re-projected. The mechanism must work for **any layer type** (projected GeoJSON features
*and* scatter-plot points), and the append-structured nature of the internals must be
exposed all the way up to the user.

### Non-goals

- True GPU sub-buffer upload (`bufferSubData`) — deferred. The API and internal seams are
  designed so a GPU fast-path can drop in later **without any public API change** (see
  §"GPU seam").
- A `removeLayer` / `handle.remove()` — YAGNI; no removal API exists today.

## Decisions (from brainstorming)

1. **API surface — layer handle.** `layer()`/`points()` return a `LayerHandle` instead of
   `this`. The handle exposes `append(items)` (plus thin `recolor()`/`setClip()`
   delegations). This matches the requested `layer.append(features)` shape and works
   uniformly for `GeoMap` and `Plot`. Returning a handle instead of `this` is non-breaking
   in practice: no current call site (src, tests, website, React wrappers) uses the chained
   return value.
2. **Incrementality depth — CPU-incremental now, GPU-ready API.** Per batch: project only
   the new items, then re-serialize + re-upload the one affected layer's full GPU buffers.
   This removes the projection blow-up (the expensive part); the buffer copy is a cheap
   typed-array memcpy. The backend gains an optional append seam for a future GPU
   sub-buffer fast-path.
3. **IDs / identity — continue index, honor accessor, throw on dup.** Default auto-id
   continues from the layer's current length (no restart-at-0 collision). A layer created
   with an `id` accessor uses it for appended items too. A duplicate id throws (fail-fast,
   matching `Scene`'s existing invalid-color-throws philosophy); callers dedupe upstream.

## Architecture

### Component changes

| Layer | Change |
|---|---|
| `core/scene.ts` | Add `Scene.appendToGroup(name, build)` — appends drawables to the **existing** `GroupData` (vs `group()`, which replaces). Refactor the `GroupBuilder` closure so `group`/`appendToGroup` share it. Add a **dup-id guard** in `addDrawable`/`addCircleDrawable`: throw if `idToDrawable` already contains the id. |
| `core/hit-test.ts` | Add `HitIndex.append(drawables)` — push more entries onto `entries`. Extract the per-drawable entry construction from the constructor loop so both share it. |
| `core/backend.ts` | Add **optional** `appendToLayer?(name, layer, addedFrom)` to the `Backend` interface — the GPU seam (`addedFrom` = the drawable/vertex index where appended data begins). Unimplemented now; documented contract only. |
| `map/base-engine.ts` | Add protected `appendToLayer(name, items, ids, build)` — the generic plumbing. Refactor `applyAccessors(spec, start = 0)` to color only a sub-range. |
| `map/geo-map.ts` | `layer()` returns a `LayerHandle`. Its append extends the layer's `def.list` (the rebuild source) and projects **only the new features** via `geoLayer(newItems, projection, …)`. |
| `map/plot.ts` | `layer()` and `points()` return a `LayerHandle`. Append re-uses the same draw/point build over the new data. |
| `map/layer-handle.ts` (new) | `LayerHandle` class: `append(items)` + thin `recolor()` / `setClip(clipTo?)` delegations. All return the handle (chainable on the layer). |

### `LayerHandle` (shape)

```ts
class LayerHandle<D = any> {
  readonly name: string;
  // Constructed by each engine with an append closure that owns the geometry build.
  append(items: readonly D[] | D): this; // single item or array; empty array = no-op
  recolor(): this;                       // delegates BaseEngine.recolor(name)
  setClip(clipTo?: string): this;        // delegates BaseEngine.setClip(name, clipTo)
}
```

The handle closes over the engine + the layer's build recipe. Each engine constructs the
handle with its own append closure (GeoMap projects; Plot draws/points), so geometry logic
stays in the subclass and the handle stays generic.

### `BaseEngine.appendToLayer` (generic plumbing)

```ts
protected appendToLayer(
  name: string,
  items: readonly any[],
  ids: (string | number)[],          // already offset/accessor-resolved by the caller
  build: (g: GroupBuilder) => void,  // builds ONLY the new items' drawables
): void
```

Steps:
1. `spec = specs.find(name)`; throw `unknown layer: <name>` if missing.
2. `offset = spec.data.length` (start of the new range).
3. `scene.appendToGroup(name, build)` — appends drawables; throws on dup id.
4. `spec.data.push(...items)`; `spec.ids.push(...ids)`.
5. `applyAccessors(spec, offset)` — color only `[offset, end)`.
6. `hitIndex.append(scene.drawables(name).slice(offset))`.
7. Push (unless hidden mid-interaction — see below):
   `backend.appendToLayer?.(name, renderLayer(spec), offset) ?? backend.updateLayer(name, renderLayer(spec))`, then `render()`.

Only the affected layer is pushed; no `setLayers`, no re-projection of existing features.

## Data flow — `handle.append(batch)`

1. `offset = spec.data.length`.
2. ids: `opts.id ? batch.map((d, j) => opts.id(d, offset + j)) : batch.map((_, j) => offset + j)`.
3. The engine builds a chunk closure projecting/drawing **only `batch`** with those ids
   (GeoMap: `geoLayer(batch, projection, { id: (_, j) => ids[j], … })`; Plot: the points/
   draw emitter over `batch`).
4. `BaseEngine.appendToLayer(name, batch, ids, build)` runs the plumbing above.

**Cost per batch:** `O(batch)` projection/build + `O(layer-total)` buffer serialize/upload.
The `O(total)` projection that made streaming quadratic is eliminated.

## Projection / interaction interplay (correctness-critical)

- **GeoMap rebuild source.** Append **must** push the new features into the layer's
  `def.list`. `setProjection` and rotation/zoom call `rebuildLayers()`, which rebuilds each
  group fresh from `def.list`; if appended features are not in `def.list` they vanish on the
  next rebuild. This is the key invariant.
- **Rotation/zoom frames** re-project from `def.list` exactly as today — appended points
  ride along automatically once present in `def.list`.
- **`hideOnInteraction`.** Append reuses the `recolor` guard: if the layer is hidden mid-
  gesture, update scene/spec/hit-index but **skip the backend push**. The gesture-end
  `rebuildLayers()` re-projects the full (extended) list. No double-count: the fresh rebuild
  replaces the group, discarding the incrementally-appended drawables and recreating the
  full set from `def.list`.
- **Plot** has no projection or rebuild trigger (`setTransform` is affine-only), so it needs
  no rebuild-source bookkeeping; the handle's chunk build is sufficient.

## GPU seam (future, no public API change)

`Backend.appendToLayer?(name, layer, addedFrom)` is defined as optional. The CPU path today
falls back to `updateLayer` (full re-serialize + re-upload). A later GPU backend can
implement `appendToLayer` to `bufferSubData` only the tail `[addedFrom, end)` with a
capacity-doubling growth strategy. Because `BaseEngine.appendToLayer` already prefers the
optional method when present, landing the fast-path requires no change to `LayerHandle`,
`GeoMap`, `Plot`, or any caller.

## Error handling

- Append to unknown layer name → throw `unknown layer: <name>`.
- Duplicate id within a layer → throw in `Scene` (fail-fast). **Behavior note:** this adds a
  uniqueness check to the initial build path as well. Duplicate ids in one layer were always
  silently corrupting `idToDrawable` (last-write-wins map entry while a duplicate range was
  still pushed), so this is a latent-bug fix. Verify it does not trip the existing 131 tests;
  if a test legitimately relied on duplicate ids, revisit.
- Empty batch → no-op (no push, no render).

## Testing

- **Scene**: `appendToGroup` extends ranges / buffers / point-centers with correct
  continuing offsets; dup id throws; an `append` then `buffers()` matches an equivalent
  single `group()` build.
- **HitIndex**: `append` makes new drawables pickable without disturbing existing entries.
- **BaseEngine / GeoMap (browser)**: append projects only new items (assert existing
  geometry unchanged — projection-call count or pixel stability); appended points render;
  `recolor` and hit-test work on appended ids; `setProjection` after appends retains
  appended features; append to a `hideOnInteraction` layer mid-rotation defers the push and
  the features reappear on gesture end.
- **Plot (browser)**: `points().append()` and `layer().append()` add pickable geometry.
- **Changeset** (minor): `layer()`/`points()` now return a `LayerHandle` (was `this`); new
  `LayerHandle.append`.

## Out of scope

- GPU sub-buffer upload (seam only).
- Layer removal.
- Reordering / re-indexing existing drawables.
