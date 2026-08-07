---
"@mapequation/d3gl": patch
---

Fix multiple pass-through layers silently clobbering each other. Declaring a second
`passThrough: true` layer erased the first — on **both** the WebGL and Canvas backends — because
every layer's repaint started by clearing the shared accumulation surface, and on WebGL a single
`sizeMode` flag was overwritten by whichever layer registered last. The repaint pass is now
cycle-scoped: it walks every pass-through layer in declaration order, clears once, and composites
the rest on top, so N layers coexist at the memory cost of one framebuffer. `sizeMode` is now
per-layer on WebGL, as it already was on Canvas. Single-pass-through scenes are unchanged.
