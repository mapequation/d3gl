---
"@mapequation/d3gl": patch
---

Backend swap now re-inserts the new rendering surface at the previous surface's DOM
position instead of appending it to the end of the host. This keeps the canvas a stable
base layer, so HTML elements the caller appended to the host after it (e.g. an overlay)
keep painting on top across a `setBackend()` switch or the `"auto"` canvas→WebGL upgrade,
with no `z-index` needed.
