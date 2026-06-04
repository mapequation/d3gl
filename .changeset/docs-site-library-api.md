---
"@mapequation/d3gl": minor
---

Declarative React API and rendering fixes.

- **react:** new `<Plot>` / `<Layer>` / `<Points>` components for declarative,
  non-geo rendering — the imperative-engine sibling of `<GeoMap>`.
- **geo:** `GeoInput` now accepts a GeoJSON `Sphere` (`{ type: "Sphere" }`)
  directly, with no casts.
- **svg:** the SVG backend sets a `viewBox` so it maps identically to the
  Canvas2D / WebGL2 backends when the rendered element is resized.
- **map:** `enableZoom` gains an optional `onTransform` callback and seeds
  d3-zoom from the engine's current transform, so zoom centres correctly from a
  non-identity base view.
- **fix:** destroying an engine mid backend-swap no longer leaves an orphaned
  canvas; re-applying a layer keeps the current view transform.
