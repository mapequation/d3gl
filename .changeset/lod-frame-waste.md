---
"@mapequation/d3gl": patch
---
Faster LOD frames while a layout streams (and on every zoom): about half the main-thread time per frame on a 325k-node web graph, with the same pixels and the same kept set.

- Link colours are resolved once per distinct weight per `style()`, not once per drawn super-edge per frame. A `linkStroke` colour scale used to run and have its CSS parsed for every super-edge on every frame.
- Declutter with mixed glyph sizes (2-3 px leaves next to aggregates up to `maxAggregateRadius`) uses one grid per radius class, so each glyph is tested against a few neighbours instead of every kept glyph in a cell sized to the largest aggregate: 3-10x faster on large frontiers. The kept set and `winners` are unchanged.
- Capped LOD labels (`labels({ max })`) pick the top-k with a heap and call `importanceOf` once per candidate. Before, a full sort called it twice per comparison.
- Unchanged LOD style columns (widths, colours, bends, highlight groups) are re-emitted as the same arrays, so the GPU upload skips them. A held view or a pan inside the same cut uploads only the link endpoints.
