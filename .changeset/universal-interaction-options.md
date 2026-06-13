---
"@mapequation/d3gl": patch
---

Make the declarative interaction options (`hover`, `tooltip`, `selection`) universal across
both engines. They were only exposed on `geoMap` layers, even though the underlying machinery
(hover overlay, tooltip, selection styling, hit-testing) already lived in the shared base —
so `plot` layers could not declare hover/tooltip/selection. The options are now lifted into a
shared `InteractiveLayerOptions` interface and forwarded by both `Plot.layer()`/`Plot.points()`
and `GeoMap.layer()`, so `plot.layer(..., { hover, tooltip, selection })` and
`plot.points(..., { hover, … })` work exactly like their `geoMap` counterparts. No change to
existing `geoMap` behavior.
