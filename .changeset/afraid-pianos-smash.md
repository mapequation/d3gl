---
"@mapequation/d3gl": patch
---

Canvas/SVG now draw a bordered network node as ONE stroked ring instead of two stacked discs, so a **translucent node fill keeps its border** — rendered and exported. The Scene path was painting the fill disc on top of a border disc, which let the ring colour bleed through the glyph's interior whenever the fill was not fully opaque; it now uses the same ring encoding the WebGL shader paints (a circle at `r·(1 − b/2)` stroked `r·b` wide), so all three backends render and serialize a bordered circle identically. `toSVG()` output for a bordered node drops from two `<circle>` elements to one carrying `stroke-width`.
