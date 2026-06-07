---
"@mapequation/d3gl": minor
---

Add incremental layer append for live-streaming data:

- `GeoMap.layer()`, `Plot.layer()`, and `Plot.points()` now return a `LayerHandle`
  (previously the engine instance). The handle exposes `append(items)`, plus
  `recolor()` / `setClip(clipTo?)`.
- `LayerHandle.append(features)` builds and projects only the new items and re-pushes
  only that layer — existing features are not re-projected. This makes live streaming
  (e.g. species occurrences) cheap instead of quadratic in the total point count.
- Appended features survive `setProjection` and globe rotation (re-projected from the
  layer's accumulated data).
- A duplicate drawable id within a layer now throws (previously it silently corrupted
  the layer's id index).
