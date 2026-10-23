---
"@mapequation/d3gl": patch
---

A self-link counts once in a node's degree and strength, as in Infomap; a state network's physical view draws loops (#535).

- **Degree and strength.** A self-link of weight `w` adds 1 to its node's degree and `w` to its strength (it added 2 and `2w` before). A node with a self-link of weight `w` and one other link of weight `v` has degree 2 and strength `w + v`. This changes node sizes for networks with self-links sized by `nodeRadius` `{ by: "degree" | "strength" }` or a `(degree) => radius` function, flow borders and declutter priorities that read these metrics, and the default LOD leaf weight. Networks without self-links are unchanged.
- **New `graph.degree`.** `NetworkGraph.degree` is the degree metric. `graph.csr.degree` stays the adjacency row length (a self-link keeps its two entries there, so layouts see the same neighbours); read `graph.degree` for sizing.
- **Physical-view loops.** `buildStateGraph` keeps a state link between two state nodes of one physical node as that physical node's self-link (summed weight), so the physical view draws a loop for flow that stays in a physical node. Physical node flow is unchanged.
