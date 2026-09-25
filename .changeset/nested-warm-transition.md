---
"@mapequation/d3gl": patch
---

Network: **warm-started nested layout and smooth position transitions** (#328). After a re-clustering (same nodes, new module hierarchy), `net.data(graph, { modules }).layout({ backend: "worker", nested: { warm: true }, transition: 600 })` refines the map the reader is looking at instead of restarting from a disc:

- **`nested: { warm: true }`** seeds each module's children at their current centroids and starts the solve cooler, so the arrangement carries over. The new map is placed over the current one, with the same leaf centroid and spread, so it neither jumps nor drifts over repeated re-clusters. No seed disc is placed first and no per-depth frames stream. On a graph that was never laid out it is the cold layout. The pure `nestedLayout(topology, { initial })` does the same.
- **`transition: ms`** eases every node from where it is to the new layout (cubic ease-in-out, on the main thread). The worker computes only the final layout. Each frame is a positions-only repaint that costs no more than a streamed layout frame: with LOD on it skips the style pass, and it uploads nothing extra.
  - It also eases `"positions"` and `"force"` layouts. The streaming `"worker"`/`"gpu"` force layouts ignore it.
  - `whenSettled()` resolves when it ends. A new `layout()`, `data()`, `stopLayout()` or `destroy()` stops it where it is, and grabbing a node finishes it. A node grabbed while the worker is still computing the target stays under the cursor through the ease and stays where it is dropped.
  - The camera stays put unless `fit` is set.

The modular-map example's new **Layout** control switches between the GPU force layout and the nested layout with a warm, eased re-layout.
