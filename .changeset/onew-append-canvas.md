---
"@mapequation/d3gl": minor
---

Make incremental layer append O(new) on the Canvas backend (and lay the groundwork
for WebGL):

- `Scene.appendedBuffers(name, fromDrawable)` returns GPU-ready buffers for only the
  appended tail (group-absolute indices), and `Scene.drawables(name, from)` reads only
  the new vector views — so an append serializes O(new), not O(total).
- New `Backend.appendToLayer(delta)` contract carrying a `RenderDelta` (delta buffers +
  new drawables). The Canvas backend implements it as **draw-on-top**: new drawables are
  drawn over the current canvas with no clear; full redraws happen only on
  transform/recolor/resize. This restores cheap live streaming on canvas.
- Fix: appending a large batch no longer throws `RangeError` — the engine and backends
  extend their arrays with loops instead of `push(...spread)` (which exceeded the
  argument-count limit for big batches).

WebGL still rebuilds the layer's renderer on a count change (correct, O(total) per
batch); a true O(new) WebGL `bufferSubData` path is a follow-up.
