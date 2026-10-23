---
"@mapequation/d3gl": patch
---

Corrected the LOD declutter documentation: a glyph is hidden when its centre lies within
`declutterSpacing·(rᵢ + rⱼ)` of a kept glyph. The default `declutterSpacing: 2` keeps a gap around kept
glyphs so the links between them stay visible, which in a small graph can hide a module that overlaps
nothing; `declutterSpacing: 1` hides only real overlaps and `declutter: false` hides nothing. Behaviour
unchanged.
