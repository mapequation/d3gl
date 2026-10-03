---
"@mapequation/d3gl": patch
---

`lod({ overlapSpacing })`: a spacing multiplier for the overlap-aware LOD cut (#426). Members count as overlapping
until they are `overlapSpacing` × their glyphs' radii apart on screen, so an aggregate opens only once its members
stand that far apart. Default 1 (the glyphs' own radii, as before). It changes the overlap test only, never the drawn
glyphs, and reaches every crowding pass (main thread, the worker's streams, the GPU layout's LOD relay and the worker's
super-edge rows cut); changing it recomputes the crowding once.
