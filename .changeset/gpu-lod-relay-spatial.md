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
drops from 31 ms to 0.8 ms. The worker spends about 26 ms per frame on the rebuild. Those numbers predate the
super-edge rows (#433): at the fit view nearly all of the remaining 26 ms was the per-frame link gather, which
the LOD worker now sums with each tree for the glyphs the view keeps, as the worker backend's does — a streamed
repaint reads those rows instead of walking the edges (3.5 ms instead of 19.4 ms per repaint at 100k nodes in
software GL; at 1M nodes and 10M edges 1.5 ms instead of 225 ms at the fit view), for 14-16 ms more per rebuild
in the worker on web-NotreDame.
