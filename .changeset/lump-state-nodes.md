---
"@mapequation/d3gl": minor
---

State networks: lump each physical node's state nodes in one leaf module into one node in the state and both views, as the map equation codes them (#529). `stateNetwork(graph, { modules, lump: true })` or `net.lump(on)` toggles it (without modules every state node is in the root module: a node per physical node); the physical view and its layout are the same either way, and `net.lumped` maps a lump to its physical node and state nodes. `lumpStateGraph()` gives the lumped network on its own, merged by the same code that derives the physical graph.
