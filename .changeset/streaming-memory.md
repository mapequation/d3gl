---
"@mapequation/d3gl": minor
---

Reduce memory for very large layers (live streaming):

- New `pickable: false` option on `GeoMap.layer` / `Plot.layer` / `Plot.points` skips
  building the CPU hit index for that layer (no hover/pick on it) — saves one `Entry`
  object per drawable, which dominates memory for huge non-interactive layers.
- Drawable ids are now keyed by their raw value (string or number) instead of
  `String(id)` in the scene's id map and the engine's per-layer id set, so numeric-id
  layers no longer allocate a string per drawable.
