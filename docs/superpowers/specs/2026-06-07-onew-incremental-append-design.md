# O(new) incremental append (WebGL + Canvas) — design

**Date:** 2026-06-07
**Branch:** `feat/incremental-append-gpu` (stacked on `feat/incremental-rendering` / PR #15)
**Status:** Approved scope (WebGL + Canvas; retained SVG deferred)

## Problem

`LayerHandle.append()` already avoids re-projecting existing features, but each batch is still **O(total)**:

1. `BaseEngine.appendToLayer` calls `renderLayer(spec)` → `Scene.buffers(name)`, which **re-serializes the entire layer** into fresh typed arrays.
2. The WebGL backend's `appendToLayer` **rebuilds the layer's whole `GroupRenderer`** from those full buffers (full VBO + texture upload).
3. Canvas/SVG `render()` redraw everything anyway.

Streaming to N is thus ~O(N²/batch): measured ~10k rec/s falling to ~4k by 300k points, vs ~400k rec/s in the previous (hand-rolled canvas) Bioregions app.

## Goal

Make a streamed batch **O(new)** end-to-end on **WebGL and Canvas**: project/build only new features (already done), serialize only the new buffers, and upload/draw only the new data. SVG stays full-redraw (a retained-node SVG refactor is a separate follow-up).

## Design

### 1. Scene delta buffers (`core/scene.ts`) — the shared core

The backend's retained buffers mirror the group's buffers **1:1 and grow in lockstep**, so the only thing needed per append is the *tail* slices for the newly-appended drawables — and index values stay **group-absolute** (no rebasing), because the backend appends new vertices at the same positions the group did.

Add:

```ts
/** GPU-ready buffers for just the drawables appended at/after `fromDrawable`.
 *  Indices are group-absolute (the backend's buffers mirror the group). */
appendedBuffers(name: string, fromDrawable: number): GroupBufferDelta
```

`GroupBufferDelta` mirrors `GroupBuffers` but each array is only the new tail:
`fillVertices/fillIndices/strokeVertices/strokeIndices`, `fillColors/strokeColors/flags`
(per new drawable), `pointCenters` (new circles, `drawableId` = absolute group index),
`fillAnchors/strokeAnchors`, plus `drawableCount` (total after) and `fromDrawable`.

Computed in **O(new)** using per-drawable offsets already recorded:
- fill/stroke vertex+index starts come from `ranges[fromDrawable].{fill,stroke}.{vertexOffset,indexOffset}` (O(1)).
- per-vertex anchors slice from `vertexOffset*2`.
- per-drawable colors/flags slice from `fromDrawable`.
- point centers need the cumulative circle count before `fromDrawable`: add `GroupData.pointOffsets[i]` (cumulative circles before drawable `i`), pushed in `addDrawable`/`addCircleDrawable` (O(1) each). Then build point centers by iterating only `circles[fromDrawable..]`.

`fromDrawable >= drawableCount` ⇒ empty delta (no-op append).

### 2. Backend contract (`core/backend.ts`) + `BaseEngine` routing

Change the optional seam to carry the delta:

```ts
appendToLayer?(name: string, delta: GroupBufferDelta, layer: RenderLayer): void;
```

`layer` is the full `RenderLayer` (for backends that fall back to a full update, and so the backend can keep the vector view / clip / sizeMode current). `BaseEngine.appendToLayer` computes `delta = scene.appendedBuffers(name, drawOffset)` and calls `backend.appendToLayer?.(name, delta, renderLayer(spec)) ?? backend.updateLayer(name, renderLayer(spec))`.

> Note: building `renderLayer(spec)` still calls `scene.buffers()` (O(total)) for the fallback/vector view. To make the path truly O(new) we pass the delta as the primary input and only materialize the full `RenderLayer` lazily. Implementation detail: give backends that implement `appendToLayer` everything they need from `delta` + the spec's `drawables` tail, and avoid `scene.buffers()` on the hot path. (Canvas needs the new `drawables` for drawing; WebGL needs the delta typed arrays.) The full `RenderLayer` is only built for the `updateLayer` fallback.

### 3. WebGL `appendToLayer` (`webgl/webgl-backend.ts` + `renderer.ts`)

Replace the current "rebuild the whole renderer" stopgap with incremental growth in `GroupRenderer`:

- **Capacity-doubling buffers.** Each `Pass`/`PointPass` buffer tracks a `capacity` (element count). `append(delta)`:
  - if `newCount <= capacity`: `device.gl.bufferSubData(target, oldByteOffset, deltaTypedArray)` — reuse the same luma.gl `Buffer` (so the `Model`'s attribute binding stays valid), then bump the draw count.
  - else: allocate a new `Buffer` at `max(2*capacity, newCount)`, copy existing range + write delta, and **rebind the `Model`** (the one place a `Model` rebuild is needed; amortized O(1) due to doubling).
- **Index buffers** grow the same way; delta indices are absolute so they're written verbatim.
- **Color/flags textures.** If `paletteDimensions(newCount)` equals current dims (only the last partial row grew, or still one row), `texSubImage2D` only the changed region; else recreate the texture at new dims and re-upload (rare; bounded by 256-wide rows).
- **Draw count.** Track total index count per pass; the draw call covers `[0, totalIndexCount)`. For points, track total point quads.
- De-interleave only the delta's stride-3 `[x,y,id]` → position + id (O(new)).

This is the only intricate, browser-unverifiable piece. Capacity doubling keeps reallocation/`Model`-rebuild rare; the common path is `bufferSubData` + `texSubImage2D`.

### 4. Canvas `appendToLayer` (`canvas/canvas-backend.ts`) — draw-on-top

Mirrors the previous hand-rolled Bioregions approach:

- Retain the full `RenderLayer` per layer (already stored) so `render()` (full redraw on transform/recolor/resize) still works unchanged.
- `appendToLayer(name, delta, layer)`: update the stored layer reference, then **draw only the new drawables on top of the current canvas** (apply the current transform, draw `layer.drawables.slice(delta.fromDrawable)`), **without clearing**. O(new).
- `setTransform`/`render` still do a full redraw (correct after pan/zoom). Recolor → `updateLayer` → full redraw (unchanged).

This restores O(new) streaming on canvas; full redraw only on interaction.

## Testing

- **Scene (node):** `appendedBuffers` returns tail slices equal to the corresponding slices of a full `buffers()` build; absolute indices; point offsets correct with mixed path+circle drawables; empty delta when `fromDrawable >= count`; `pointOffsets` stays correct across `appendToGroup`.
- **Canvas (browser):** after `append`, new drawables are pickable and on-canvas; existing pixels unchanged by the on-top draw; a `setTransform` full-redraw still shows everything.
- **WebGL (browser):** append across a capacity-doubling boundary still renders all drawables (old + new); colors of new drawables correct (texture growth); recolor after append still works; pick works.
- **Changeset** (patch/minor): O(new) incremental append on WebGL + Canvas.

> Browser tests are written but **cannot be executed in this environment** (the vitest-browser/Playwright harness hangs — see AGENTS.md). The Scene delta is node-tested; WebGL/Canvas correctness must be verified locally / in CI.

## Out of scope

- Retained-node SVG (separate follow-up; SVG keeps full-redraw `appendToLayer` = `updateLayer`).
- Shrinking/removing drawables (append-only).
