---
"@mapequation/d3gl": minor
---

Add map projection switching and a rotatable globe:

- `GeoMap.setProjection(projection)` re-projects existing layers against a new
  projection and resets the view.
- `GeoMap.enableRotation(opts?)` drag-rotates a spherical projection (versor
  trackball) and wheel-scales it, re-projecting on the CPU per frame.
- `BaseEngine.disableInteraction()` detaches the current pan/zoom or rotation.
- `LayerOptions.hideOnInteraction` drops dense layers from the render while the
  user is interacting — a rotation drag or a zoom/pan gesture — so only cheap
  layers re-project per frame; they reappear when the gesture ends.
