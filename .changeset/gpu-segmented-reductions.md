---
"@mapequation/d3gl": patch
---

The GPU force layout (`layout({ backend: "gpu" })`) ticks about 3× faster on large graphs. Each tick used to sum every node into a single pixel twice (once for the centroid, once for the bounding box). Blending on that one pixel ran serially and took about 80% of the tick. The centroid and the box now come from a gather-tree reduction that does no blending. On a 325k-node / 1.5M-edge graph a tick drops from about 45 ms to 12 ms of GPU time (about 138 ms to 39 ms at 1M nodes, M1 Max). The forces are the same up to float32 rounding. The centroid is also more accurate: a serial float32 sum over 1M nodes can be off by about 100 world units, and the tree sum by less than 0.001.
