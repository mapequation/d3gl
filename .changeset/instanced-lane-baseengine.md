---
"@mapequation/d3gl": patch
---

Internal: `BaseEngine` now owns the instanced-selection lane registry (#108-B). `setTransform` drives every registered dynamic lane's re-select + re-emit (static lanes emit once and ride the matrix), and `pick()` resolves lanes (topmost-first) before Scene hit-indexes. `network()` registers its LOD (dynamic) and no-LOD (static) lanes via a single `syncLane()` and drops its `setTransform`/`pick` overrides + `emitInstancedLayers`. No behaviour change; this is the seam `plot.points()` will register onto (#108-C).
