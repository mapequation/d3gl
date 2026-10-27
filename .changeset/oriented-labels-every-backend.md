---
"@mapequation/d3gl": patch
---

Oriented data labels (`rotationOf` on the plot/geoMap `labels()`) are now rotated on Canvas, SVG and every `toPNG()`/`toSVG()` export, as on the WebGL screen (#580). Before, the native backends drew them horizontal and anchored on the wrong side when `keepUpright` flipped them. `TextData` has a new `rotation` field (radians, clockwise about `x`, `y`).

New `rotationStep` option: oriented label angles are rounded to whole degrees by default, so labels that share an angle reuse the browser's rasterized glyphs and paint faster (1.2–2.5× for 2,000 labels; about 6× on the WebGL overlay at `rotationStep: 5`). A label runs at most half a step off its angle; `rotationStep: 0` keeps angles exact.
