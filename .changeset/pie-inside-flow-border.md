---
"@mapequation/d3gl": patch
---

State networks: in the physical view, a pie now shows a flow border or node border with no colour given through it: each wedge spans the full node radius and its outer band is the wedge's own colour, darker, as a single-module node's border is its fill's. The same on WebGL, Canvas, SVG and `toSVG()`. With an explicit flow-border or node-border colour, the pie sits inside the border on every backend (WebGL used to draw it over the flow border).
