---
"@mapequation/d3gl": patch
---

LOD: the cut treats every glyph as `declutterSpacing` times its size, the expand threshold with it, so declutter no longer hides glyphs the cut just opened, nor the links touching them (#561). At the default spacing 2, a module now opens once its footprint reaches `2 × expandPx`: the map at zoom `k` is the one spacing 1 shows at `k / 2`. No added cost.
