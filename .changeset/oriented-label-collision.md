---
"@mapequation/d3gl": minor
---

Collide rotated labels by their true oriented footprint. `LabelBox` / `LabelAnchor` gain
`rotation` (radians), `textAnchor` (`start | middle | end`, like SVG), and `keepUpright`; the
library now derives **both** the rendered CSS transform and the collision box from the same
angle (an oriented-box / separating-axis test, with the fast axis-aligned path kept for plain
labels). Previously rotated labels were culled by their un-rotated dimensions, so near-vertical
labels — e.g. toward the top of a radial tree — over-excluded their angular neighbors and left
gaps that grew with the rotation.
