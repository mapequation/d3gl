---
"@mapequation/d3gl": patch
---

Faster network loading. `parseEdgeList` (and `parseNetwork` for edge lists) now parses in one pass with no per-line or per-column strings, and indexes integer node ids by value instead of hashing them as strings — about 4x faster on a 1.5M-edge SNAP file (0.6-0.8 s to 0.15 s in Chromium), with identical output. `lod()` on an engine that has not run a layout yet no longer builds a structural LOD tree on the main thread when a `layout({ backend: "worker" })` follows in the same call chain: the build waits for the end of the chain, so the worker streams the tree as documented, and every other path still has its tree before the next frame (a synchronous `pick()`/`toSVG()`/`toPNG()` builds it at once). While LOD waits for its tree, frontier labels no longer rank and place every node of the undrawn graph.
