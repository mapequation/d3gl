---
"@mapequation/d3gl": patch
---

Network LOD: super-edges now link tree nodes at **different depths** (#325). In a ragged module tree, such as an Infomap map where leaves sit at depths 2–25, an edge between a deeper and a shallower endpoint was never drawn. For example, a leaf at `1:3:2:5` and a leaf at `2:1:7` stayed unlinked even at full zoom, with `crossLevelEdges` on or off. `buildSuperEdges` now also records a lift pair at each depth-equalising step, from the deeper side's node to the shallower endpoint, and exposes the per-node `depth` on `LODTopology`. The gather follows a lift pair toward a hidden neighbour only from its deeper end, so every underlying edge between two visible subtrees is drawn exactly once, on every cut. On real Infomap maps this adds 1–4% super-edge pairs (science2001 +0.9%, web-NotreDame +4.0%) and draws the 1–4% of edges that were previously lost.
