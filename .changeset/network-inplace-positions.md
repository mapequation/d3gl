---
"@mapequation/d3gl": patch
---

Only update positions when animating a network layout (#179), instead of re-deriving and re-uploading the whole graph every frame. Two changes together eliminate the per-frame bottleneck (100k nodes + 600k edges, LOD off, was ~446ms/frame):

- **In-place GPU buffers.** `InstancedLines`, `InstancedArrows`, and `InstancedHalfArrows` gain an in-place `update()` (mirroring `InstancedCircles`): layout frames `bufferSubData` the endpoint/geometry buffers instead of destroying+recreating the GPU objects. `updateInstancedLayer` takes the in-place path for all four primitives, recreating only when a structural property changes (vertex-template `samples`, arrow `half` flag), the primitive type changes, or a layer's `pickable` state toggles.
- **Cached style attributes.** The no-LOD full-graph path caches its style-derived attributes (link/arrow colours, widths, per-edge radii/sizes/bends) per resolved-style version. A position-only layout frame recomputes only the position-derived endpoints/node-centres and reuses the cache — so the colour/width scale accessors run O(edges) once per style version, not once per edge per frame. `data()`/`style()`/`lod()` bust the cache; a genuine data/style change fully rebuilds.
- **Upload only what changed.** `update()` skips the `bufferSubData` of any per-instance buffer whose source array is the *same object* as last frame (the cached colour/width/radius/bend arrays are reference-stable across position frames), so a position frame uploads only the freshly-allocated endpoint buffers — not the unchanged style buffers.
