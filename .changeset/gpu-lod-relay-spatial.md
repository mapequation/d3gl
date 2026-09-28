---
"@mapequation/d3gl": patch
---

`layout({ backend: "gpu" })` with `lod({ source: "spatial" })` now rebuilds the spatial tree off the main
thread, as `backend: "worker"` does (#343, #377). Before, the GPU layout's LOD worker only refit a coarsening
tree, so the main thread rebuilt the spatial tree from every frame the GPU read back. Now that worker rebuilds
it for every frame with the worker backend's own per-frame step, and the frame is painted with its tree one
worker round trip after the readback. The rebuilds stop once the layout has converged, a selected or hovered
aggregate is carried over to the cell in the same place, and `net.lodSource` reports `"worker"`. An edge-less
graph, whose LOD tree is always the spatial one, streams it from the worker too.

On web-NotreDame (325,729 nodes, 1.5M edges, M1 Max, Chromium, 300 ticks) with the whole layout in view
(`fit: true`), the main thread per layout repaint drops from 83 ms to 26 ms (median), the layout repaints
16 times a second instead of 5.5, and the 84 long tasks (7.7 s) of the run are gone. At the default zoom it
drops from 31 ms to 0.8 ms. The worker spends about 26 ms per frame on the rebuild. At the fit view nearly all
of the remaining 26 ms is the spatial source's per-frame link gather, which the worker backend pays as well.
