---
"@mapequation/d3gl": patch
---

WebGL now composites overlapping fills and strokes in the same painter's order as Canvas and SVG. Previously WebGL drew all fills then all strokes, so a shape's border always landed on top of every fill — overlapping bordered shapes (e.g. node range pies) looked different on WebGL than on Canvas/SVG, where a later shape's fill correctly occludes an earlier shape's border. The three backends now match. (Internally this is one fewer draw call per layer, not a slowdown.)

Also renders the raster backends at `devicePixelRatio`, so WebGL and Canvas stay crisp on HiDPI/retina displays instead of upscaling a CSS-resolution buffer.
