---
"@mapequation/d3gl": minor
---

SVG pan/zoom is now O(1). The SVG backend keeps persistent `<defs>` / view-`<g>` /
screen-`<g>` elements; `setTransform` updates only the view group's `transform`
attribute instead of re-serializing the whole document every frame. This applies
whenever no layer uses `sizeMode: "screen"` (the common case — maps, polygons,
world points). Screen-mode content (constant-pixel circles/glyphs) still bakes the
transform into coordinates and is re-serialized on a move, as before. `svgFromLayers`
output is unchanged.
