---
"@mapequation/d3gl": patch
---

WebGL now composites overlapping fills and strokes in the same painter's order as Canvas and SVG. Previously WebGL drew all fills then all strokes, so a shape's border always landed on top of every fill — overlapping bordered shapes (e.g. node range pies) looked different on WebGL than on Canvas/SVG, where a later shape's fill correctly occludes an earlier shape's border. The three backends now match. (Internally this is one fewer draw call per layer, not a slowdown.)

Stroke joins and caps now match across backends too: WebGL renders **miter**/**round** joins and **square**/**round** caps (previously only bevel joins + butt caps), and all three backends are pinned to the same join/cap/miter-limit (Canvas/SVG no longer use their differing defaults of 10 and 4). New layer options `lineJoin` (`"bevel"` default | `"miter"` | `"round"`), `miterLimit` (default 10), and `lineCap` (`"butt"` default | `"square"` | `"round"`) on `plot().layer()` and `geoMap().layer()` control this consistently everywhere. The default join is `"bevel"` (matching the prior WebGL look); pass `lineJoin: "miter"` for sharp corners.

Stroke joins now emit only the outer-side geometry (the inner side is already covered by the segment quads), and a miter replaces the bevel rather than stacking on top of it. This removes redundant overlapping triangles, so translucent strokes no longer double-blend (darken) at joins — keeping WebGL close to Canvas/SVG for semi-transparent borders too.

Also renders the raster backends at `devicePixelRatio`, so WebGL and Canvas stay crisp on HiDPI/retina displays instead of upscaling a CSS-resolution buffer.
