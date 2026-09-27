---
"@mapequation/d3gl": patch
---

`layout({ backend: "gpu", nested })` now lays the module map out on the GPU (#355) instead of handing it to
the CPU worker. Every module at every depth is solved at once — one batched solve over the whole module
tree, with the CPU layout's radii, seeds, sibling links, forces and schedule — and streamed within the
GPU layout's frame budget, so the page keeps its frame rate. A cold layout streams in as one animation of
all depths converging together; a warm start or a transition (`nested: { warm: true }`, `transition`)
reads back only the final layout, placed over the current map, then eases to it as before.

Measured on an Apple M1 Max in Chromium at 60 Hz: a 325,729-leaf Infomap-like map lays out in 2.1 s cold
and 1.8 s warm (the CPU worker: 21 s and 22 s); a 1,000,000-leaf map in 6.7 s and 5.5 s (CPU: 64 s). The
GPU solve updates siblings together where the CPU applies them one by one, so the two maps differ in
detail but keep the same invariants: children inside their parents, siblings apart, linked siblings close.
Where the GPU layout cannot run, the worker lays the map out with one warning, as for the flat layout.
