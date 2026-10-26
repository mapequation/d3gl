---
"@mapequation/d3gl": patch
---

Labels draw one halo on every backend (#571). `halo: { color, width }` on `network.labels()` and on the plot/geoMap `labels()` now also sets the WebGL overlay's halo, as a CSS text stroke behind the fill. The WebGL screen, Canvas, SVG and every `toPNG()`/`toSVG()` export now show the same halo. The default halo is thinner: `width: 1` (was 3), and the overlay's text-shadow glow is gone. `width: 0` now draws no halo; Canvas used to draw a 1px one. `style: { textShadow: "none" }` still turns the halo off on every backend.
