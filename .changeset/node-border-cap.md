---
"@mapequation/d3gl": patch
---

A node border (`nodeBorder`) or flow border (`flowBorder`) now covers at most a third of a node's radius, so a small node keeps its fill instead of drawing as a disc of border colour (#506). It applies on WebGL, Canvas and SVG, in both size modes, with LOD off and on, and to the physical view's pies, which sit inside the border. A border thinner than a third of the radius is unchanged; a flow border whose scale gives more draws at the cap.
