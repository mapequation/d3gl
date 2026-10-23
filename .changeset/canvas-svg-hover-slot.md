---
"@mapequation/d3gl": patch
---

`interactive({ hover, tooltip })` now works on the Canvas and SVG backends without an `on()` handler: a pointer move over a node shows its hover highlight and tooltip, as on WebGL. A hover change on Canvas and SVG now redraws only the hovered glyph's highlight instead of the whole scene (Canvas puts back the pixels under the old highlight, SVG rewrites one group), which also speeds up hover in maps and plots.
