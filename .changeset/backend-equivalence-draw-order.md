---
"@mapequation/d3gl": patch
---

WebGL now composites overlapping fills and strokes in the same painter's order as Canvas and SVG. Previously WebGL drew all fills then all strokes, so a shape's border always landed on top of every fill — overlapping bordered shapes (e.g. node range pies) looked different on WebGL than on Canvas/SVG, where a later shape's fill correctly occludes an earlier shape's border. The three backends now match. (Internally this is one fewer draw call per layer, not a slowdown.)

Stroke joins now match across backends too: WebGL renders **miter** joins (previously only bevel), and all three backends are pinned to the same join style and miter limit (Canvas/SVG no longer use their differing defaults of 10 and 4). New layer options `lineJoin` (`"miter"` default | `"bevel"`) and `miterLimit` (default 10) on `plot().layer()` and `geoMap().layer()` control this consistently everywhere.

Also renders the raster backends at `devicePixelRatio`, so WebGL and Canvas stay crisp on HiDPI/retina displays instead of upscaling a CSS-resolution buffer.
