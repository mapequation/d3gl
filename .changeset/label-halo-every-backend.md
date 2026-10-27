---
"@mapequation/d3gl": patch
---

Labels draw one halo on every backend (#571). `halo: { color, width }` on `network.labels()` and on the plot/geoMap `labels()` now also sets the WebGL overlay's halo, as a CSS text stroke behind the fill. Every backend joins the halo's corners with miter joins at a miter limit of 4 (Canvas and SVG used round joins), the only join Chromium draws on HTML text. The WebGL screen, Canvas, SVG and every `toPNG()`/`toSVG()` export now show the same halo, pixel for pixel in Chromium. The default halo is thinner: `width: 1` (was 3), and the overlay's text-shadow glow is gone. `width: 0` now draws no halo; Canvas used to draw a 1px one. `style: { textShadow: "none" }` still turns the halo off on every backend.
