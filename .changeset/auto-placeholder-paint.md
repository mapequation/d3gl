---
"@mapequation/d3gl": patch
---

`backend: "auto"` no longer paints a large scene on the throwaway placeholder canvas. Above the
existing ~10,000-element budget the placeholder is left correctly sized but blank instead of
being handed every drawable and repainted for a frame the WebGL install discards ~100-200 ms
later. This now covers geometry WebGL renders too (`geoMap` layers, `plot.layer()`,
non-decluttered `points()`), which is still built — only the placeholder push and paint are
skipped. Measured on a 120,000-polygon `geoMap`: ~104 ms less main-thread work per `layer()`
call, scaling linearly with drawable count. Small scenes keep `"auto"`'s instant canvas first
paint unchanged.
