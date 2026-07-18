---
"@mapequation/d3gl": patch
---

WebGL `toPNG()`/`toSVG()` exports now include the placed text labels, matching the Canvas/SVG backends. The WebGL backend retains the placed label set as an export-only stash (`textLayerMode: "export-only"`): `toPNG()` composites the labels onto the readback via the same 2D painter Canvas renders with, and `toSVG()` serializes them as `<text>` via the shared serializer. The live screen is unchanged — labels stay in the HTML overlay, and nothing is pushed per frame (the engine feeds the stash only at export time).
