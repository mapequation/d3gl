---
"@mapequation/d3gl": patch
---

State networks: module links (#533). `stateNetwork(graph, { modules, moduleLinks })` takes an Infomap state `.ftree`'s module-level links, addressed by path in the state-node modules, as `data(graph, { modules, moduleLinks })` does: the state view draws exactly them between its modules and its layouts pull along them. Lumped, a module endpoint keeps its path and a leaf endpoint becomes the lump that holds that state node; `lumpStateGraph(graph, modules, moduleLinks)` returns them in the lumps' hierarchy (`moduleLinks`). The physical and both views have none. `moduleLinks` requires `modules`, and an endpoint outside the hierarchy throws up front. In a ragged hierarchy (a module with sub-modules and state nodes side by side), a lump's rank now skips its module's sub-module branch numbers, so a lump's path never names a sub-module too.
