---
"@mapequation/d3gl": patch
---

`arcTo` now draws a real tangent arc on every backend. `PathRecorder.arcTo` used to throw
("not implemented"), so a `draw` callback that rounded a corner — rounded bars, cards,
CSS-style shapes — failed outright, while `SvgPathContext.arcTo` silently emitted two
`lineTo`s (square corners). Both now flatten the Canvas-2D tangent arc through the shared
`flattenArcTo`, honouring `curveTolerance`, so WebGL, Canvas, and SVG draw identical
geometry. Degenerate inputs (zero radius, coincident or collinear points) collapse to a
line at the corner, matching Canvas; a negative radius throws.
