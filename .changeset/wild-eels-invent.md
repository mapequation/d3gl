---
"@mapequation/d3gl": patch
---

Pixel-verify the WebGL `toSVG()` export against the Canvas export. The instanced-lane vector
converter behind a WebGL export was previously checked only by element counts and unit-level
geometry, so a coordinate error in the constant-pixel `sizeMode: "screen"` bake (arrow tip setback,
half-arrow taper/bend) could ship a plausible-looking but subtly wrong vector file. The
backend-equivalence harness now rasterises both backends' exports and diffs them position-tolerantly
across straight links, arrowheads (straight and bent) and half-arrows, in both size modes, at two
zoom levels. No runtime behaviour changes.
