---
"@mapequation/d3gl": minor
---

Add map projection switching and a rotatable globe:

- `GeoMap.setProjection(projection)` re-projects existing layers against a new
  projection and resets the view.
- `GeoMap.enableRotation(opts?)` drag-rotates a spherical projection (versor
  trackball) and wheel-scales it, re-projecting on the CPU per frame.
- `BaseEngine.disableInteraction()` detaches the current pan/zoom or rotation.
- `LayerOptions.hideOnRotation` drops dense layers from the render during a
  rotation drag (they re-project and reappear on release).
