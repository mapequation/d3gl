---
"@mapequation/d3gl": patch
---

Share engine-level options through one `BaseEngineOptions` type. `tooltipClass`,
`width`/`height`/`aspectRatio`, and `backend` were re-declared per engine and
consumed in each subclass — so `plot(host, { tooltipClass })` was silently
dropped (only `geoMap` wired it). These shared fields now live on a single
`BaseEngineOptions` (exported) that both `GeoMapOptions` and `PlotOptions`
extend, and the `BaseEngine` constructor consumes them once. `plot()` tooltips
now honor `tooltipClass`, and base-level options can no longer drift between
engines.
