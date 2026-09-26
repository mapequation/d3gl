---
"@mapequation/d3gl": patch
---

The CPU force layout (`worker` and `force` backends) runs its Barnes-Hut repulsion about twice as fast, with the same result.

- **Tree laid out for the traversal.** The quadtree is now one flat array of records in the order the traversal visits them, each with a pointer past its subtree, so a node's repulsion is a forward scan with no stack. Bodies are records of their own, so leaves need no separate loop.
- **Nodes in spatial order.** Each build sorts the bodies into the tree's own Z order and keeps that order for the next tick, and the repulsion pass visits nodes in it, so neighbouring nodes read the same cells one after the other.
- **Centering reuses the tree's centre of mass**, so there is no separate centroid pass.

The approximation is unchanged: same cells, same opening test, same summation order. On web-NotreDame (325k nodes) the worker's tick drops from about 485 ms to 240 ms and the layout converges in the same 116 ticks with bit-identical positions (56 s → 28 s). A main-thread `force` drag frame over 100k nodes drops from about 165 ms to 72 ms. The tree also uses about 40% less memory.
