---
"@mapequation/d3gl": patch
---
Network: with LOD on Canvas and SVG, dragging a collapsed module's glyph now moves its leaves, as on WebGL. Before, the glyph's hit listed its tree id as its only member, so the drag held no leaf. `selection()` and `on("select")` now list a selected aggregate's leaves as its `members()` on those backends too.
