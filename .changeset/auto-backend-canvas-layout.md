---
"@mapequation/d3gl": patch
---

Fix layout shift in `"auto"` backend mode. Backend `<canvas>` elements are now
positioned absolutely within the (positioned) host instead of sitting in normal
flow. During the canvas→WebGL upgrade — and the React StrictMode double-mount that
compounds it — two or more backend canvases briefly coexist; as `display:block`
elements in normal flow they stacked vertically, inflating the host's height and
rendering the live map below its reserved box until the stale canvases detached (a
visible "jump up"). Absolute positioning overlaps coexisting canvases at the host's
origin so the swap never affects layout. The engine also promotes a `static` host
to `position:relative` so the absolute canvas anchors correctly even for bare-engine
consumers (the React `<GeoMap>`/`<Plot>` wrappers already set `position:relative`).
Hit-testing is unaffected — pointers are measured from `host.getBoundingClientRect()`.
