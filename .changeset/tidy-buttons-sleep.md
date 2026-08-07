---
"@mapequation/d3gl": patch
---

Fix `toSVG()` returning an empty document on the WebGL backend. Content drawn by the GPU-instanced
lanes — network nodes/links/arrows/half-arrows/pies, an LOD cut frontier, decluttered plot points —
has no retained scene, so a WebGL export serialized only `<defs/><g/>`. The engine now builds a
vector view of the lanes' current emit and hands it to the backend as an export-only stash (the same
seam label export uses), so `toSVG()` exports the live view on every backend. Export-time only: the
pan/zoom path is untouched. Canvas and SVG were unaffected and are unchanged.
