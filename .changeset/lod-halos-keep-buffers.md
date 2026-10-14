---
"@mapequation/d3gl": patch
---

`network()` with LOD: the aggregate-outline halo layer keeps its GPU buffers when a frame has no collapsed module in view (#482). A view of leaves only (every module in it open, or nothing in view) has no halo, and the layer used to be dropped there, destroying its buffers, and re-created on the next frame with a collapsed module. It now updates in place at count 0, as the gathered link layers do since #470.
