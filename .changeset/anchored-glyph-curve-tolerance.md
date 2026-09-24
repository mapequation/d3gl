---
"@mapequation/d3gl": patch
---

`curveTolerance` no longer refines anchored `sizeMode: "screen"` glyphs, so a chart pays only for
the curves that can actually facet.

An anchored screen glyph (a pie, symbol or halo pinned to a point with `anchor`) is drawn as
constant-pixel offsets from its anchor, so its bake is already in screen pixels and stays sub-pixel
at any zoom. Those glyphs now keep the default 0.25px bake, or a coarser one if you set
`curveTolerance` above `0.25`. World-scaled curves still refine, and that includes a screen
`sizeMode` layer drawn without anchors. The rule applies on WebGL, Canvas and SVG, to network pies
and halos, and to the WebGL `toSVG()` export of network pies.

This saves memory: the website ancestral-ranges example (screen pies, step links) at
`curveTolerance: 0.25 / 40` drops from 5.0 MB to 1.2 MB of geometry, the same as at the default.
Charts that don't set `curveTolerance` bake exactly the same geometry as before. A glyph's bake is
sub-pixel on screen, but a vector export magnified far past 1:1 shows it as a polygon.

Direct `Scene` users can get the same behaviour through a new optional
`scene.group(name, build, { anchoredTolerance })` argument and the `anchoredCurveTolerance()`
helper.
