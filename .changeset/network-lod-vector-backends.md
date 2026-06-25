---
"@mapequation/d3gl": minor
---

Render the network **LOD frontier on the Canvas and SVG (vector) backends**, not just WebGL — so vector backends show the same aggregate map as the instanced lane, and `toSVG()` **exports a level-of-detail network map** (#138). The frontier (cut → declutter → super-edges / aggregate glyphs) is traced into retained Scene layers keyed by stable tree-node id, byte-identical to the WebGL lane. On the retained backends the cut can't re-tessellate per frame, so the frontier is static during a gesture and re-cuts on release (the redraw-on-zoom-end model); call `syncScreenGeometry()` to re-cut at a chosen zoom before a programmatic export.
