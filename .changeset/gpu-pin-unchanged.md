---
"@mapequation/d3gl": patch
---

A node drag on the GPU layout no longer re-uploads its pinned flags on every pointer move: re-pinning the same held set is a no-op, so dragging a large collapsed module (1k held nodes) stops costing about 3 ms of main thread per move.

LOD super-edges keep each drawn link's colour while its flow is unchanged, so a frame redrawing the same links parses no colour. With continuous flows (Infomap's) the drawn flows could outnumber the per-weight colour memo, which then started over every frame and parsed every link again: about 10% of the main thread during a drag on a 16k-link view.
