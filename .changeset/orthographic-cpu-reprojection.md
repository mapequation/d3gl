---
"@mapequation/d3gl": patch
---

Render the orthographic globe via the same per-frame CPU reprojection as Canvas/SVG instead of an equirectangular bake-to-texture. WebGL now matches Canvas/SVG output (crisp coastlines and lines, correct globe size, no "droplet" artifact when changing layers mid-globe), honors `hideOnInteraction` while rotating/zooming the globe, and shares one zoom/rotate state model across backends — fixing the inability to zoom back out after switching backends.
