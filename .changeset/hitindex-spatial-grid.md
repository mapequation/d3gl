---
"@mapequation/d3gl": patch
---

Hover, tooltip, and click picking on large retained-Scene layers is now O(candidates near the pointer) instead of O(all drawables): `HitIndex.pick` uses a uniform spatial grid over entry bounding boxes (world layers) or glyph anchors (screen-size layers), preserving topmost-first pick semantics exactly. At 1M drawables a pick drops from ~13 ms (world) / ~78 ms (screen) to ~2 µs, so pointer interaction on full-detail layers stays fluid.
