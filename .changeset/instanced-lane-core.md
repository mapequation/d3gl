---
"@mapequation/d3gl": patch
---

Internal: introduce `core/InstancedLane` — the shared `select(transform) → visibleIndices → emit → pick` orchestration over an instanced layer — and adopt it in the `network()` LOD frontier. No behaviour change: the cut/declutter/pick math and the glyph emit are unchanged, just routed through the lane. Removes the now-redundant `lodLayers` method and write-only `frontier` field. Groundwork for unifying picking/declutter/`plot.points()` onto one shared instanced lane (#108).
