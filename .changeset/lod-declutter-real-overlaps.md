---
"@mapequation/d3gl": patch
---

LOD views now hide only glyphs that overlap a kept glyph. The default `lod({ declutterSpacing })` is 1
instead of 2, so a module aggregate or leaf that sits apart from its neighbours is no longer hidden (before,
a whole module could vanish from a small graph). Crowded LOD views show more glyphs as a result. Pass
`declutterSpacing: 2` to restore the old, sparser look.
