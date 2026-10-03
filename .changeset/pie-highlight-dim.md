---
"@mapequation/d3gl": patch
---
network: in a state network's physical view, the overlapping-module pie glyphs now take part in the hover/selection highlight like the node discs under them. With a selection (`selection.others`, default opacity 0.3) or `hover: { others }`, unselected pies fade and the selected or hovered pie keeps full opacity. As for the other glyphs this is a shader uniform plus a per-wedge flag write, with no geometry rebuild. Also fixed: turning `lod()` on in the physical view, or replacing a state network with `data()`, no longer leaves a stale copy of the pies on screen. The same applies to the `both` view's physical container discs, which the LOD frontier does not draw either: with `lod()` on they are now removed instead of staying frozen at their last position.
