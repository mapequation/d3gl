---
"@mapequation/d3gl": patch
---

Add at-scale **engine-level** per-frame regression guards for `plot()`, `geoMap()` and `network()`.
The existing at-scale sweeps drove the Canvas/SVG **backends** directly, so everything above that
seam — accessor resolution, instanced-lane emit, style-version caching, LOD/declutter integration —
was only exercised at small N. Each engine now has a guard that drives its public entry point
through the real `setTransform` at `PERF_BROWSER_N`, asserting deterministic signatures (styles
resolved once at registration and never per frame, the geo projection never re-streamed, `draw`
callbacks never re-run, GPU buffers neither recreated nor re-uploaded per frame) with a wall-clock
ceiling as the backstop. Tests only — no runtime change.
