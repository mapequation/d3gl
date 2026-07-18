---
"@mapequation/d3gl": patch
---

network: cache the no-LOD shader-highlight group columns (per-edge source/target ids + node identity) on the position-frame style cache, so layout-streaming and drag repaint frames reuse the same array instances and skip their per-frame allocation and GPU re-upload (~24 MB/frame at 5M directed edges, ~9 MB/frame at 1M undirected). Hover/selection highlight behavior is unchanged.
