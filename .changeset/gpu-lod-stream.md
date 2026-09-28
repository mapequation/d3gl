---
"@mapequation/d3gl": patch
---

`layout({ backend: "gpu" })` with `lod()` on now keeps the LOD tree off the main thread, as
`backend: "worker"` does (#377). Before, the main thread built the coarsening tree itself (0.2 s at
325k nodes, 3.8 s at 1M, as one long task) and refit the tree's geometry on every streamed repaint. Now a
layout worker coarsens the graph while the GPU solver is built, and refits the tree to every frame the GPU
reads back. The frame is painted, positions and aggregates together, one worker round trip after the
readback, and `net.lodSource` reports `"worker"`.

On web-NotreDame (325,729 nodes, 1.5M edges, M1 Max, Chromium) with the Navigator's LOD settings and
the whole layout in view (`fit: true`), the main thread per layout repaint drops from 35 ms to 25 ms
(median), and `lod()` no longer blocks for 0.2 s. At the default zoom, where only part of the layout is
on screen, it drops from 14.9 ms to 3.2 ms. At 1M nodes (default zoom) the repaint drops from 164 ms to
79 ms and the 3.8 s block is gone. Until the tree arrives nothing is drawn, as with the worker layout:
about 0.3 s at 325k and about 5 s at 1M, with the page responsive throughout. `settled` now resolves
only once the tree has arrived and its geometry matches the final positions. If the LOD worker cannot
start or fails, one warning names it and the main thread builds and refits the tree as before.

`buildHierarchy` now accepts any edge list (`nodeCount`, `source`, `target`, `weight`); it never read
positions.
