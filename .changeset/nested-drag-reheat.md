---
"@mapequation/d3gl": patch
---

Dragging a node on a nested module map (`layout({ nested })`) now re-lays out its module around it instead of only translating it: only the dragged node is pinned under the cursor: its siblings move aside inside the module's disc, and when the node reaches the disc's edge the disc (and its ring) travels with it, pushing its sibling modules aside and carrying the discs above it in turn, up to the root. Dragging a collapsed module moves its sibling modules aside inside their parent, each as a whole; a selection re-lays out every module it spans. The re-solve runs on the main thread for every layout backend and costs the module's children plus the nodes that moved per frame. Previously the `force` backend reheated the whole graph (losing the nested map) and `worker` / `gpu` / `auto` only translated the grabbed nodes.
