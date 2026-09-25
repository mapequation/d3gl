---
"@mapequation/d3gl": patch
---

Network: **nested module layout** (#324) — `net.layout({ backend: "worker", nested: true })` with `lod({ modules })` set lays a module tree out top-down the way the Network Navigator's map of modules does: each module's children are discs inside the module's own disc (area ∝ subtree flow, or leaf count), arranged only by their sibling links — the super-edges between them, which for an Infomap `.ftree` are exactly its `*Links` rows (#199). Every module stays a compact region inside its parent, so the LOD map opens on the top modules and expands in place, and each depth is final, so the streamed layout never oscillates. Runs off-thread on `"worker"` (one frame per depth; `"gpu"` uses the worker for now) and synchronously on `"force"`; with `fit: true` the view frames the whole map from the first frame. The pure `nestedLayout(topology, options)` is exported too.

Hits and labels on a provided module tree now carry the target's Infomap **`path`** (`NetworkHit.path`, computed on read), so `labelOf` and click handlers can name a module; module trees record each node's path entry in `LODTopology.branch`.
