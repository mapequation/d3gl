---
"@mapequation/d3gl": patch
---

Network node-drag no longer recomputes the whole LOD tree geometry on every pointer move. When the tree is main-thread-owned (`positions` backend, worker fallback, or held-set moves on the `worker`/`gpu` backends), a drag move now folds only the held leaves into their ancestor chains — exact centroids, conservatively widened extents — in O(held · depth) instead of O(tree size), and one exact pass runs on release. The position-independent style pass (radius/weight/colour aggregation) is skipped during drags entirely, including on the `force` backend. Dragging a node on a ~1M-node map goes from ~700 ms per move to microseconds.
