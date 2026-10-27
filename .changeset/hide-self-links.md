---
"@mapequation/d3gl": patch
---
Networks: `style({ selfLinks: false })` hides the self-link loops on WebGL, Canvas and SVG, in every view (a state network's physical view included), in `toSVG()`, and from picking. Display-only: the self-links stay in the data, so degree, strength and the layout are unchanged. Hidden loops cost nothing: no loop is built, not even the scan for them.
