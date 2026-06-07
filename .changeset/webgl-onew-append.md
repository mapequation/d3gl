---
"@mapequation/d3gl": minor
---

WebGL incremental append is now O(new) per batch. `Backend.appendToLayer` is
implemented on the WebGL backend with capacity-doubling growable buffers
(`bufferSubData` for the appended tail, reallocate + rebind the model only when a
buffer overflows) and incremental color/flag texture growth, bumping the indexed
draw count. Previously a `LayerHandle.append` on WebGL rebuilt the whole layer
renderer each batch (O(total)), which made live streaming slow down as the layer
grew; appends are now constant-time in the existing size.
