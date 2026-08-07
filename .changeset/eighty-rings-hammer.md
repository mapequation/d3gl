---
"@mapequation/d3gl": patch
---

perf(core): retain the Scene's per-layer vector view instead of rebuilding it on every layer push

`Scene.drawables(name)` used to materialize a fresh `DrawableVector` per drawable (plus two colour
tuples each) on every call, and `Scene.buffers(name)` a fresh interleaved `pointCenters` array.
The engine calls both for every layer on every `pushLayers()` — once per `layer()` registration
(so an L-layer map paid L×), on `removeLayer`, on `setClip`, on every backend install, and at both
boundaries of a gesture on a map with a `hideOnInteraction` layer — so a push cost O(total
drawables) in time and allocation before any backend saw the result.

Both arrays are now built once per drawable set and shared (they were already retained for the
layer's lifetime by whichever backend they were pushed to, so this costs no extra memory); a later
`setFill`/`setStroke`/`setFlag`/declutter write is re-applied in place, allocation-free. Measured at
1,000,000 drawables: 20 pushes 31.4 s → 0.1 s, and a gesture-boundary push after a declutter pass
1,126 ms → 11 ms.
