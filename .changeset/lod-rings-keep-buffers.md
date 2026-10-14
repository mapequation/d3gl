---
"@mapequation/d3gl": patch
---

`network()` with LOD: the module-boundary ring layer keeps its GPU buffers when a frame has no open module in view (#483). A view with no ring (every module in it collapsed, or nothing in view) used to drop the layer, destroying its buffers, and the next frame with a ring re-created them. It now updates in place at count 0, as the halo layer does since #482.
