---
"@mapequation/d3gl": patch
---

Oriented data labels (`rotationOf` on the plot/geoMap `labels()`) are now rotated on Canvas, SVG and every `toPNG()`/`toSVG()` export, as on the WebGL screen (#580). Before, the native backends drew them horizontal and anchored on the wrong side when `keepUpright` flipped them. `TextData` has a new `rotation` field (radians, clockwise about `x`, `y`).
