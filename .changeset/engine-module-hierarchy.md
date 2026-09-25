---
"@mapequation/d3gl": patch
---

Network: the engine now **owns the module hierarchy** (#326). Pass it with the graph, as data: `net.data(graph, { modules, moduleLinks })`. Every module feature then reads it, whatever the LOD state:

- The **LOD cut** draws it by default. The new `lod({ source: "structure" })` coarsens the graph structurally instead.
- `lod(false)` **keeps** the hierarchy. The module tree is built lazily, once per graph and hierarchy, so toggling LOD or switching its source never rebuilds it. Once built it stays in memory until the next `data()`, also with LOD off and next to a structural cut's tree: about 64 B per node and module plus 16 B per super-edge pair (119 MB for 1M nodes and 3M edges).
- **`layout({ nested: true })`** now works with LOD off. Before, it silently fell back to the force layout.
- The **module-aware GPU seed** uses the hierarchy in every LOD mode.
- **`NetworkHit.path`** is also reported for leaf hits with LOD off (the node's own path) and under a structural cut.

`data()` checks once that the records match the graph's node indices, and throws on a missing, duplicate or out-of-range record. It also checks that every module link's endpoints are modules or leaves of that hierarchy, so a bad path throws there rather than later from a lazy tree build. `data(graph)` without the second argument clears the hierarchy. `lod({ modules, moduleLinks })` keeps working as a back-compat alias scoped to the LOD options, which `lod(false)` drops.

This also fixes a bug: calling `lod({ modules })` after a worker-LOD run kept drawing the worker's coarsening tree. Now it draws the module tree, and switching back to the structural source re-adopts the worker's tree.

The modular-map and modular-lod examples use the new API.
