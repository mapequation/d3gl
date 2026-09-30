---
"@mapequation/d3gl": patch
---

A node drag on the GPU layout no longer re-uploads its pinned flags on every pointer move: re-pinning the same held set is a no-op, so dragging a large collapsed module (1k held nodes) stops costing about 3 ms of main thread per move.
