---
"@mapequation/d3gl": patch
---

Add `network.update({ flow, modules, moduleLinks })`: re-cluster the network the engine already holds, plain or state, without loading it again. The nodes, links, positions, every view's layout, the camera and the selected nodes are kept, and the sizes, colours, pies, module tree, module links and lumps follow the new flow and modules. A running layout stops where it is, and `update()` never starts one: continue it warm with `layout()`. A selected module of the old modules is dropped, and the hover is cleared. `data(graph, { modules })` and `stateNetwork(graph, { modules })` now share its checks and module handling.
