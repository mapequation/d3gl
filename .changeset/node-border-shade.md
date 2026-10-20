---
"@mapequation/d3gl": patch
---

`network()`: a node border with no colour given (`nodeBorder: { width }`) is now a darker shade of each node's own fill, as a flow border already is, instead of white ([#506](https://github.com/mapequation/d3gl/issues/506)). A collapsed module's border is a darker shade of its module colour, and a physical node's pie keeps a border in its node's shade. On WebGL, Canvas and SVG, with LOD off and on. Pass a `color` (e.g. `nodeBorder: { width: 1, color: "#fff" }`) to keep the previous white border; an explicit colour draws exactly as before. On Canvas and SVG without LOD, a darkened ring (of a node border or a flow border) now keeps a translucent fill's alpha, as on WebGL.
