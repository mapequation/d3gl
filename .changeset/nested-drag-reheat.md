---
"@mapequation/d3gl": patch
---

Dragging a node on a nested module map (`layout({ nested })`) now reheats the map, as a drag does on a flat map, instead of only translating the node: only the dragged node (or a collapsed module's members) is pinned under the pointer, and every level of the map re-solves around it with the nested layout's own forces — its module's other members, its sibling modules (drawn along by their module links) and the modules above, up to the root. Each module's disc, and its ring, follows its members. The heat and the re-cool on release are the flat drag's. The re-solve runs on the main thread for every layout backend. Previously the `force` backend reheated the whole graph flat (losing the nested map) and `worker` / `gpu` / `auto` only translated the grabbed nodes.
