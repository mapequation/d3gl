---
"@mapequation/d3gl": patch
---

Allocation-free `declutterScreen`: the shared screen-space declutter engine no longer produces O(count) transient heap garbage per call (~41 MB per call at 300k glyphs, previously churned by every per-frame caller — the network LOD frontier declutter, the geo/map declutter, and the plot points lane). The per-glyph exclusion radius is now read directly inside per-form specialized loops instead of through a closure whose boxed double returns allocated a HeapNumber per read. Output is byte-identical (same kept set, same winners) and the uniform-radius path is ~1.5× faster per call.
