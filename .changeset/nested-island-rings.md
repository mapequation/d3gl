---
"@mapequation/d3gl": patch
---

Fix nested islands-in-lakes ring topology. Ring classification was single-level, so a polygon
with an island inside a lake (nesting depth ≥ 2) lost the island on WebGL — it became a second
hole of the landmass, and the overlapping holes made the tessellator drop geometry. `groupRings`
now classifies rings by the **nonzero winding rule** at arbitrary depth, the same rule Canvas
(`ctx.fill()`) and SVG (`fill-rule: nonzero`) apply natively, so land ▸ lake ▸ island ▸ pond
fills identically on all three backends. Hit-testing uses the same classification, so an island
in a lake is now pickable too. Multi-ring drawables also classify ~20-80× faster (a repeated
per-candidate area recomputation is gone, and a bounding-box test rejects non-containers before
the ray cast).
