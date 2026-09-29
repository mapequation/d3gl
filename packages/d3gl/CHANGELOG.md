# @mapequation/d3gl

## 0.11.0

### Minor Changes

- [#416](https://github.com/mapequation/d3gl/pull/416) [`e612569`](https://github.com/mapequation/d3gl/commit/e612569a2ee278c2ecd90634fb5e887492dcd6db) Thanks [@danieledler](https://github.com/danieledler)! - **New:** `lod({ source: "spatial" })` groups nodes by where the layout put them instead of by their links: a quadtree over the positions, up to 8 nodes per bottom cell, so every aggregate is a compact region drawn where its members are. On a force layout that spreads communities apart, the structural tree's aggregates cover the whole view and the cut draws a large share of the graph; the spatial one keeps the frontier bounded by the screen. On a 325k-node web graph (web-NotreDame) at the fit view the frontier is 279 glyphs instead of 72,106, and the main thread spends 10 ms per frame on the cut, declutter and links instead of 19 ms (6 ms instead of 22 ms at 4× zoom; a zoom frame once settled takes 5 ms median / 8 ms p90 in the browser instead of 16 / 23 ms).

  On the `"worker"` backend the worker rebuilds the tree on every streamed frame (24-27 ms per frame on that graph, 52-58 ms with per-node colours) and hands it over whole; it stops once the layout has converged, and pauses while the main thread has not handed back earlier frames. The `"gpu"` backend's LOD worker does the same for every frame the GPU reads back ([#425](https://github.com/mapequation/d3gl/issues/425)). The `"positions"` and `"force"` backends rebuild it on the main thread when a layout lands; a position transition or a drag refits the tree and rebuilds it once the nodes come to rest. Links between glyphs are summed from the graph's edges (no super-edge table is built); a link leaving the view points at the off-screen cell that holds its neighbour, glyphs at different levels are always linked, and an undirected pair is one line. While a worker streams it sums them too: it cuts and declutters each tree it rebuilds the way the main thread will (at the view, or at the fit while the camera follows the layout) and hands over, with the tree, each kept glyph's links summed per glyph or off-screen cell it reaches, so a streamed repaint reads rows bounded by what the kept glyphs link to instead of every edge in view — about 1 ms instead of 14 ms for the cut, declutter and links at the fit view of that graph, for 14-16 ms more per rebuild in the worker and 0.05-0.6 MB per frame; 1.5 ms instead of 225 ms at 1M nodes and 10M edges, for 90-190 ms more per rebuild in the worker and 0.4-8 MB per frame. On the other backends, and for a glyph whose row the worker's cut cannot serve (mid-gesture, or after zooming a settled layout), the main thread sums them, and an unchanged view re-emits them from a memo; that gather grows with the edges in view — about 10 ms at the fit view for 1.5M edges, ~190 ms for 5.8M — so away from a streaming worker the spatial source suits graphs up to a few hundred thousand nodes. A selected or hovered aggregate is carried over to the cell in the same place when the tree is rebuilt. `"structure"` stays the default; `net.superEdgeStats` reports the spatial gather's work (`visits`: edges walked on the main thread; `entries`: summed row entries read).

  **Behaviour changes:** every LOD tree's aggregate extent is now the smaller of the old compounding bound and the distance to the farthest corner of its members' exact bounding box, so an aggregate is culled and expanded on a tighter footprint (it expands a little later as you zoom in). An edge-less graph's LOD tree (`buildSpatialLODTree`) is the new spatial tree, with up to 8 points per bottom cell instead of one, so it opens coarser (its default expand threshold follows); pass `lod({ spatial: { bucket: 1 } })` for the old one-point cells. `lod({ spatial: { maxDepth } })` now caps a cell's depth below the root box (default 16, and at most 16: positions are quantised to 16 bits per axis) instead of the old quadtree's recursion (default 24). Aggregate colours are computed several times faster, with identical results.

### Patch Changes

- [#430](https://github.com/mapequation/d3gl/pull/430) [`e7245bd`](https://github.com/mapequation/d3gl/commit/e7245bdac9c96818eda1e91734ebd9a139be2b12) Thanks [@danieledler](https://github.com/danieledler)! - `layout({ backend: "auto", nested })` now lays the module map out on the GPU wherever `backend: "gpu"` would ([#375](https://github.com/mapequation/d3gl/issues/375), [#355](https://github.com/mapequation/d3gl/issues/355)). Before, it always used the worker. It is the same batched GPU solve: a cold layout streams in as one animation of all depths, and a warm start or a transition (`nested: { warm: true }`, `transition`, the call an app makes after re-clustering) reads back only the final layout and eases to it. Where the device or the module tree is unsupported, the worker lays the map out with the same options and no warning, as the flat `"auto"` layout does. A GPU solve that fails (it throws while starting, or stops before its final harvest) still warns, and the worker lays the map out. The nested fallback warning now reads `[d3gl] the GPU nested layout fell back to the CPU worker: <reason>.`

- [#413](https://github.com/mapequation/d3gl/pull/413) [`7fdd7ad`](https://github.com/mapequation/d3gl/commit/7fdd7ad783df6a139d93149ad8c718d38833e954) Thanks [@danieledler](https://github.com/danieledler)! - Pan/zoom and node-drag input now draw once per animation frame instead of once per event. A burst of wheel ticks, a pan's mouse moves or a node drag's pointer moves records only the latest state; the engine then runs one frame at the latest transform, merged with any streamed layout frame that lands in the same frame. On a large network this turns a zoom gesture's one long task per wheel event (the LOD cut, declutter and super-edge gather ran inside every event handler) into one pass per frame, and drags no longer re-cut per pointer move. `enableZoom`'s `onTransform` fires once per drawn frame with the drawn view; `pick` answers against what is drawn; a programmatic `setTransform` still draws at once.

- [#446](https://github.com/mapequation/d3gl/pull/446) [`c3991a2`](https://github.com/mapequation/d3gl/commit/c3991a2a140402bd54a6fa15f11ab9cf540e5d8b) Thanks [@danieledler](https://github.com/danieledler)! - network: `nodeFill: { by, scale }` colours nodes by a metric (`"degree"` | `"strength"` | `"flow"` | accessor) through a colour scale, like `nodeRadius`'s `{ by, scale }`; an LOD aggregate is filled with the scale on its summed metric, so a module reads as its total flow. `flowBorder.moduleFlow: (path) => number | undefined` gives the modules of the engine's hierarchy their own enter/exit flow, by Infomap path, instead of their members' sum. A `flowBorder.color` accessor now gets the value an aggregate's ring draws (index `-1`), and under LOD a glyph's ring colour is looked up by its own node, not by its position in the frontier.

- [#369](https://github.com/mapequation/d3gl/pull/369) [`6b49c20`](https://github.com/mapequation/d3gl/commit/6b49c204600e52ee6e461cd84bd4ca7731d1764d) Thanks [@danieledler](https://github.com/danieledler)! - Streaming `layout({ fit: true })` now keeps framing the layout until it settles, and frames it tightly ([#327](https://github.com/mapequation/d3gl/issues/327), [#309](https://github.com/mapequation/d3gl/issues/309), [#347](https://github.com/mapequation/d3gl/issues/347)).
  - **Programmatic view changes are no longer gestures.** d3-zoom emits `start`/`end` for the engine's own re-seeds (the `enableZoom` seed, and the re-seed after every `setTransform` or fit frame), and the engine treated them as a user gesture. A streaming fit was released on its first frame, so the camera froze on the seed while the layout grew past it. Every programmatic `setTransform` also ran a full gesture boundary: it re-pushed `hideOnInteraction` layers twice and snapshotted and repainted pass-through layers. Only events with a source input event are gestures now, on every engine.
  - A real wheel or drag still takes over the view. So does an explicit `setTransform` on a network (for example a zoom-to-module), so neither a later frame nor the settle reframes away from it.
  - With zoom enabled, a programmatic `setTransform` still settles like the end of a gesture. It hides the tooltip and hover highlight, and on Canvas/SVG networks it re-cuts the LOD frontier and screen-mode arrows for the new view once. Without zoom, call `syncScreenGeometry()` for that, as before.
  - `enableZoom()` now seeds the gesture silently: it no longer re-renders the unchanged view. It still calls its `onTransform` callback once with that view, so an overlay starts in step (for example after `GeoMap.setProjection` resets the view). A programmatic `setTransform` still does not call it.
  - **Tight fit box.** The fit frames the bounding box of the node positions, recomputed every streamed frame and padded by the largest node radius. While the layout streams, it ignores a handful of flung-out stragglers: at most min(64, 0.5% of the nodes) per side, 10-30% or more of the layout's size beyond the rest. A small disconnected component that far out is dropped the same way and streams just outside the frame. The settled layout is framed by its exact bounding box, so the final view shows every node, that component included. Layouts under 200 nodes are always framed exactly.
  - The old fit padded the top LOD modules' centroids by their median extent. That compounds up the tree and framed the layout 1.6-4.3× too loose. With LOD off it computed the box once from the seed and never updated it. With LOD on, the tighter framing means the opening view draws a finer, larger LOD frontier than before (see the PR's Performance section).

- [#443](https://github.com/mapequation/d3gl/pull/443) [`e74e1e1`](https://github.com/mapequation/d3gl/commit/e74e1e1314199539934a4390c64575edc1e468af) Thanks [@danieledler](https://github.com/danieledler)! - `layout({ fit: true })` now frames every layout, and a `transition` eases the camera along with the nodes ([#427](https://github.com/mapequation/d3gl/issues/427)).
  - **Fit + transition.** With `transition` and `fit: true` (a re-clustering: `layout({ nested: { warm: true }, transition, fit: true })`), the camera eases from the current view to the view that frames the final layout, on the transition's own easing in the same frames. The map ends framed, with no jump, even when it grew. The world rectangle the view shows moves in a straight line as the nodes do, so the zoom is monotonic and a node on screen at both ends stays on screen throughout. Before, the camera jumped twice: to the old layout at the call, then to the new one when the worker's result landed. The camera waits while a worker computes the target. A resize or a node-size change mid-ease re-aims the camera from where it is, so it still ends framed with no jump. The box is measured once when the transition starts; each frame moves the camera in O(1).
  - **Released on a real interaction.** A wheel or drag gesture, a node grab or an explicit `setTransform` during the transition leaves the camera where it is; the nodes still ease to the end. The engine's own camera moves are not gestures. A node grab now also releases a streaming fit, so the camera holds still under the cursor. The fit ends with its layout: after `stopLayout()` (or a new `layout()` or `data()`) the camera stays where it stopped, and nothing after the stop reframes it.
  - **`fit` on every backend.** `"positions"` and `"force"` layouts (and a warm nested layout without a transition) are framed once, when they land, on plain and state networks alike. Before, `fit` was ignored there; a state network's `"force"` layout now keeps its positions in the solver's scale and frames them with the camera, as its `"worker"` and `"gpu"` layouts already did (without `fit` it still rescales them to fill the view).
  - **Cold nested maps frame their actual bounds.** A cold nested layout used to stay framed on its root disc (radius `10·√N`), which the solved map only partly fills (fill 0.53 on a Navigator map, 0.65 on a generated one). It now settles on the nodes' exact bounding box like a flat layout (0.80 on the generated map). While it streams, it frames a box it is known to end inside: the root disc, then each depth's placed discs. So the camera only zooms in as depths land. The worker transport posts that box, the root disc as the stream starts, then one with each depth frame (`nestedLayout`'s `onDepth` gets it as a third argument; `nestedRootBounds` gives the root disc). A stream that posts none frames its live nodes, like a force layout.

- [#417](https://github.com/mapequation/d3gl/pull/417) [`91b4f03`](https://github.com/mapequation/d3gl/commit/91b4f0349d5d07b921275e88747db1cee3957bc9) Thanks [@danieledler](https://github.com/danieledler)! - `layout({ backend: "gpu" })` no longer freezes the page while it runs ([#352](https://github.com/mapequation/d3gl/issues/352)). Each streamed frame used
  to queue a batch of ticks and then read every position back synchronously, which blocked the main
  thread until the GPU had finished. On web-NotreDame (325,729 nodes, 1.5M edges, M1 Max) animation-frame
  tasks took 45 ms on average and up to 366 ms, the main thread spent 97% of the run in long tasks, and the
  page drew about 11 frames per second. Now a frame reads positions back from a copy the GPU finished
  earlier (a fenced `STREAM_READ` pixel buffer). It then encodes only as much layout work as fits a GPU
  budget of `min(10 ms, 0.6 × the frame interval)`. A tick larger than the budget is split across frames
  in row bands, and the result is bitwise equal to an unsplit tick. Layout repaints happen in the same
  frame as the readback, at most 20 per second, and take at most about half of the main thread and the
  GPU. A tab that was hidden never delays them.

  On web-NotreDame the transport's own main-thread work is 0.3 ms per frame on average (p95 0.8 ms), and
  the page renders at 120 fps while the layout streams (measured in Chromium at 120 Hz). The layout now
  gets at most about 60% of the GPU, so 300 ticks take 10.9 s instead of 5.7 s of frozen page. A node drag
  reheats through the same budget. The page keeps 75-110 fps while a node is held, where the old path
  spent 97% of the drag in long tasks at about 17 fps. `settled` resolves only after the final positions
  have been read back. If the WebGL context is lost, or the layout turns non-finite, the run stops with one
  warning and keeps the last finite positions. Before, it polled forever or streamed NaN.

- [#418](https://github.com/mapequation/d3gl/pull/418) [`3ea77a3`](https://github.com/mapequation/d3gl/commit/3ea77a32323a27972b76fc74b6884bc07b3f510c) Thanks [@danieledler](https://github.com/danieledler)! - Network layout: new `layout({ backend: "auto" })` runs on the GPU where it can and on the worker everywhere else ([#375](https://github.com/mapequation/d3gl/issues/375)).
  - `"auto"` takes the GPU solve wherever `backend: "gpu"` would run it: a WebGL render backend whose device has float render targets, float blending (`EXT_float_blend`) and textures large enough for the graph. Anywhere else it runs the worker layout that `backend: "worker"` would start, with the same options (`multilevel`, LOD tree streaming). Unlike `"gpu"`, it prints no warning when it takes the worker, because that is an expected outcome. A GPU run that fails rather than being unsupported (for example a driver error while it starts) still warns.
  - The rest of the engine treats `"auto"` exactly like the backend it resolved to: `fit`, node-drag reheat, state networks, `nested` layouts, `transition` (ignored, as by the other streaming backends) and LOD streaming. `net.layoutTransport` reports which transport runs.
  - The default does not change: omitting `backend` behaves as before.
  - The GPU fallback warning now reads `[d3gl] the GPU network layout fell back to the CPU worker: <reason>.`

- [#420](https://github.com/mapequation/d3gl/pull/420) [`d3cc4d5`](https://github.com/mapequation/d3gl/commit/d3cc4d5e58e5574a179c73945f8eb7ac8f1e3310) Thanks [@danieledler](https://github.com/danieledler)! - `layout({ backend: "gpu" })` now stops once the layout has converged, by the same rule as the `worker` and
  `force` backends ([#124](https://github.com/mapequation/d3gl/issues/124), [#376](https://github.com/mapequation/d3gl/issues/376)): the mean node step falls below 6% of the equilibrium spacing and is not
  growing, at least 30 ticks into the heat schedule. `iterations` is a cap on the GPU backend too, and
  `whenSettled()` resolves at the stop, once the stop tick's positions are on screen. A drag's re-cool also
  stops at convergence (at most 120 ticks), and a drag itself never stops, as on the worker.

  The GPU decides the stop itself, once per tick, so the tick it stops at does not depend on the frame rate,
  the GPU budget or when positions are read back: the same graph stops at the same tick with the same
  positions every run. Ticks the transport queues before it reads the stop back leave the layout unchanged.
  A layout that goes non-finite is frozen on the GPU at once, in addition to the existing warning and stop.

  A graph with a module hierarchy (`data(graph, { modules })` or `lod({ modules })`) is seeded over its
  modules on the GPU and cools, so it stops like the worker's multilevel run. A plain graph still starts cold
  on the GPU (an equilibrium disc at full heat); a multilevel seed for plain graphs on the GPU is a separate
  change. A cold start on a large graph can keep moving for longer than the default budget, so the network
  example keeps its size-scaled budget for GPU runs.

- [#411](https://github.com/mapequation/d3gl/pull/411) [`789216b`](https://github.com/mapequation/d3gl/commit/789216bd13ea01666c4689393fcc17b1b41c72f8) Thanks [@danieledler](https://github.com/danieledler)! - GPU layout: springs on high-degree nodes are now computed in full ([#350](https://github.com/mapequation/d3gl/issues/350)).
  - `layout({ backend: "gpu" })` used to stop summing a node's springs after 4096 neighbours. The skipped springs still pulled on the neighbours but not on the hub, so the springs' net force was no longer zero. On web-NotreDame this dropped 13,507 springs on its five largest hubs, and after 100 ticks their spring forces were 1.5× to 119× too large in magnitude. Now a node with more than 256 neighbours is summed in chunks of at most 64 by a separate small pass. Every spring counts at any degree, and the hub forces match an exact sum (relative error ≤ 4·10⁻⁵).
  - Nodes with at most 256 neighbours (99.5% of web-NotreDame) get bit-identical spring forces. On that graph the spring work takes 0.88 ms instead of 2.07 ms (Apple M1 Max), and a whole tick costs about 0.3 ms (0.7%) more because of the extra pass. A graph with no node above 256 neighbours skips the new pass entirely.
  - `buildCSR(nodeCount, source, target, weight?)` can now also return per-entry edge weights (`csr.weights`, parallel to `neighbors`).

- [#410](https://github.com/mapequation/d3gl/pull/410) [`5a8e49e`](https://github.com/mapequation/d3gl/commit/5a8e49e521b31cbe15edcca7db21e509a4b81b1f) Thanks [@danieledler](https://github.com/danieledler)! - `layout({ backend: "gpu" })` checks what the GPU layout needs before it runs, and its worker fallback keeps every layout option.
  - **Capability checks ([#351](https://github.com/mapequation/d3gl/issues/351)).** The GPU layout now runs only on a WebGL2 device with float render targets, float blending (`EXT_float_blend`) and a texture size large enough for the graph's position, CSR and spring textures, and whose float blending passes a one-time functional probe. Before, a device without float blending took the GPU path anyway and drew wrong forces. Anywhere else it falls back to the worker with one console warning that names the reason.
  - **The fallback is the worker run ([#312](https://github.com/mapequation/d3gl/issues/312)).** A fallen-back GPU layout gets exactly the options `backend: "worker"` gets: it honours `multilevel` (a cold start stays cold), and with `lod()` on the worker builds and streams the LOD tree, so the main thread no longer builds it (about 0.36 s on web-NotreDame) and refits it on every streamed frame (about 22 ms). State networks forward `multilevel` too.
  - **Live transport ([#297](https://github.com/mapequation/d3gl/issues/297)).** `layoutTransport` reports the transport that is running now: after a worker error falls back to a synchronous solve it no longer says `"shared"`, and after a GPU fallback it reports the worker's transport.
  - **Portable readback.** Every GPU position readback (the layout's frames and the module-aware seed's levels) reads `RG/FLOAT` where the device reports that as its read format, and `RGBA/FLOAT` (which WebGL2 guarantees for float targets) elsewhere. Before, such a device got no positions back. Readback now writes straight into the positions buffer, which also takes an allocation and a copy off every streamed frame on devices that read `RG/FLOAT`.

- [#444](https://github.com/mapequation/d3gl/pull/444) [`0ca1d46`](https://github.com/mapequation/d3gl/commit/0ca1d46ea421d5e6e2c97b4bfd223c381f89ec20) Thanks [@danieledler](https://github.com/danieledler)! - Every GPU network layout (`layout({ backend: "gpu" | "auto" })`, flat or `nested`) now compiles its WebGL
  programs in parallel and off the main thread (`KHR_parallel_shader_compile`), before it builds its solver. With a
  cold shader cache (a first visit, or a new d3gl version), the click that starts a layout no longer freezes the page.
  On an M1 Max (Chromium, ANGLE Metal, `network().layout()` from a click, medians of 7-11 runs):

  | cold shader cache: click → first frame | before        | after         |
  | -------------------------------------- | ------------- | ------------- |
  | 552 nodes, flat                        | 1.69 s        | 1.12 s        |
  | 552 nodes, nested                      | 1.85 s        | 1.10 s        |
  | web-NotreDame (325k nodes), flat       | 3.31 s        | 2.20 s        |
  | web-NotreDame, nested                  | 2.56 s        | 1.72 s        |
  | 1M nodes, flat (LOD on / off)          | 4.78 / 3.93 s | 3.25 / 2.40 s |
  | 1M nodes, nested (LOD on / off)        | 2.65 / 3.18 s | 1.86 / 2.22 s |

  The click's longest main-thread task went from 1.3-1.9 s to 0.07-0.7 s.

  With a warm cache a flat layout starts as before, within the runs' spread. A nested layout's first frame comes
  21-22 ms later at 552 nodes and on web-NotreDame: its compile can only start once its prep is back. At 1M nodes the
  nested layout is within noise with LOD on and 0.2 s sooner with LOD off. A later layout on the same engine compiles
  nothing. A device whose float-blend probe failed before falls back to the worker at once.

  `layoutTransport` now reads `"gpu"` while the programs compile. If a link, the probe or the WebGL context then
  fails, it moves to the worker's transport; read it after `whenSettled()` for the value the run ended on. A node
  dragged during the compile is held once the layout starts, and a render-backend swap during the compile starts
  the layout on the new device.

- [#425](https://github.com/mapequation/d3gl/pull/425) [`bd32ddd`](https://github.com/mapequation/d3gl/commit/bd32ddd467622809b6787bf31e4cdecc04b01d1d) Thanks [@danieledler](https://github.com/danieledler)! - `layout({ backend: "gpu" })` with `lod({ source: "spatial" })` now rebuilds the spatial tree off the main
  thread, as `backend: "worker"` does ([#343](https://github.com/mapequation/d3gl/issues/343), [#377](https://github.com/mapequation/d3gl/issues/377)). Before, the GPU layout's LOD worker only refit a coarsening
  tree, so the main thread rebuilt the spatial tree from every frame the GPU read back. Now that worker rebuilds
  it for every frame with the worker backend's own per-frame step, and the frame is painted with its tree one
  worker round trip after the readback. The rebuilds stop once the layout has converged, a selected or hovered
  aggregate is carried over to the cell in the same place, and `net.lodSource` reports `"worker"`. An edge-less
  graph, whose LOD tree is always the spatial one, streams it from the worker too.

  On web-NotreDame (325,729 nodes, 1.5M edges, M1 Max, Chromium, 300 ticks) with the whole layout in view
  (`fit: true`), the main thread per layout repaint drops from 83 ms to 26 ms (median), the layout repaints
  16 times a second instead of 5.5, and the 84 long tasks (7.7 s) of the run are gone. At the default zoom it
  drops from 31 ms to 0.8 ms. The worker spends about 26 ms per frame on the rebuild. Those numbers predate the
  super-edge rows ([#433](https://github.com/mapequation/d3gl/issues/433)): at the fit view nearly all of the remaining 26 ms was the per-frame link gather, which
  the LOD worker now sums with each tree for the glyphs the view keeps, as the worker backend's does — a streamed
  repaint reads those rows instead of walking the edges (3.5 ms instead of 19.4 ms per repaint at 100k nodes in
  software GL; at 1M nodes and 10M edges 1.5 ms instead of 225 ms at the fit view), for 14-16 ms more per rebuild
  in the worker on web-NotreDame.

- [#421](https://github.com/mapequation/d3gl/pull/421) [`bfb3cbb`](https://github.com/mapequation/d3gl/commit/bfb3cbb564068bd5efbfbd33770d2d43591e6c34) Thanks [@danieledler](https://github.com/danieledler)! - `layout({ backend: "gpu" })` with `lod()` on now keeps the LOD tree off the main thread, as
  `backend: "worker"` does ([#377](https://github.com/mapequation/d3gl/issues/377)). Before, the main thread built the coarsening tree itself (0.2 s at
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

- [#424](https://github.com/mapequation/d3gl/pull/424) [`b5b196f`](https://github.com/mapequation/d3gl/commit/b5b196f0881a177a420aa6b8984754f36aadea3f) Thanks [@danieledler](https://github.com/danieledler)! - `layout({ backend: "gpu" })` now seeds plain graphs with a multilevel seed, as the CPU backends do ([#353](https://github.com/mapequation/d3gl/issues/353),
  [#312](https://github.com/mapequation/d3gl/issues/312)). A layout worker coarsens the graph (the same heavy-edge matching as the worker backend's seed and
  the LOD tree) while the GPU solver is built, and the GPU lays out every coarse level on that one solver,
  coarsest first, with each coarse node weighing the nodes it stands for, so every level sits at the final
  layout's scale. The levels run inside the streamed frame loop under the same GPU and main-thread budget
  as the refinement, and nothing is read back until the nodes are placed. Until that first frame the
  equilibrium-sized disc stays on screen. With LOD on, the LOD worker's one coarsening builds both the seed
  and the tree.

  `multilevel: false` starts the GPU layout from the disc. This now also applies when a module hierarchy is
  provided: the module-aware GPU seed used to run whatever `multilevel` said.

  On web-NotreDame (325,729 nodes, 1.5M edges, M1 Max, Chromium at 120 Hz) the first frame shows the seed
  0.8 s later than the disc start's first frame (1.34 s instead of 0.54 s after `layout()`), with the global
  arrangement already in place: mean edge length 679 instead of 16,682. The seed is paced by animation
  frames, so on a 60 Hz display that first frame comes about twice as late (estimated, not measured). The
  seeded run meets the CPU layouts' convergence rule at tick 149 (5.7 s), with a mean edge of 495. The disc
  start never meets it in its 300-tick budget and ends at 586. The seeded run matches the disc start's final
  quality after about 25 ticks (2.1 s instead of 10.9 s). The layout never overshoots its final extent.

  The module-aware GPU seed (a module hierarchy from `data(graph, { modules })` or `lod({ modules })`) now
  runs on the same solver and in the same frame loop, with mass-weighted levels, instead of building one
  solver per depth and reading each depth back synchronously. On a 200,000-node, 1,000-module tree the
  main-thread long task at `layout()` drops from 460 ms to 242 ms, the first frame comes 574 ms after
  `layout()` instead of 462 ms, and modules end slightly less compact after 300 ticks (the ratio of
  same-module to cross-module pair distance is 0.221 instead of 0.194).

- [#423](https://github.com/mapequation/d3gl/pull/423) [`73d1682`](https://github.com/mapequation/d3gl/commit/73d1682c0e26fa236cac1fdebe2d58e3ecebd711) Thanks [@danieledler](https://github.com/danieledler)! - `layout({ backend: "gpu", nested })` now lays the module map out on the GPU ([#355](https://github.com/mapequation/d3gl/issues/355)) instead of handing it to
  the CPU worker. Every module at every depth is solved at once — one batched solve over the whole module
  tree, with the CPU layout's radii, seeds, sibling links, forces and schedule — and streamed through the GPU
  layout's frame budget, so the page keeps its frame rate (at 1,000,000 leaves a frame that reads back carries
  up to about 17 ms of layout GPU work; a module of tens of thousands of children with very uneven sizes packs
  in time quadratic in that module, with frames stalling while it does). A cold layout streams in as one
  animation of all depths converging together; a warm start or a transition (`nested: { warm: true }`,
  `transition`) reads back only the final layout, placed over the current map, then eases to it as before.

  Measured on an Apple M1 Max in Chromium at 60 Hz: a 325,729-leaf Infomap-like map lays out in 2.1 s cold
  and 1.8 s warm (the CPU: about 20 s); a 1,000,000-leaf map in 6.7 s and 5.6 s (the CPU: over a minute). The
  GPU solve updates siblings together where the CPU applies them one by one, so the two maps differ in
  detail but keep the same invariants: children inside their parents, siblings apart, linked siblings close.
  Where the GPU layout cannot run, or its solve stops early (a lost context, a non-finite layout), the worker
  lays the map out with one warning; nothing of a stopped GPU solve lands.

- [#431](https://github.com/mapequation/d3gl/pull/431) [`ea1d38e`](https://github.com/mapequation/d3gl/commit/ea1d38ea5d5defb68341044b6a026c5483a43385) Thanks [@danieledler](https://github.com/danieledler)! - The GPU nested layout (`layout({ backend: "gpu", nested })`) no longer stalls frames on a module whose
  children's sizes are very uneven ([#380](https://github.com/mapequation/d3gl/issues/380)). Its disc collision used one grid per module, with cells as wide
  as the module's largest discs, so a module of many small children next to a few large ones tested nearly
  every pair: time quadratic in the module, one 55 ms step at 60,000 children and frames stalling for over
  100 ms while it packed. Each disc is now binned at the scale of its own size (cells per radius class, with
  the densest cells refined further), the heaviest searches are spread over many GPU threads, and the frame
  budget costs each step by the module's contacts instead of its leaf count.

  Measured on an Apple M1 Max in Chromium: one module of 60,000 children with power-law flows lays out in
  1.4 s (was 5.6 s) and one of 20,000 in 1.0 s (was 2.1 s), without a blocked frame; Infomap's trees of
  web-NotreDame (325,729 leaves) in 1.9 s (was 2.1 s), and a 1,000,000-leaf Infomap-like map in 4.5 s (was
  5.6 s). The layouts themselves are unchanged: every touching pair of siblings is still found, and the
  result is deterministic.

- [#430](https://github.com/mapequation/d3gl/pull/430) [`e7245bd`](https://github.com/mapequation/d3gl/commit/e7245bdac9c96818eda1e91734ebd9a139be2b12) Thanks [@danieledler](https://github.com/danieledler)! - The GPU nested layout ([#355](https://github.com/mapequation/d3gl/issues/355)) keeps its springs stable at hubs. It applies all of a module child's springs at once, where the CPU layout applies them one by one, so a child linked to many siblings that takes most of each link's pull could overshoot: a small, low-flow hub page in a directed Infomap tree, for example. On web-NotreDame's directed tree the solve went non-finite, and `backend: "gpu"` or `"auto"` fell back to the worker with a warning. On milder hubs it stayed finite but lost the arrangement, with linked siblings pushed apart. Each child's springs are now relaxed just enough to keep every step stable (only children past the bound change), from static data and at no per-frame cost. web-NotreDame's directed tree now lays out on the GPU: 4.1-4.4 s from the layout call to settled in the Network Navigator on an Apple M1 Max, against 8.9 s on the worker.

- [#442](https://github.com/mapequation/d3gl/pull/442) [`b85bd0d`](https://github.com/mapequation/d3gl/commit/b85bd0d4fb0d01a9b65e6ff7c8ccca2790f0e4c9) Thanks [@danieledler](https://github.com/danieledler)! - The GPU force layout's (`layout({ backend: "gpu" })`) Barnes-Hut repulsion no longer counts a node's own
  mass in the grid cells it sits in, as the CPU quadtree already does at its leaves ([#403](https://github.com/mapequation/d3gl/issues/403)). On the multilevel
  seed's coarse levels a heavy supernode of mass m_i that shared its finest cell with a light one of mass m_j
  was repelled about m_i / 2m_j times too strongly, and one alone in its cell pushed itself by a rounding
  error, so the seed threw heavy supernodes out of place. The first frame then showed stragglers: on
  web-NotreDame it spanned 1.27 × 1.41 times the settled layout (M1 Max), and a fit view zoomed in over the
  next frames. It now spans 1.00 × 1.06 times, as the CPU seed does (1.01 × 1.04), and the seed's Barnes-Hut
  levels match the CPU's solve of the same levels.

  The seeded layout also converges sooner and ends where the CPU layout does. On web-NotreDame it meets the
  CPU layouts' convergence rule at tick 118 instead of 149 (the worker backend stops at 116), about 1 s
  sooner in the Network Navigator, and its mean edge length at tick 150 is 459 instead of 495, against the
  CPU layout's 461. The seed frame's mean edge length is 528 instead of 679, already below the 586 a disc
  start ends at after 300 ticks. These figures replace the tick-149, 495 and 679 figures of the GPU
  multilevel seed entry ([#353](https://github.com/mapequation/d3gl/issues/353)).

  On a graph that takes the Barnes-Hut path (above 4,096 nodes by default; smaller graphs use the exact
  loop and are unchanged), a node that shares its finest cell with one other node now gets that node's exact
  push, where it got 4/3 of it. A Barnes-Hut tick costs the same or slightly less. Timed from web-NotreDame's
  settled layout in batches of 20 ticks on an M1 Max, it went from 10.2 to 10.0 ms at 325k nodes, and stayed
  at about 36.5 ms on a 1M-node disc without edges. That setup differs from the one behind the tile pyramid
  entry's 10.8 and 35.6 ms ([#354](https://github.com/mapequation/d3gl/issues/354)), so compare each pair of figures only with itself.

- [#409](https://github.com/mapequation/d3gl/pull/409) [`c53ea96`](https://github.com/mapequation/d3gl/commit/c53ea96baf4c3d4efe71b03ebcd5e01dbd17242a) Thanks [@danieledler](https://github.com/danieledler)! - The GPU force layout (`layout({ backend: "gpu" })`) ticks about 3× faster on large graphs. Each tick used to sum every node into a single pixel twice (once for the centroid, once for the bounding box). Blending on that one pixel ran serially and took about 80% of the tick. The centroid and the box now come from a gather-tree reduction that does no blending. On a 325k-node / 1.5M-edge graph a tick drops from about 45 ms to 12 ms of GPU time (about 138 ms to 39 ms at 1M nodes, M1 Max). The forces are the same up to float32 rounding. The centroid is also more accurate: a serial float32 sum over 1M nodes can be off by about 130 world units, and the tree sum by less than 0.001.

- [#439](https://github.com/mapequation/d3gl/pull/439) [`cf388c4`](https://github.com/mapequation/d3gl/commit/cf388c43fbd6613e8a5331cbb1c88e52b3522187) Thanks [@danieledler](https://github.com/danieledler)! - The GPU force layout (`layout({ backend: "gpu" })`, flat and `nested`) spends less main-thread time per tick, so small maps settle sooner. Its render passes no longer call luma's `device.submit()` one by one: each work item of a tick submits once, after its last pass, and a readback copy submits once. WebGL runs every pass as it is encoded, so each extra submit only built a command encoder, a command buffer and a promise (6.5-8.5 µs each on an M1 Max). The force clear is no longer a render pass of its own either: it is part of the force pass that follows it. On an M1 Max (headless Chromium, ANGLE Metal), a flat tick's main-thread encode drops by 11-22% (0.25 → 0.22 ms at 2k nodes, 0.49 → 0.38 ms at 20k, 0.76 → 0.59 ms at 1M). A nested stream tick's encode drops by 19-34% from 20k leaves up, where a collision step runs about 28 render passes (0.98 → 0.71 ms at 20k leaves). A 20k-node layout settles 11-12% sooner at 60 and 120 Hz, and 2k-20k-leaf nested layouts 4-5% sooner. The multilevel seed reaches its first frame 10-21% sooner at 20k and on web-NotreDame (325k nodes). Large maps are bound by the frame's GPU budget, so their ticks per second do not change. Layouts are bit-for-bit what they were on the M1 Max (flat and nested, 2k to 1M nodes) and on SwiftShader (2k and 20k).

- [#422](https://github.com/mapequation/d3gl/pull/422) [`6864712`](https://github.com/mapequation/d3gl/commit/6864712752870281133642800fc96c31bbce68aa) Thanks [@danieledler](https://github.com/danieledler)! - A `layout({ backend: "gpu" })` now moves with its render backend, and survives a lost WebGL context ([#311](https://github.com/mapequation/d3gl/issues/311)).
  - **Backend swaps.** The GPU layout runs on the WebGL backend's device. Before, `setBackend("canvas")` (or `"svg"`, or `"auto"`) left it running on the device of the backend that had just been destroyed, holding about 54 MB of GPU memory on web-NotreDame (325,729 nodes) until the next `layout()`, and a later drag reheated it there. Now the engine stops it right before the old backend is destroyed, which frees that memory while the device is still alive. The layout then continues **warm**: from its last positions, with the ticks it had left and the heat it had cooled to, on the GPU of the new WebGL backend (including after an `"auto"` upgrade), or on the CPU worker for Canvas and SVG, with one console warning. A layout that had already settled continues as an idle run (on the GPU of a new WebGL backend, on the worker for Canvas and SVG), so dragging a node still reflows it. A drag in progress carries over. A backend picked while an `"auto"` upgrade is still running is waited for, so the layout lands on its GPU, not on the worker.
  - **Context loss.** A lost WebGL context used to stop the layout where it was. It now continues warm on the worker the same way, and so does a GPU layout that turned non-finite, from its last finite positions.
  - **Cost.** The move costs the main thread about 0.5 ms to free the GPU layout and about 5 ms to hand the graph to the worker, both once per swap; with `lod()` on, adopting the worker's level-of-detail tree adds about 20 ms once, and a move onto a new WebGL device rebuilds the GPU solver there (one task of about 130-185 ms on web-NotreDame). Nothing is added per frame. The worker continues at the CPU's pace (about 1.2 ticks per second on web-NotreDame, measured on an M1 Max), so a swap away from WebGL slows the rest of the run, but it no longer restarts the whole budget. An idle worker kept for dragging holds a copy of the graph: about 27 MB on web-NotreDame (edge endpoints and weights, positions, and the solver's per-node arrays), plus its level-of-detail tree when `lod()` is on.

- [#419](https://github.com/mapequation/d3gl/pull/419) [`6351d8b`](https://github.com/mapequation/d3gl/commit/6351d8b412fce9e85172a979e259d26eb0b50d03) Thanks [@danieledler](https://github.com/danieledler)! - The GPU force layout (`layout({ backend: "gpu" })`) stores its Barnes-Hut grid pyramid in three textures instead of one per level. The repulsion pass therefore binds 7 textures instead of up to 13 (one per pyramid level: 13 above 262k nodes), well inside WebGL2's guaranteed 16, and a tick gets slightly faster: on an M1 Max the repulsion pass drops from 9.7 to 9.5 ms and the whole tick from 11.1 to 10.8 ms at 325k nodes (about 2%), and the tick from 36.0 to 35.6 ms at 1M (about 1%). Layouts are unchanged on the measured device: on an M1 Max (ANGLE Metal), every node's force is bit-for-bit what it was before on web-NotreDame (325k nodes), on a 1M-node graph, and on graphs of 3,000 and 4,096 nodes. Other GPUs were not measured; their shader compilers may round a few forces differently. The pyramid of a graph above 4,096 nodes takes about 4% more GPU memory (+0.96 MB at 325k nodes and above). Graphs of 4,096 nodes or fewer no longer allocate a pyramid at all, because they use the exact repulsion loop. Internally the solver now supports segments: groups of nodes that repel, attract and centre only among themselves, each with its own tile of the pyramid. This is groundwork for the GPU nested layout ([#333](https://github.com/mapequation/d3gl/issues/333)).

- [#450](https://github.com/mapequation/d3gl/pull/450) [`8387be8`](https://github.com/mapequation/d3gl/commit/8387be8f21619c509389736129904573b19b08ec) Thanks [@danieledler](https://github.com/danieledler)! - Loading a module hierarchy no longer blocks the main thread on its module tree. A `layout({ nested: true })` on the `worker` or `gpu` backend now has a Web Worker build the tree from `data(graph, { modules, moduleLinks })` (or `lod({ modules })`) and starts solving when it arrives; a LOD cut that draws the modules draws them from that tree as soon as it lands, and draws nothing until then, as while a worker streams a structural tree. The main thread only packs the records into typed arrays for the worker (35-45 ms for 325k nodes in a production browser build, where the build itself took 0.13 s and the cut over the not-yet-laid-out map another 0.4 s). The GPU layout's module-aware seed (`layout({ backend: "gpu" })` with a hierarchy) waits for the same worker-built tree, since it waits for its device anyway. Every other path (`lod()` with no such layout, the `force` and `positions` backends) still builds the tree on the main thread before the next frame; if no tree can be built at all, `whenSettled()` rejects instead of never settling. `lod()` now leaves a tree it would build from scratch to the end of the call chain until a layout has run on the graph `data()` set, not only on an engine that has never run a layout, so a worker layout in the chain takes the build over on every load; until the end of the chain `lodSource` reads `"none"`. An explicit `lod({ modules })` is checked for alignment with the graph when its build is deferred, so a bad one still throws from `lod()`. Where Web Workers are unavailable the tree is built, and the nested layout solved, synchronously inside `layout()`, as before.

  While LOD waits for a tree — a build `lod()` deferred, a tree a worker streams or builds — a `select()`, `highlight()`, `setStyle()` or `clearStyle()` on the network's layers is kept and drawn when the tree lands, exactly as the same call made then draws it, and `on("select")` fires at once. Before, such a call was silently dropped (and a selection made during a load never came back), or it pulled the deferred build onto the main thread; interaction state held when `lod()` ran also made it build at once. None of these calls builds the tree any more; the reads that need it (`pick()`, `selection()`, `toSVG()`, `toPNG()`) still build a deferred one at once. On Canvas/SVG, `select()`/`setStyle()` on an LOD network whose nodes have no border no longer throw `invalid color`.

  `moduleColors` computes one colour per module instead of one per node, and finds each node's module with integer work only: for a 325k-node Infomap map, 0.2 s to 0.06 s in a production browser build (0.22 s to 0.025 s in Node once warm), with identical output. The module-tree build also reuses the module chain it shares with the previous record, which in tree order (as Infomap writes records) is most of it.

  With `fit: true`, a cold nested layout that waits for its worker-built tree holds the camera where it is until the tree lands, then frames the root disc and zooms in as the depths land, as a start that did not wait does.

- [#417](https://github.com/mapequation/d3gl/pull/417) [`91b4f03`](https://github.com/mapequation/d3gl/commit/91b4f0349d5d07b921275e88747db1cee3957bc9) Thanks [@danieledler](https://github.com/danieledler)! - The WebGL instanced lanes (network nodes and links, pie wedges, arrows) now grow their GPU buffers by at
  least doubling. Under LOD the drawn frontier grows while a layout spreads or a zoom deepens. Before, every
  frame that drew a new maximum reallocated all of the lane's buffers (8 per lane). A frontier that grows
  fourfold now reallocates twice, and shrinking and growing back within the room reallocates nothing. A lane
  that grew keeps room for up to twice the largest frontier it drew. A lane that never grows, such as a LOD-off
  graph, keeps its exact size.

- [#370](https://github.com/mapequation/d3gl/pull/370) [`a2201c8`](https://github.com/mapequation/d3gl/commit/a2201c82ffdfc321e9a1757d93130a798f4531c4) Thanks [@danieledler](https://github.com/danieledler)! - Force layouts start at their own equilibrium scale, cool, and stop once converged.
  - **No more explosion on large graphs.** The multilevel seed (worker, `force`) lays every coarsening level out at the force model's equilibrium — a disc of radius `√(repulsion·N/centering)`, spacing `√(π·repulsion/centering)` — with coarse nodes weighing as many nodes as they stand for, instead of sizing the seed to the viewport. The plain disc seed and the GPU seeds (disc and module-aware) use the same scale. On web-NotreDame (325k nodes) the layout no longer overshoots its final extent 2.7× before settling. Coarse levels above `maxSeedNodes` (now 16384 by default) get a proportionally shorter solve instead of none.
  - **Step cap relative to the spacing.** A tick moves a node at most 16 equilibrium spacings (was 4× the starting span, which let most nodes jump across the layout on the first tick). CPU and GPU share the cap.
  - **Cooling + convergence ([#124](https://github.com/mapequation/d3gl/issues/124)).** A seeded force layout cools over its `iterations` budget, so a larger budget cools more slowly (a cold disc start keeps full heat, which it needs to untangle), and the CPU layouts (`force`, `worker`, and the worker's fallback) stop as soon as nodes move less than a small fraction of the spacing per tick — `iterations` is now a maximum, not a fixed count, and `whenSettled()` resolves at that stop. web-NotreDame converges in about 120 ticks instead of running 300, with shorter mean edges. `ForceLayout.run(n)` still ticks at full heat by default, but now stops early once the layout has converged and returns the ticks it ran (a call shorter than 30 ticks never stops early, so batched `run(n)` calls still tick exactly `n` times); `run(n, "cool")` cools over the budget instead. `ForceLayout` gains `cool()`, `hold()`, `converged`, `meanStep` and `spacing`. The GPU layout runs its whole budget (an early stop there needs a GPU readback it does not do yet).
  - **Worker frames by time.** The worker streams a frame about every display frame (and after any longer tick) instead of every `iterations / 60` ticks, and yields between ticks, so a drag's pin / unpin / stop lands within about one tick rather than after a whole batch. A drag reflows the layout at 30% of full heat on every backend, then re-cools until converged.
  - `seedPositions(graph, width, height, { force })` sizes the disc to the force equilibrium; `equilibriumSpacing(params)` is exported.

- [#372](https://github.com/mapequation/d3gl/pull/372) [`c1de988`](https://github.com/mapequation/d3gl/commit/c1de9882879967732f9e618530418ade9eb52df8) Thanks [@danieledler](https://github.com/danieledler)! - **Behaviour change:** `linkStroke` is now captured once per `style()` (or `data()`) call and remembered per weight, as node colours and radii already were. A colour scale mutated in place (new domain, theme swap) without calling `style()` again used to reach LOD super-edges on the next frame; now call `style()` again to apply it.

  Faster LOD frames while a layout streams (and on every zoom): about half the main-thread time per frame on a 325k-node web graph, with the same pixels and the same kept set.
  - Link colours are resolved once per distinct weight per `style()`, not once per drawn super-edge per frame. A `linkStroke` colour scale used to run and have its CSS parsed for every super-edge on every frame.
  - Declutter with mixed glyph sizes (2-3 px leaves next to aggregates up to `maxAggregateRadius`) adds one grid per radius class, so each glyph is tested against a few neighbours instead of every kept glyph in a cell sized to the largest aggregate: 3-10x faster on large frontiers. A glyph much larger than a non-empty class falls back to the single grid's scan, so a screen of large glyphs with a tiny one kept first stays within ~2x of the single grid. The kept set and `winners` are unchanged for radii ≥ 0 (an infinite radius included); a negative per-glyph radius (an unclamped radius scale extrapolating below its domain) now counts as 0. `DeclutterScratch` gains optional fields (`counts`, `classNext`, `levels`, `seq`, `probes`, `cells`) that `declutterScreen` creates on first use, so a hand-built `{ head, next }` scratch keeps working.
  - Capped LOD labels (`labels({ max })`) pick the top-k with a heap and call `importanceOf` once per candidate. Before, a full sort called it twice per comparison.
  - Unchanged LOD style columns (widths, colours, bends, highlight groups) are re-emitted as the same arrays, so the GPU upload skips them. A held view or a pan inside the same cut uploads only the link endpoints.
  - New `net.declutterStats` (type `NetworkDeclutterStats`): the frontier glyphs, distance tests and grid cells of the last LOD declutter pass, and the size of its reused scratch. Introspection for debugging and per-frame tests.

- [#412](https://github.com/mapequation/d3gl/pull/412) [`ff4c34b`](https://github.com/mapequation/d3gl/commit/ff4c34bbbf0833a76dcaab62a08d89cfc55a8c8d) Thanks [@danieledler](https://github.com/danieledler)! - Nested layout (`layout({ nested: true })`): two sibling discs that land on exactly the same point now separate by their collision distance, along a fixed direction derived from their indices. Before, they were flung about 10⁹ collision distances apart, and scaling the module's children into its disc then shrank every other sibling to a point ([#357](https://github.com/mapequation/d3gl/issues/357)). Layouts with finite positions and no coincident siblings are unchanged bit for bit.

- [#373](https://github.com/mapequation/d3gl/pull/373) [`c50a712`](https://github.com/mapequation/d3gl/commit/c50a7124289c1cbd7bf7e52d722cab927dfca1f5) Thanks [@danieledler](https://github.com/danieledler)! - Faster network loading. `parseEdgeList` (and `parseNetwork` for edge lists) now parses in one pass with no per-line or per-column strings, and indexes integer node ids by value instead of hashing them as strings — about 4x faster on a 1.5M-edge SNAP file (0.6-0.8 s to 0.15 s in Chromium), with identical output. `lod()` on an engine that has not run a layout yet no longer builds a structural LOD tree on the main thread when a `layout({ backend: "worker" })` follows in the same call chain: the build waits for the end of the chain, so the worker streams the tree as documented, and every other path still has its tree before the next frame. A synchronous call that needs the tree — `pick()`, `toSVG()`/`toPNG()`, `select()`/`selection()`, `highlight()`, `setStyle()`/`clearStyle()` — builds it at once, and `lod()` still builds at once when the network's layers already carry a selection, highlight or style override. With the worker layout in the chain, those calls see what they see during any worker-streamed load: no cut until the worker's tree arrives. Until then `lodSource` reads `"none"` where it used to read `"main"` right after such a `lod()`, and nothing is drawn or labelled. On Canvas and SVG this also makes `lod()` right after `data()` several times cheaper, because the cut is drawn once instead of replacing the full graph layer by layer. A `data()` swap later in the same chain gets the tree for the new graph. While LOD waits for its tree, frontier labels no longer rank and place every node of the undrawn graph.

- [#414](https://github.com/mapequation/d3gl/pull/414) [`2ac2bf1`](https://github.com/mapequation/d3gl/commit/2ac2bf1ced8352d6596e3f7a7a310fadbf846903) Thanks [@danieledler](https://github.com/danieledler)! - Faster LOD super-edges on every streamed layout frame and zoom, with the same links drawn: the super-edge gather no longer keeps its per-frame bookkeeping in `Map`s and `Set`s. On a 325k-node web graph it takes 0.35-0.68x the time it did (about 0.5x at 4x zoom, 0.4x with every node drawn), and on a 1M-leaf module map 0.3-0.4x on large cuts. It also stops making garbage for the collector: a `linkStroke` colour scale now answers a remembered flow without allocating, so with d3 colour and width scales the gather allocates only the arrays it returns. On the 325k-node graph that is 1.3 MB per frame instead of 19.4 MB (82k links drawn), under 1 byte per drawn link beyond its outputs, down from 90-230.
  - Memory: each network keeps a cover memo of 8 bytes per LOD tree node once cross-level edges are drawn (3.4 MB for the 325k-node graph), and a pair index plus row list of 20-40 bytes per link in the largest set of links it has matched in one frame: the links with both ends drawn (for reciprocal half-arrow widths), or the cross-level and anchored links. That set is about 12% of the drawn links at a typical view (under 1 MB). With every node of the 325k-node graph drawn (1.5M links) it is 40 MB, kept until the network is destroyed.

- [#371](https://github.com/mapequation/d3gl/pull/371) [`58d4cf2`](https://github.com/mapequation/d3gl/commit/58d4cf2b4309d96b45ee7a712b66907bbdc70724) Thanks [@danieledler](https://github.com/danieledler)! - The CPU force layout (`worker` and `force` backends) runs its Barnes-Hut repulsion about twice as fast, with the same result.
  - **Tree laid out for the traversal.** The quadtree is now one flat array of records in the order the traversal visits them, each with a pointer past its subtree, so a node's repulsion is a forward scan with no stack. Bodies are records of their own, so leaves need no separate loop.
  - **Nodes in spatial order.** Each build sorts the bodies into the tree's own Z order and keeps that order for the next tick, and the repulsion pass visits nodes in it, so neighbouring nodes read the same cells one after the other.
  - **Centering reuses the tree's centre of mass**, so there is no separate centroid pass.
  - **The nested (hierarchy) layout** walks a large module's children in the same Z order.

  The approximation is unchanged: same cells, same opening test, same summation order. On web-NotreDame (325k nodes) the worker's tick drops from about 485 ms to 240 ms and the layout converges in the same 116 ticks with bit-identical positions (tick loop 56 s → 28 s), and the multilevel seed before it takes about 0.96 s instead of 1.75 s. A main-thread `force` drag frame over 100k nodes drops from about 165 ms to 72 ms. The tree also uses about 40% less memory.

- [#415](https://github.com/mapequation/d3gl/pull/415) [`30520fc`](https://github.com/mapequation/d3gl/commit/30520fcd97e31f05c1380ee00926cbf2cdd31d95) Thanks [@danieledler](https://github.com/danieledler)! - The worker layout starts drawing a large graph while its multilevel seed is still running, so you no longer look at a blank canvas until the seed finishes.
  - **Seed progress frames.** While the multilevel seed solves its coarse levels, the worker posts the seed so far: the level being solved, projected down onto every node. It posts only levels with about a thousand nodes or more, whose projection already spans the finished seed (0.86–1.05× on every graph measured). The coarser levels are a few mass-sized discs with gaps between them and would be up to 2.4× too wide, so a fitted view would zoom out on them and then back in. The LOD geometry is sent with each frame, and the main thread draws each frame with one LOD cut, the same way it draws a refinement frame.
  - **Paced by time.** Frames are at least 16 ms apart, and at least three times as far apart as a frame takes to build, so posting takes at most a quarter of the seed's time. On web-NotreDame (325k nodes) the first frame arrives 42 ms into the seed instead of after the whole ~1.05 s seed. About 12 frames follow, and the seed takes about 0.27 s longer (roughly 1% of the time to convergence).
  - **Pin and stop during the seed.** A node you grab while the seed runs stays where you drag it: in the seed frames that follow, in the finished seed and from the first refinement tick. A stop ends the seed without a seed frame or refinement.
  - **Same result.** The seed runs the same ticks in the same order. On web-NotreDame the seed and the converged layout are bit-identical to before.

## 0.10.0

### Minor Changes

- [#299](https://github.com/mapequation/d3gl/pull/299) [`0333b40`](https://github.com/mapequation/d3gl/commit/0333b40c739f40a7f031f4662628fea70cc08b76) Thanks [@danieledler](https://github.com/danieledler)! - **Breaking:** `linkBend` for `linkStyle: "half-arrow"` is now a fraction of the link's length (as it already was for `"line"`), not an absolute world/pixel offset. In `sizeMode: "screen"` the bow used to stay a fixed pixel size while the link shrank, so links bulged into near-semicircles as you zoomed out; now each link keeps its shape at every zoom, on WebGL, Canvas, SVG and in `toSVG()` exports. Migrate by dividing the old value by a typical link length (e.g. `linkBend: 30` on a ~215-unit link → `0.14`; `0.15` is a good default).

### Patch Changes

- [#274](https://github.com/mapequation/d3gl/pull/274) [`41699cf`](https://github.com/mapequation/d3gl/commit/41699cff8c729b5f6671ecb139d0c86b9521ac86) Thanks [@danieledler](https://github.com/danieledler)! - Network LOD: the expand threshold now **adapts to the tree it cuts**, so `net.lod({ modules })` with no `expandPx` opens on a _map of modules_ instead of raw nodes.

  `expandPx` is an absolute on-screen size, but the footprint it is compared against scales with how many leaves the finest aggregate holds — 2 for a structural coarsening tree (7–23px across at a fit view), 30–60 for a provided module partition (96–123px). The fixed 48px default therefore did real work on the first and nothing on the second. The default is now `48·√(c/2)` for a tree whose finest aggregates hold `c` children, clamped to `[48px, half the shorter viewport side]`: coarsening trees and spatial quadtrees keep exactly the previous 48px, while a module partition gets a module-sized threshold (~190–280px).

  Passing an explicit `expandPx` is unchanged — it still means an absolute aggregate diameter in pixels. `defaultExpandPx(tree, width, height)` is exported for callers driving `cut()` directly.

- [#278](https://github.com/mapequation/d3gl/pull/278) [`8ef758f`](https://github.com/mapequation/d3gl/commit/8ef758f8eccd1d83df2771c506ca2e5b5c7bd86c) Thanks [@danieledler](https://github.com/danieledler)! - Canvas/SVG now draw a bordered network node as ONE stroked ring instead of two stacked discs, so a **translucent node fill keeps its border** — rendered and exported. The Scene path was painting the fill disc on top of a border disc, which let the ring colour bleed through the glyph's interior whenever the fill was not fully opaque; it now uses the same ring encoding the WebGL shader paints (a circle at `r·(1 − b/2)` stroked `r·b` wide), so all three backends render and serialize a bordered circle identically. `toSVG()` output for a bordered node drops from two `<circle>` elements to one carrying `stroke-width`.

- [#279](https://github.com/mapequation/d3gl/pull/279) [`c3d8769`](https://github.com/mapequation/d3gl/commit/c3d876984eba413c36013505df41dcc05e73b7ce) Thanks [@danieledler](https://github.com/danieledler)! - `backend: "auto"` no longer paints a large scene on the throwaway placeholder canvas. Above the
  existing ~10,000-element budget the placeholder is left correctly sized but blank instead of
  being handed every drawable and repainted for a frame the WebGL install discards ~100-200 ms
  later. This now covers geometry WebGL renders too (`geoMap` layers, `plot.layer()`,
  non-decluttered `points()`), which is still built — only the placeholder push and paint are
  skipped. Measured on a 120,000-polygon `geoMap`: ~104 ms less main-thread work per `layer()`
  call, scaling linearly with drawable count. Small scenes keep `"auto"`'s instant canvas first
  paint unchanged.

- [#256](https://github.com/mapequation/d3gl/pull/256) [`14d1b09`](https://github.com/mapequation/d3gl/commit/14d1b09f2de7085c91d41cadaad9ae0aaba5c475) Thanks [@danieledler](https://github.com/danieledler)! - Test infrastructure: browser perf-guard tier in CI ([#247](https://github.com/mapequation/d3gl/issues/247)). The `*-perf.browser.test.ts` per-frame guards now run headless in CI (advisory job `perf-browser`, pattern-discovered by `scripts/run-browser-perf-tier.mjs`), with their locally-calibrated wall-clock ceilings scaled for software-GL runners via `PERF_BUDGET_SCALE` (`src/__tests__/perf-budget.ts`). No library runtime changes.

- [#282](https://github.com/mapequation/d3gl/pull/282) [`7764ecc`](https://github.com/mapequation/d3gl/commit/7764ecca8e99823f63b13435ec1fcd93959f7cf2) Thanks [@danieledler](https://github.com/danieledler)! - Add a `curveTolerance` engine option so curves stay smooth when you zoom in.

  Curves drawn through a layer's `draw` callback (`arc`, `bezierCurveTo`, `quadraticCurveTo`, and
  anything a `d3-shape` generator emits) are flattened to a polyline **once**, at layer registration,
  in **world units**. The view transform only scales that baked polyline, so a facet of `t` world
  units measures `t·k` screen px at zoom `k` — at the default tolerance of `0.25`, a `k = 40` view
  put 14.6% of a disc's ink in the wrong place.

  `plot()`, `geoMap()` and `network()` now accept `curveTolerance` (world units, default `0.25`).
  Set it to `0.25 / maxZoom` for sub-pixel curves at your deepest zoom:

  ```ts
  const chart = plot(host, { width, height, curveTolerance: 0.25 / 40 });
  chart.enableZoom([0.5, 40]);
  ```

  Opt-in and default-preserving: omitting it bakes exactly the same geometry as before. It costs
  nothing per frame — the refinement is paid entirely in the one-time bake — but an arc's segment
  count grows as `1/sqrt(tolerance)`, so `0.25 / 40` records ~6.3× the vertices **of the curved
  drawables only** (straight paths, `rect`s and `points()` circles are untouched).

- [#254](https://github.com/mapequation/d3gl/pull/254) [`9c3438b`](https://github.com/mapequation/d3gl/commit/9c3438be98ff830a7d79226d802e3c90c0d89552) Thanks [@danieledler](https://github.com/danieledler)! - Allocation-free `declutterScreen`: the shared screen-space declutter engine no longer produces O(count) transient heap garbage per call (~41 MB per call at 300k glyphs, previously churned by every per-frame caller — the network LOD frontier declutter, the geo/map declutter, and the plot points lane). The per-glyph exclusion radius is now read directly inside per-form specialized loops instead of through a closure whose boxed double returns allocated a HeapNumber per read. Output is byte-identical (same kept set, same winners) and the uniform-radius path is ~1.5× faster per call.

- [#277](https://github.com/mapequation/d3gl/pull/277) [`053c492`](https://github.com/mapequation/d3gl/commit/053c492107aa57463eb3e0416666c41fce5d3139) Thanks [@danieledler](https://github.com/danieledler)! - network: `style({ linkStyle: "none" })` renders a network as **nodes only**. It is a skip, not a hide — the links, arrowheads and LOD super-edge layers are never built, never coloured and never uploaded, so turning links off on a large graph saves work instead of paying for an invisible buffer. A **constant** `linkWidth: 0` takes the same path (a width _scale_ that reaches 0 does not). Purely visual: the edges still drive the force layout and the LOD hierarchy, so toggling links never re-lays-out the graph. Works with LOD on or off and on all three backends. The large-scale network example's **Edges** toggle is wired to it, so "Off" now removes _all_ edges rather than only LOD super-edges.

- [#288](https://github.com/mapequation/d3gl/pull/288) [`d5e58eb`](https://github.com/mapequation/d3gl/commit/d5e58ebf451360abbf4893e7a1c2dbdf050f8440) Thanks [@danieledler](https://github.com/danieledler)! - perf(core): retain the Scene's per-layer vector view instead of rebuilding it on every layer push

  `Scene.drawables(name)` used to materialize a fresh `DrawableVector` per drawable (plus two colour
  tuples each) on every call, and `Scene.buffers(name)` a fresh interleaved `pointCenters` array.
  The engine calls both for every layer on every `pushLayers()` — once per `layer()` registration
  (so an L-layer map paid L×), on `removeLayer`, on `setClip`, on every backend install, and at both
  boundaries of a gesture on a map with a `hideOnInteraction` layer — so a push cost O(total
  drawables) in time and allocation before any backend saw the result.

  Both arrays are now built once per drawable set and shared (they were already retained for the
  layer's lifetime by whichever backend they were pushed to, so this costs no extra memory); a later
  `setFill`/`setStroke`/`setFlag`/declutter write is re-applied in place, allocation-free. Measured at
  1,000,000 drawables: 20 pushes 31.4 s → 0.1 s, and a gesture-boundary push after a declutter pass
  1,126 ms → 11 ms.

- [#250](https://github.com/mapequation/d3gl/pull/250) [`3a34688`](https://github.com/mapequation/d3gl/commit/3a34688f51f6d1e3a751a1ab8019417ba57d9a84) Thanks [@danieledler](https://github.com/danieledler)! - `plot()` and `geoMap()` now own text labels via `chart.labels(data, opts)` / `map.labels(data, opts)` ([#223](https://github.com/mapequation/d3gl/issues/223)) — the data-driven counterpart of `network.labels()`. Supply the data and d3-style accessors (`labelOf`, `anchorOf`, `importanceOf?`, `offset?`, `rotationOf?`, `max?`, `style?`, `className?`, `font?`/`color?`/`halo?`) and the engine measures each label's text once (real `measureText`, no magic-number metrics), places + culls collisions on every pan/zoom, and routes to the active backend: an HTML overlay on WebGL, native `<text>`/`fillText` on SVG/Canvas so labels survive `toSVG()`/`toPNG()` export. Labels come pre-styled by the built-in default look with a `style` inline override or a full-CSS `className` (the [#224](https://github.com/mapequation/d3gl/issues/224) policy, now shared). The overlay ownership, placement, and native-text routing are lifted into `BaseEngine`, so `network.labels()` is now its specialization of one shared path. `@mapequation/d3gl/labels` also exports `measureText`/`canvasFont`.

- [#289](https://github.com/mapequation/d3gl/pull/289) [`1403f53`](https://github.com/mapequation/d3gl/commit/1403f538e0c0de889188de3a452672a30c91dd96) Thanks [@danieledler](https://github.com/danieledler)! - Add at-scale **engine-level** per-frame regression guards for `plot()`, `geoMap()` and `network()`.
  The existing at-scale sweeps drove the Canvas/SVG **backends** directly, so everything above that
  seam — accessor resolution, instanced-lane emit, style-version caching, LOD/declutter integration —
  was only exercised at small N. Each engine now has a guard that drives its public entry point
  through the real `setTransform` at `PERF_BROWSER_N`, asserting deterministic signatures (styles
  resolved once at registration and never per frame, the geo projection never re-streamed, `draw`
  callbacks never re-run, GPU buffers neither recreated nor re-uploaded per frame) with a wall-clock
  ceiling as the backstop. Tests only — no runtime change.

- [#337](https://github.com/mapequation/d3gl/pull/337) [`fd63496`](https://github.com/mapequation/d3gl/commit/fd63496650af77d981835e4ea726daa385f20be1) Thanks [@danieledler](https://github.com/danieledler)! - Network: the engine now **owns the module hierarchy** ([#326](https://github.com/mapequation/d3gl/issues/326)). Pass it with the graph, as data: `net.data(graph, { modules, moduleLinks })`. Every module feature then reads it, whatever the LOD state:
  - The **LOD cut** draws it by default. The new `lod({ source: "structure" })` coarsens the graph structurally instead.
  - `lod(false)` **keeps** the hierarchy. The module tree is built lazily, once per graph and hierarchy, so toggling LOD or switching its source never rebuilds it. Once built it stays in memory until the next `data()`, also with LOD off and next to a structural cut's tree: about 64 B per node and module plus 16 B per super-edge pair (119 MB for 1M nodes and 3M edges).
  - **`layout({ nested: true })`** now works with LOD off. Before, it silently fell back to the force layout.
  - The **module-aware GPU seed** uses the hierarchy in every LOD mode.
  - **`NetworkHit.path`** is also reported for leaf hits with LOD off (the node's own path) and under a structural cut.

  `data()` checks once that the records match the graph's node indices, and throws on a missing, duplicate or out-of-range record. It also checks that every module link's endpoints are modules or leaves of that hierarchy, so a bad path throws there rather than later from a lazy tree build. `data(graph)` without the second argument clears the hierarchy. `lod({ modules, moduleLinks })` keeps working as a back-compat alias scoped to the LOD options, which `lod(false)` drops.

  This also fixes a bug: calling `lod({ modules })` after a worker-LOD run kept drawing the worker's coarsening tree. Now it draws the module tree, and switching back to the structural source re-adopts the worker's tree.

  The modular-map and modular-lod examples use the new API.

- [#237](https://github.com/mapequation/d3gl/pull/237) [`e844260`](https://github.com/mapequation/d3gl/commit/e844260486a73bf1ad3764fd84be7f478110e1bf) Thanks [@danieledler](https://github.com/danieledler)! - Flags-only per-frame declutter style path: zoom/pan frames with `declutter` on no longer snapshot the full colour/flag tables (9 bytes per drawable allocated + uploaded per frame) — the Scene now hands backends a persistent typed flags view by reference via the new optional `Backend.updateLayerFlags`, so WebGL rewrites only the flags texture (1 byte per drawable) and Canvas/SVG patch their retained vector views in place instead of re-materializing them. Directly smoother zoom on large decluttered layers.

- [#234](https://github.com/mapequation/d3gl/pull/234) [`b3530f1`](https://github.com/mapequation/d3gl/commit/b3530f10367994d09a4023d6a931ecb1a3350a45) Thanks [@danieledler](https://github.com/danieledler)! - Network LOD zoom/pan frames no longer allocate in the visible-set pipeline: `cut()` and `declutterFrontier()` now run on engine-owned, lazily-grown scratch (no boxed frontier/stack arrays, no output copies, no per-frame Float64Array/order/flags churn), and the frontier declutter sorts a typed index array on a flat precomputed key array instead of a boxed-lookup closure comparator. At a ~1M-glyph reductions-ON frontier this removes tens of MB of per-frame garbage and cuts the per-frame cut+declutter time roughly in half, so zoomed-out navigation over dense maps stays smooth.

- [#286](https://github.com/mapequation/d3gl/pull/286) [`bdfc3ce`](https://github.com/mapequation/d3gl/commit/bdfc3cef68d1bb1720722a9946ab7bc07b5dea90) Thanks [@danieledler](https://github.com/danieledler)! - Tests only: geo's per-frame draw path is now guarded on all three backends. Adds a WebGL leg (the
  default backend) and an SVG leg, and raises the always-on Canvas leg from ~15k to 50k polygons. No
  library behaviour changes.

- [#231](https://github.com/mapequation/d3gl/pull/231) [`7508b64`](https://github.com/mapequation/d3gl/commit/7508b6406d6541a77a4e9de2a8ec8a352fbb0ad7) Thanks [@danieledler](https://github.com/danieledler)! - Hover, tooltip, and click picking on large retained-Scene layers is now O(candidates near the pointer) instead of O(all drawables): `HitIndex.pick` uses a uniform spatial grid over entry bounding boxes (world layers) or glyph anchors (screen-size layers), preserving topmost-first pick semantics exactly. At 1M drawables a pick drops from ~13 ms (world) / ~78 ms (screen) to ~2 µs, so pointer interaction on full-detail layers stays fluid.

- [#243](https://github.com/mapequation/d3gl/pull/243) [`4915281`](https://github.com/mapequation/d3gl/commit/4915281d3e0445b5242af6fcd68f1f9459712fd9) Thanks [@danieledler](https://github.com/danieledler)! - WebGL `updateLayer` now updates an existing layer's renderer IN PLACE instead of destroying and reconstructing it (GrowBuffers, GrowTextures, Models/pipelines — ~10 GPU objects) on every call. The hover overlay calls `updateLayer` on every hover-target change, so a hover sweep across glyphs no longer churns GPU objects per pointer event: geometry and tables are rewritten through the retained buffers/textures (growing and rebinding only on capacity overflow), and a full rebuild remains only for structural changes (a geometry-type pass appearing that the renderer was built without). Hover-out/hover-in keeps the renderer alive with empty passes. Measured on a 150-change hover sweep: 150 → 0 renderer constructions, ~3.4 ms → ~0.15 ms median per hover change.

- [#246](https://github.com/mapequation/d3gl/pull/246) [`98fbd42`](https://github.com/mapequation/d3gl/commit/98fbd42959e1e03e985cffa08d59afd4cf6bcec7) Thanks [@danieledler](https://github.com/danieledler)! - Network node-drag no longer recomputes the whole LOD tree geometry on every pointer move. When the tree is main-thread-owned (`positions` backend, worker fallback, or held-set moves on the `worker`/`gpu` backends), a drag move now folds only the held leaves into their ancestor chains — exact centroids, conservatively widened extents — in O(held · depth) instead of O(tree size), and one exact pass runs on release. The position-independent style pass (radius/weight/colour aggregation) is skipped during drags entirely, including on the `force` backend. Dragging a node on a ~1M-node map goes from ~700 ms per move to microseconds.

- [#294](https://github.com/mapequation/d3gl/pull/294) [`20f0f90`](https://github.com/mapequation/d3gl/commit/20f0f90df24e7df91e16add7b4c5c6e48ac31975) Thanks [@danieledler](https://github.com/danieledler)! - Labels no longer overprint in dense regions. `network.labels()` now measures each label's text (once
  per distinct string, never per frame) and gives it a real, centred collision box, so overlapping
  labels are rejected instead of stacking — the survivor of each cluster is the most important one
  (`importanceOf`, defaulting to the LOD tree's `weight` with LOD on and node strength with it off).

  Placement itself is now grid-backed: placed boxes go into a uniform screen grid, so each candidate is
  only tested against its neighbours. The pass is linear in the labels currently in view instead of
  quadratic, and it reuses retained buffers rather than allocating a geometry object per label per
  frame.

  New in the `labels` module: a plain (un-rotated) label can declare where its anchor sits inside the
  box — `textAnchor` (now honoured by plain labels too, not just oriented ones) and `baseline`
  (`"top" | "middle"`) — and the library derives the rendered CSS transform, the collision box and the
  native-text position from that one declaration. Also exported: `labelTransform`, `labelTextY`,
  `labelCullScratch`, `fontRowHeight` and `TextMeasurer`.

- [#249](https://github.com/mapequation/d3gl/pull/249) [`14dd25a`](https://github.com/mapequation/d3gl/commit/14dd25a3c3fc97db00d98f0f6e5a1ff4dac617a9) Thanks [@danieledler](https://github.com/danieledler)! - `network.labels()` now styles itself: a built-in default label look (dark 11px sans-serif with a white text-shadow halo) applies to the HTML overlay with zero CSS, and backend-native text (SVG `<text>` / Canvas `fillText`, incl. export) defaults to the matching `font`/`color`/`halo`. New `style` option — an inline CSS-properties object merged over the default, so a partial override like `style: { color: "#1f2937" }` keeps the rest — while `className` becomes the advanced path: providing it skips the built-in default so your class's CSS keeps full control. Styling is applied once per label element at creation, never on the per-frame placement path. `@mapequation/d3gl/labels` exports the new `LabelStyle` type, `DEFAULT_LABEL_STYLE`/`DEFAULT_LABEL_TEXT`, and the `resolveLabelStyle` policy; `LabelLayer` takes an optional `style` argument applied verbatim (a raw `LabelLayer` without it stays unstyled and inherits from its container, exactly as before).

- [#339](https://github.com/mapequation/d3gl/pull/339) [`bac68c8`](https://github.com/mapequation/d3gl/commit/bac68c872490f67105352a7e7a61464a5c3132c4) Thanks [@danieledler](https://github.com/danieledler)! - Network LOD: module boundaries ([#329](https://github.com/mapequation/d3gl/issues/329)).

  `lod({ moduleBoundary: { width, color, opacity } })` draws a thin ring around every **expanded** module in view, so a map of nested modules stays readable as you zoom into it.
  - **Where the ring goes.** After `layout({ nested })` a ring is that module's disc. It is kept as an offset from the members' centroid, so it follows them through a drag or a `transition`. After any other layout the ring is centred on the members, with their extent as its radius.
  - **The disc is the module's LOD geometry.** Once a nested layout lands, the cut treats each module of the laid-out tree as its disc, with rings on or off: the collapsed glyph sits at the disc's centre, and the module is culled by the disc and expands once the disc's diameter on screen reaches `expandPx`. Before, it used its members' centroid and extent. A nested layout's disc is about 1.1-1.3 times its members' extent, so modules open at a slightly lower zoom (measured: the same frontier at most zooms of a 12k-node map, at most 2× at a threshold zoom). If a member leaves its disc (mid-`transition`, or dragged out), the extent grows to hold it, so nothing is culled too early.
  - **One outline per module.** With `moduleBoundary` set, **collapsed** modules get the same line by default: `aggregateOutline` falls back to its `width`, `color` and `opacity` (at the usual gap outside the glyph), so a module keeps one outline whether it is collapsed or open. An explicit `aggregateOutline` still styles the collapsed ring separately, and `aggregateOutline: false` turns it off. `aggregateOutline` also gains `opacity`.
  - **Width** is in the sizeMode's units, so in `screen` mode it is a constant pixel stroke.
  - **Rendering.** Rings fade with `crossFade` and draw under every link and node. WebGL, Canvas and SVG draw them the same way, and `toSVG()`/`toPNG()` export them.
  - **Anchored module links.** With `crossLevelEdges` on and module links (`data(graph, { modules, moduleLinks })`, e.g. an Infomap `.ftree`), a link whose endpoint is an expanded module is drawn from that module's ring with its flow, instead of disappearing once the module opens. It runs ring to ring when both ends are open, and between the two centres where the circles overlap (as centroid + extent rings often do), so the link is never dropped. Links derived from graph edges are unchanged, so nothing is counted twice. A raw network's output is byte-identical.
  - **Per frame** a ring costs O(1) for each expanded module in view, which the cut visits anyway. The walk is the same with rings on or off, and there is no second pass. Anchoring adds those modules' own module links. None of it grows with the whole tree.

  New exports:
  - `CutOptions.boundaries`, where the cut collects those modules and leaves the frontier unchanged;
  - `makeCutBoundaries`;
  - `nestedBoundaryDiscs`, and a `discs` argument to `computeLODGeometry` that places each module on its disc;
  - the `CutBoundaries` (with the rings' `radius`) and `BoundaryDiscs` types.

  `LODTopology` gains the per-module link rows (`moduleLinkOffset` … `moduleLinkInFlow`).

- [#334](https://github.com/mapequation/d3gl/pull/334) [`bdc8a8e`](https://github.com/mapequation/d3gl/commit/bdc8a8e96ec55de90b004999f00bd9a13b490c4f) Thanks [@danieledler](https://github.com/danieledler)! - Network LOD: `net.lod({ modules, moduleLinks })` accepts **module-level links addressed by Infomap path** ([#199](https://github.com/mapequation/d3gl/issues/199)) and sums them into the map's super-edges, alongside those derived from the graph's edges.

  An Infomap `.ftree` stores leaf links only inside bottom modules and every coarser link only in aggregate, once per level in its `*Links` sections. Consumers previously had to invent leaf edges to get those links drawn; now they pass the rows directly (`{ source: [1, 1], target: [1, 2], flow }`), and each contributes exactly at its own level — no leaf-level edges are derived from it. Endpoints may be modules or leaves (ragged trees mix both). `buildModuleLODTree(nodeCount, records, edges?, links?)` takes the same list; the `ModuleLink` type is exported. Changing `modules` or `moduleLinks` on a later `lod()` call now rebuilds the retained module tree.

- [#292](https://github.com/mapequation/d3gl/pull/292) [`281a934`](https://github.com/mapequation/d3gl/commit/281a934036d93d94681c143b2ae8996e6f308f0d) Thanks [@danieledler](https://github.com/danieledler)! - Fix multiple pass-through layers silently clobbering each other. Declaring a second
  `passThrough: true` layer erased the first — on **both** the WebGL and Canvas backends — because
  every layer's repaint started by clearing the shared accumulation surface, and on WebGL a single
  `sizeMode` flag was overwritten by whichever layer registered last. The repaint pass is now
  cycle-scoped: it walks every pass-through layer in declaration order, clears once, and composites
  the rest on top, so N layers coexist at the memory cost of one framebuffer. `sizeMode` is now
  per-layer on WebGL, as it already was on Canvas. Single-pass-through scenes are unchanged.

- [#195](https://github.com/mapequation/d3gl/pull/195) [`6d530c8`](https://github.com/mapequation/d3gl/commit/6d530c886925902e8ac4c138a66ee21271709f2f) Thanks [@danieledler](https://github.com/danieledler)! - network: module-aware GPU layout seed (N8.2). When a module hierarchy is provided
  (`lod({ modules })` before `layout({ backend: "gpu" })`), the GPU force layout now seeds
  **top-down over the module tree** instead of a plain disc, so modules lay out as coherent
  regions. The seed traverses the tree by **depth** (deriving depth from the parent map, so
  ragged hierarchies — branches of different depths — are handled by construction), and every
  per-level step is GPU-parallel and O(level size): a golden-angle **prolongation gather** places
  each level's children around their parent, then a GPU force solve (repulsion pyramid +
  super-edge attraction + centering) refines each level over its inter-module super-edges. Levels
  larger than a bound are prolongated without a solve to keep the one-time seed cheap; the finest
  refine (real edges) polishes. Falls back to the disc seed for module-less / edge-less graphs.
  The `network` and state-network examples now default their **Backend** control to GPU.

- [#285](https://github.com/mapequation/d3gl/pull/285) [`4348439`](https://github.com/mapequation/d3gl/commit/434843939aec856d567f9e9df0da9b43596c6153) Thanks [@danieledler](https://github.com/danieledler)! - Fix nested islands-in-lakes ring topology. Ring classification was single-level, so a polygon
  with an island inside a lake (nesting depth ≥ 2) lost the island on WebGL — it became a second
  hole of the landmass, and the overlapping holes made the tessellator drop geometry. `groupRings`
  now classifies rings by the **nonzero winding rule** at arbitrary depth, the same rule Canvas
  (`ctx.fill()`) and SVG (`fill-rule: nonzero`) apply natively, so land ▸ lake ▸ island ▸ pond
  fills identically on all three backends. Hit-testing uses the same classification, so an island
  in a lake is now pickable too. Multi-ring drawables also classify ~20-80× faster (a repeated
  per-candidate area recomputation is gone, and a bounding-box test rejects non-containers before
  the ray cast).

- [#335](https://github.com/mapequation/d3gl/pull/335) [`e427e3e`](https://github.com/mapequation/d3gl/commit/e427e3e1837e279f063dcfeb5ed6628408d276a9) Thanks [@danieledler](https://github.com/danieledler)! - Network: **nested module layout** ([#324](https://github.com/mapequation/d3gl/issues/324)) — `net.layout({ backend: "worker", nested: true })` with `lod({ modules })` set lays a module tree out top-down the way the Network Navigator's map of modules does: each module's children are discs inside the module's own disc (area ∝ subtree flow, or leaf count), arranged only by their sibling links — the super-edges between them, which for an Infomap `.ftree` are exactly its `*Links` rows ([#199](https://github.com/mapequation/d3gl/issues/199)). Every module stays a compact region inside its parent, so the LOD map opens on the top modules and expands in place, and each depth is final, so the streamed layout never oscillates. Runs off-thread on `"worker"` (one frame per depth; `"gpu"` uses the worker for now) and synchronously on `"force"`; with `fit: true` the view frames the whole map from the first frame. The pure `nestedLayout(topology, options)` is exported too.

  Hits and labels on a provided module tree now carry the target's Infomap **`path`** (`NetworkHit.path`, computed on read), so `labelOf` and click handlers can name a module; module trees record each node's path entry in `LODTopology.branch`.

- [#338](https://github.com/mapequation/d3gl/pull/338) [`aa5b262`](https://github.com/mapequation/d3gl/commit/aa5b262a4803a1d56885982ec3ac3f5948446d4c) Thanks [@danieledler](https://github.com/danieledler)! - Network: **warm-started nested layout and smooth position transitions** ([#328](https://github.com/mapequation/d3gl/issues/328)). After a re-clustering (same nodes, new module hierarchy), `net.data(graph, { modules }).layout({ backend: "worker", nested: { warm: true }, transition: 600 })` refines the map the reader is looking at instead of restarting from a disc:
  - **`nested: { warm: true }`** seeds each module's children at their current centroids and starts the solve cooler, so the arrangement carries over. The new map is placed over the current one, with the same leaf centroid and spread, so it neither jumps nor drifts over repeated re-clusters. No seed disc is placed first and no per-depth frames stream. On a graph that was never laid out it is the cold layout. The pure `nestedLayout(topology, { initial })` does the same.
  - **`transition: ms`** eases every node from where it is to the new layout (cubic ease-in-out, on the main thread). The worker computes only the final layout. Each frame is a positions-only repaint that costs no more than a streamed layout frame: with LOD on it skips the style pass, and it uploads nothing extra.
    - It also eases `"positions"` and `"force"` layouts. The streaming `"worker"`/`"gpu"` force layouts ignore it.
    - `whenSettled()` resolves when it ends. A new `layout()`, `data()`, `stopLayout()` or `destroy()` stops it where it is, and grabbing a node finishes it. A node grabbed while the worker is still computing the target stays under the cursor through the ease and stays where it is dropped.
    - The camera stays put unless `fit` is set.

  The modular-map example's new **Layout** control switches between the GPU force layout and the nested layout with a warm, eased re-layout.

- [#195](https://github.com/mapequation/d3gl/pull/195) [`6d530c8`](https://github.com/mapequation/d3gl/commit/6d530c886925902e8ac4c138a66ee21271709f2f) Thanks [@danieledler](https://github.com/danieledler)! - network: `layout({ fit: true })` frames a streaming layout as it converges. For the `worker`/`gpu`
  backends the camera is fit to the layout's live bounds each streamed frame (centroid → view centre,
  extent → ~85% of the view) and released to normal zoom/pan once it settles or the user interacts.
  Without it a streaming layout renders wherever the solver centres it — the GPU solve centres the
  centroid at the origin, so it would otherwise appear at the top-left corner until it settled. The
  per-frame reframe is fling-out-robust — it frames the top modules' centroids padded by the median
  module size (O(top-level modules), not O(nodes)), so a stray flung node can't blow the frame up. The
  map-of-modules example uses it (and gains a Nodes slider, 500 → 20,000), so it opens framed and
  converges in place instead of piling at the origin and snapping into view.

  Also: swapping a network's graph (e.g. a node-count slider) no longer throws
  `flowBorder.flow length … !== nodeCount …` — `data()` now drops per-node style arrays sized to the
  previous graph, so the idiomatic `data(g).style(s)` re-render works across a resize.

- [#241](https://github.com/mapequation/d3gl/pull/241) [`ceef8be`](https://github.com/mapequation/d3gl/commit/ceef8be56267e7a1f1aff8720636c3eccd958327) Thanks [@danieledler](https://github.com/danieledler)! - network: cache the no-LOD shader-highlight group columns (per-edge source/target ids + node identity) on the position-frame style cache, so layout-streaming and drag repaint frames reuse the same array instances and skip their per-frame allocation and GPU re-upload (~24 MB/frame at 5M directed edges, ~9 MB/frame at 1M undirected). Hover/selection highlight behavior is unchanged.

- [#236](https://github.com/mapequation/d3gl/pull/236) [`82f44e1`](https://github.com/mapequation/d3gl/commit/82f44e1fcfc6140a06500a6dbea962311304f9f0) Thanks [@danieledler](https://github.com/danieledler)! - Network labels with LOD off no longer scan every node on each pan/zoom frame: on settled positions, in-view label candidates are queried from a coarse uniform grid (built at most once per position change), making the per-frame cost O(visible) instead of O(all nodes); a capped `labels({ max })` selection now uses an exact lazy top-k instead of a full sort. Placed labels are identical to before.

- [#253](https://github.com/mapequation/d3gl/pull/253) [`1211123`](https://github.com/mapequation/d3gl/commit/12111239b0388b5e7605cc532dacadebf4102b86) Thanks [@danieledler](https://github.com/danieledler)! - network: cache the no-LOD per-instance `selected` flag columns per selection version, so layout-streaming and drag position frames skip rebuilding the flags (O(nodes)+O(edges) Uint8Array churn) and skip their per-layer Float32 conversion + GPU re-upload (~80 MB/frame at 10M directed edges across lines + arrows) while the selection is unchanged. A selection change still refreshes the flags in place, and a fresh layer registration (backend switch) still seeds them.

- [#260](https://github.com/mapequation/d3gl/pull/260) [`39c1984`](https://github.com/mapequation/d3gl/commit/39c1984386ee79a210479cc3572a01df6be8346a) Thanks [@danieledler](https://github.com/danieledler)! - Test-infrastructure only, no library change: the node wall-clock perf guards now run in their own
  serial vitest group so they measure an uncontended machine. Four sessions had chased intermittent
  budget failures that turned out to be parallel-worker contention (the suite's test time inflates
  4.2× under parallelism), not regressions.

- [#261](https://github.com/mapequation/d3gl/pull/261) [`f956097`](https://github.com/mapequation/d3gl/commit/f9560972ae8ab1b4659b9acf0f93a3d8169cf299) Thanks [@danieledler](https://github.com/danieledler)! - Test-infrastructure only, no library change: the at-scale legs of the CI perf tier now assert
  instead of only printing numbers. Six benches (`BENCH_FRONTIER`, `BENCH_SUPER_EDGES`,
  `BENCH_LABEL_CANDIDATES`, `BENCH_POINTS`, `BENCH_HIT`, `BENCH_DRAG`) ran at `PERF_N=500000` in a
  blocking CI job and gated on nothing but the per-file timeout, so an at-scale regression in any of
  them would have gone unnoticed. Each now asserts its deterministic signature plus a calibrated
  wall-clock ceiling, `super-edges` gained the all-leaves frontier case it documented but never
  measured at scale, and two benches that hard-coded 1M now honour the tier's `PERF_N`.

- [#226](https://github.com/mapequation/d3gl/pull/226) [`d13bfb8`](https://github.com/mapequation/d3gl/commit/d13bfb87d1b0a3a92b32863fe7fccd9fd1823eec) Thanks [@danieledler](https://github.com/danieledler)! - The declutter points-lane `select()` no longer allocates a fresh visible-index array on every zoom/pan frame: it reuses a lazily-grown scratch buffer and returns a subarray view, removing up to ~4 MB/frame of GC churn on large (~1M) plot point layers for smoother continuous zoom. The returned visible set is now valid only until the next select — consumers reading `InstancedLane.visible` must read it fresh and copy if they need a snapshot (all in-repo consumers already do).

- [#255](https://github.com/mapequation/d3gl/pull/255) [`a4e7371`](https://github.com/mapequation/d3gl/commit/a4e737124457465f8f79b674c7df7fb06bac1eb5) Thanks [@danieledler](https://github.com/danieledler)! - Fix the GPU grid-pyramid Barnes-Hut near-field overestimate for sub-cell clumps ([#251](https://github.com/mapequation/d3gl/issues/251)). The finest-level forced accept now softens the lumped cell by its occupants' second central moment (`ε = 2σ²` — the equivalent uniform-disc law at the clump's actual extent), fed by a second-moment channel accumulated in the pyramid scatter's previously unused w component. Single-occupant cells have `σ² = 0` exactly and keep the plain point kernel; the θ-accepted far field is bit-identical to before. One-tick clump probe (100-node radius-2 clump inside one finest cell of a G=32 pyramid): GPU/CPU BH max-force ratio 5.4× → 0.48×; pyramid-vs-all-pairs field parity (2000 nodes, θ=0.5) improves from relL2 0.24 to 0.047.

- [#272](https://github.com/mapequation/d3gl/pull/272) [`8244a4b`](https://github.com/mapequation/d3gl/commit/8244a4b15d17c0e1976c16903c426ac9e4ee9276) Thanks [@danieledler](https://github.com/danieledler)! - `backend: "auto"` no longer blocks the main thread on large inputs. The Canvas2D placeholder
  installed while the WebGL device is being created used to tessellate and paint the full scene —
  on a 12,957-node / 610,954-edge network that was ~19 s of blocked main thread before the first
  WebGL frame. Content that only exists on canvas because a vector backend has no instanced lane
  (a `network()` graph, a decluttered `plot.points()` layer) is now withheld from the placeholder
  above ~10,000 elements, so the incoming WebGL backend paints the first frame instead: the same
  graph now reaches its first frame in ~0.2 s, matching `backend: "webgl"`. Smaller scenes keep the
  instant canvas first paint unchanged, and if WebGL turns out to be unavailable the engine falls
  back to canvas and draws the full detail there.

- [#239](https://github.com/mapequation/d3gl/pull/239) [`4126a60`](https://github.com/mapequation/d3gl/commit/4126a60e53e1e8031521a0361df4408a4b8b085b) Thanks [@danieledler](https://github.com/danieledler)! - network: state networks now honour `layout({ fit: true })`. A streaming (`worker` / `gpu`) state-network
  layout is framed by the **camera** as it converges — released on settle/interaction — instead of the
  internal `scaleToViewport` position-remap, so it opens framed and converges in place (no top-left flash
  or settle snap on the GPU backend, whose solver centres at the origin). Sizing is unaffected: containers
  and rosettes are scale-relative, so the physical/state/both views and pie glyphs keep their proportions.
  The `force` / `positions` backends are unchanged.

- [#336](https://github.com/mapequation/d3gl/pull/336) [`6f9822d`](https://github.com/mapequation/d3gl/commit/6f9822d9b8d472c59c097e38cc04c664703e4d97) Thanks [@danieledler](https://github.com/danieledler)! - Network LOD: super-edges now link tree nodes at **different depths** ([#325](https://github.com/mapequation/d3gl/issues/325)). In a ragged module tree, such as an Infomap map where leaves sit at depths 2–25, an edge between a deeper and a shallower endpoint was never drawn. For example, a leaf at `1:3:2:5` and a leaf at `2:1:7` stayed unlinked even at full zoom, with `crossLevelEdges` on or off. `buildSuperEdges` now also records a lift pair at each depth-equalising step, from the deeper side's node to the shallower endpoint, and exposes the per-node `depth` on `LODTopology`. The gather follows a lift pair toward a hidden neighbour only from its deeper end, so every underlying edge between two visible subtrees is drawn exactly once, on every cut. A pair toward an expanded module whose centroid has scrolled off-screen also leaves out the flow its visible members already draw (through a lift pair, a cross-level projection or an anchored module link), so zooming into a module no longer draws those edges twice. On real Infomap maps this adds 1–4% super-edge pairs (science2001 +0.9%, web-NotreDame +4.0%) and draws the 1–4% of edges that were previously lost.

- [#259](https://github.com/mapequation/d3gl/pull/259) [`a04e9f7`](https://github.com/mapequation/d3gl/commit/a04e9f73802467cf659cbd85cc13cfc6b6a4dd52) Thanks [@danieledler](https://github.com/danieledler)! - Fix `RangeError: Map maximum size exceeded` when building LOD super-edges on large networks. The
  super-edge build accumulated directed flow in a JS `Map` keyed by `a * size + b`; V8 caps a `Map` at
  2²⁴ entries, so a hierarchy with more distinct ancestor pairs than that (reached at ~500k nodes with
  1M edges — not only at 1M nodes) threw before LOD could render a single frame. It now aggregates with
  a flat typed-array counting sort, mirroring `coarsenLevel`: no hashing, no boxing, no entry ceiling.
  Also 5–10× faster and lower-memory below the old ceiling, so LOD initialisation on large graphs is
  markedly quicker.

- [#229](https://github.com/mapequation/d3gl/pull/229) [`75f74ea`](https://github.com/mapequation/d3gl/commit/75f74eaba52cbbbe58fffdbf2a1f26508a3d2d3d) Thanks [@danieledler](https://github.com/danieledler)! - Network LOD zoom/pan frames no longer allocate and zero an O(tree.size) presence array (plus fresh gather arrays and maps) on every super-edge emit. The engine now owns a reusable, generation-stamped scratch, so the per-frame super-edge cost is O(visible frontier + drawn super-edges) — at a 1M-node graph this removes ~2 MB of typed-array churn per navigation frame.

- [#268](https://github.com/mapequation/d3gl/pull/268) [`4cef98c`](https://github.com/mapequation/d3gl/commit/4cef98c0acc64ef917715584674c3664872e2e5c) Thanks [@danieledler](https://github.com/danieledler)! - Fix `toSVG()` returning an empty document on the WebGL backend. Content drawn by the GPU-instanced
  lanes — network nodes/links/arrows/half-arrows/pies, an LOD cut frontier, decluttered plot points —
  has no retained scene, so a WebGL export serialized only `<defs/><g/>`. The engine now builds a
  vector view of the lanes' current emit and hands it to the backend as an export-only stash (the same
  seam label export uses), so `toSVG()` exports the live view on every backend. Export-time only: the
  pan/zoom path is untouched. Canvas and SVG were unaffected and are unchanged.

- [#235](https://github.com/mapequation/d3gl/pull/235) [`e2b522e`](https://github.com/mapequation/d3gl/commit/e2b522ed94dcc8bf4cafe1d7bad6bd6c305438c9) Thanks [@danieledler](https://github.com/danieledler)! - Faster module-map ingestion: `buildModuleLODTree` now registers the module hierarchy with an integer-keyed prefix tree instead of interning ":"-joined path strings — at 1M nodes the build is ~2.4× faster with ~19× less transient allocation, producing identical trees.

- [#252](https://github.com/mapequation/d3gl/pull/252) [`4b24ac2`](https://github.com/mapequation/d3gl/commit/4b24ac26beef8ca9a244a261d7b388d9f83b07d0) Thanks [@danieledler](https://github.com/danieledler)! - Fix the network force layout settling into an axis-aligned square with clusters pressed into the four corners on large dense graphs ([#203](https://github.com/mapequation/d3gl/issues/203)). Two integrator fixes, applied identically on the CPU worker and GPU backends: a per-node semi-implicit spring stabilizer (`1/(1+K̃)`, `K̃ = damping·α·attraction·degree`) so high-degree hubs can no longer turn the spring integration oscillatory-unstable and eject their clusters ballistically, and an isotropic (vector-magnitude) per-tick step clamp replacing the per-axis clamp that channelled any runaway motion along ±45° into the corners of a square. Equilibrium layouts are unchanged; hub-heavy graphs now settle instead of jittering at the step clamp.

- [#244](https://github.com/mapequation/d3gl/pull/244) [`bcb7b02`](https://github.com/mapequation/d3gl/commit/bcb7b027d67d8b9d70870ea527bd7dab5747b768) Thanks [@danieledler](https://github.com/danieledler)! - Typed GroupData storage ([#207](https://github.com/mapequation/d3gl/issues/207)): the Scene's per-drawable tables (colors, flags, line widths) and vertex data now live in grow-on-append typed arrays instead of boxed `number[]`s; join/cap/miter-limit columns are omitted entirely while a whole layer uses the defaults; and path drawables no longer allocate an empty `circles` array each (1M path drawables used to allocate 1M empty arrays). `Scene.buffers()`, `Scene.styleTables()` and `Scene.appendedBuffers()` now hand out zero-copy LIVE views of that storage instead of fresh typed-array snapshots — consumers must not mutate them or retain them across drawable-set changes. Retained-Scene memory at 1M path drawables drops ~40% (990 → 589 B/drawable measured, GPU-ready form), and styles-only pushes (hover/selection restyles, the declutter fallback) stop allocating 9 bytes per drawable per call.

- [#245](https://github.com/mapequation/d3gl/pull/245) [`388eae1`](https://github.com/mapequation/d3gl/commit/388eae1b470852e6b3c96910c51479378dca9589) Thanks [@danieledler](https://github.com/danieledler)! - Type the map `LayerSpec` seam so a layer's datum type flows from registration to every
  consumer-facing callback ([#221](https://github.com/mapequation/d3gl/issues/221)). `select(name, predicate)` and `tooltip`/`hover`/`fill`/
  `stroke` no longer hand you `any`: `select` gains a datum-typed predicate overload (and a
  new datum-inferred `LayerHandle.select`), and the generic `LayerSpec<D>`/`PassThroughSpec<D>`/
  `InstancedLaneEntry<D>` bind `data: D[]` to their accessors. `GeoMap.layer` is now typed
  `F extends GeoInput` (the GeoJSON you draw). Pure types — no runtime behavior change.

- [#232](https://github.com/mapequation/d3gl/pull/232) [`33c4bb3`](https://github.com/mapequation/d3gl/commit/33c4bb3555b85496b52169ef9dd3023c3484d2bb) Thanks [@danieledler](https://github.com/danieledler)! - WebGL `toPNG()`/`toSVG()` exports now include the placed text labels, matching the Canvas/SVG backends. The WebGL backend retains the placed label set as an export-only stash (`textLayerMode: "export-only"`): `toPNG()` composites the labels onto the readback via the same 2D painter Canvas renders with, and `toSVG()` serializes them as `<text>` via the shared serializer. The live screen is unchanged — labels stay in the HTML overlay, and nothing is pushed per frame (the engine feeds the stash only at export time).

- [#265](https://github.com/mapequation/d3gl/pull/265) [`bbcabc8`](https://github.com/mapequation/d3gl/commit/bbcabc805e5812283f7ab16af5ea365ab30c88e4) Thanks [@danieledler](https://github.com/danieledler)! - Test-infrastructure only, no library change: the browser perf guards can now be driven at a real
  fixture size by the CI tier (`PERF_BROWSER_N`, via a `__PERF_N__` define and a `perfN()` helper),
  and the `perf-browser` job is no longer advisory. WebGL is the default backend but had the weakest
  gate — its guards ran at hardcoded sizes as small as 2000 drawables and their tier could not fail
  the build. The engine-level WebGL zoom sweep now runs at 100k in CI instead of 2k.

- [#275](https://github.com/mapequation/d3gl/pull/275) [`528c85f`](https://github.com/mapequation/d3gl/commit/528c85f67efe5ee9533d4a5a540549e12f1e8b8c) Thanks [@danieledler](https://github.com/danieledler)! - Pixel-verify the WebGL `toSVG()` export against the Canvas export. The instanced-lane vector
  converter behind a WebGL export was previously checked only by element counts and unit-level
  geometry, so a coordinate error in the constant-pixel `sizeMode: "screen"` bake (arrow tip setback,
  half-arrow taper/bend) could ship a plausible-looking but subtly wrong vector file. The
  backend-equivalence harness now rasterises both backends' exports and diffs them position-tolerantly
  across straight links, arrowheads (straight and bent) and half-arrows, in both size modes, at two
  zoom levels. No runtime behaviour changes.

- [#291](https://github.com/mapequation/d3gl/pull/291) [`7816d02`](https://github.com/mapequation/d3gl/commit/7816d02017678b905d0dd5356a5b682d2753a820) Thanks [@danieledler](https://github.com/danieledler)! - `arcTo` now draws a real tangent arc on every backend. `PathRecorder.arcTo` used to throw
  ("not implemented"), so a `draw` callback that rounded a corner — rounded bars, cards,
  CSS-style shapes — failed outright, while `SvgPathContext.arcTo` silently emitted two
  `lineTo`s (square corners). Both now flatten the Canvas-2D tangent arc through the shared
  `flattenArcTo`, honouring `curveTolerance`, so WebGL, Canvas, and SVG draw identical
  geometry. Degenerate inputs (zero radius, coincident or collinear points) collapse to a
  line at the corner, matching Canvas; a negative radius throws.

- [#266](https://github.com/mapequation/d3gl/pull/266) [`9fbcee0`](https://github.com/mapequation/d3gl/commit/9fbcee08671c889c6c9deec37f3f8d28f5a31bcb) Thanks [@danieledler](https://github.com/danieledler)! - Fix the view jumping on the first gesture after a programmatic `setTransform`. `enableZoom` seeds
  d3-zoom's internal transform once, at call time, so any later programmatic view change (a fit, a
  zoom-to-region, a centering translate) left the gesture measuring its delta from the stale seed —
  the camera visibly snapped back before zooming. `setTransform` now carries d3-zoom with it.
  Consumers no longer need to re-call `enableZoom()` after a programmatic fit.

## 0.9.0

### Minor Changes

- [#167](https://github.com/mapequation/d3gl/pull/167) [`7d6d271`](https://github.com/mapequation/d3gl/commit/7d6d2719ce314048141296c4e9ff391f6dd791e6) Thanks [@danieledler](https://github.com/danieledler)! - Align instanced-lane selection styling with retained layers, add shader-driven network highlight, and harden the marquee gesture ([#162](https://github.com/mapequation/d3gl/issues/162)):
  - **`selection.others` now dims non-selected glyphs on instanced lanes** (network `nodes`, a `plot` layer's decluttered `points`) — the same focus effect retained GeoMap/Plot layers had. **Default behavior change:** with a selection active, non-selected glyphs fade to `others.opacity` (default `0.3`); opt out with `selection: { others: { opacity: 1 } }`.
  - **A selected network node keeps its outgoing links at full strength** while the rest dim ("this node and what it points to"; incident links for undirected graphs; the selected aggregate's outgoing super-edges under LOD). Selection highlight is **ancestor-aware** under LOD: zooming into a selected module keeps its expanding children highlighted, while `selection()` / `on("select")` stay node-only.
  - **Hovering a network node recolours its outgoing links** toward the highlight colour (luminance-preserving, so weight-encoded links keep their cue), and **highlight colours are now red** (selection + hover rings _and_ the link recolour; the subtract-marquee "will remove" ring is yellow; the marquee +/− badge is neutral gray).
  - **The network highlight is applied in the GPU vertex shader** (per-instance `group`/`selected` columns + uniforms), so a hover/selection restyle is a uniform change — no per-frame geometry rebuild or buffer re-upload, even on a full **LOD-off** draw of a million nodes.
  - **`hover` now mirrors `selection`**: `hover: { hovered?: HighlightStyle | draw-fn, others?: StyleOverride }` — `hovered` styles the hovered item (the overlay/ring), `others` fades the rest on hover (opt-in, the hover analogue of `selection.others`). `hover: true` and a bare `HighlightStyle`/draw-fn still work (back-compat). Replaces the short-lived `hoverDimOthers`.
  - **Marquee robustness:** the shift+drag box + mode badge are one reused overlay pair, torn down on any interruption (context menu, pointer cancel, window blur, **Esc**) — fixing duplicate badges accumulating on a ctrl-click context menu mid-drag.

### Patch Changes

- [#194](https://github.com/mapequation/d3gl/pull/194) [`c22adf7`](https://github.com/mapequation/d3gl/commit/c22adf777564906bf25e8ebe52035eb4fe94add9) Thanks [@danieledler](https://github.com/danieledler)! - network: GPU force-layout backend now reheats on node-drag, at parity with the CPU worker ([#183](https://github.com/mapequation/d3gl/issues/183), N8.5). Dragging a node on `layout({ backend: "gpu" })` pins the held set (skipped by the integrate pass but still repelling/anchoring its neighbours) and reflows the rest on the GPU; the layout is kept alive after convergence instead of destroyed, and releases + re-cools on drop. Physical-view drags of a state network reheat too.

- [#176](https://github.com/mapequation/d3gl/pull/176) [`5273265`](https://github.com/mapequation/d3gl/commit/52732652992adc383dcb87c32d7e5bdf73e02bc6) Thanks [@danieledler](https://github.com/danieledler)! - network: add a GPU force-layout backend (`layout({ backend: "gpu" })`) — a WebGL2 Barnes-Hut grid-pyramid many-body solve streamed back into the existing render path, with automatic fallback to the CPU-worker backend when WebGL2 float render targets are unavailable. Milestone A of [#106](https://github.com/mapequation/d3gl/issues/106) (GPU layout).

- [#170](https://github.com/mapequation/d3gl/pull/170) [`ac1f526`](https://github.com/mapequation/d3gl/commit/ac1f526343b7b8763c7d739adc190628c974ea55) Thanks [@danieledler](https://github.com/danieledler)! - Document the engine data-entry methods: add JSDoc to `GeoMap.layer()`, `Plot.layer()`, and `Plot.points()` so they carry descriptions in the API reference and editor hovers (previously they rendered as bare, undescribed signatures).

- [#186](https://github.com/mapequation/d3gl/pull/186) [`a065bb7`](https://github.com/mapequation/d3gl/commit/a065bb713998c0b39d8fbf2ae91ea93297de8f93) Thanks [@danieledler](https://github.com/danieledler)! - Only update positions when animating a network layout ([#179](https://github.com/mapequation/d3gl/issues/179)), instead of re-deriving and re-uploading the whole graph every frame. Two changes together eliminate the per-frame bottleneck (100k nodes + 600k edges, LOD off, was ~446ms/frame):
  - **In-place GPU buffers.** `InstancedLines`, `InstancedArrows`, and `InstancedHalfArrows` gain an in-place `update()` (mirroring `InstancedCircles`): layout frames `bufferSubData` the endpoint/geometry buffers instead of destroying+recreating the GPU objects. `updateInstancedLayer` takes the in-place path for all four primitives, recreating only when a structural property changes (vertex-template `samples`, arrow `half` flag), the primitive type changes, or a layer's `pickable` state toggles.
  - **Cached style attributes.** The no-LOD full-graph path caches its style-derived attributes (link/arrow colours, widths, per-edge radii/sizes/bends) per resolved-style version. A position-only layout frame recomputes only the position-derived endpoints/node-centres and reuses the cache — so the colour/width scale accessors run O(edges) once per style version, not once per edge per frame. `data()`/`style()`/`lod()` bust the cache; a genuine data/style change fully rebuilds.
  - **Upload only what changed.** `update()` skips the `bufferSubData` of any per-instance buffer whose source array is the _same object_ as last frame (the cached colour/width/radius/bend arrays are reference-stable across position frames), so a position frame uploads only the freshly-allocated endpoint buffers — not the unchanged style buffers.

- [#190](https://github.com/mapequation/d3gl/pull/190) [`37b13f7`](https://github.com/mapequation/d3gl/commit/37b13f7cbdc77ee0e309ae683115692238416d2e) Thanks [@danieledler](https://github.com/danieledler)! - network: state networks (`stateNetwork()`) can now run their physical layout on the `worker` or `gpu` backend, not just `force` — `layout({ backend: "worker" | "gpu" })` lays out the physical graph off-thread / on the GPU and re-derives the rosette state positions from it each streamed frame, so the state/both views converge live alongside the physical layout. Tier 1 of [#182](https://github.com/mapequation/d3gl/issues/182) (rosette + GPU/worker backend); `force`/`two-phase` module-aware modes are deferred to [#189](https://github.com/mapequation/d3gl/issues/189).

- [#173](https://github.com/mapequation/d3gl/pull/173) [`03eb8df`](https://github.com/mapequation/d3gl/commit/03eb8dfb047083fd5daf23070a862bd65c00b853) Thanks [@danieledler](https://github.com/danieledler)! - Render **state (higher-order / memory) networks** with `network()` ([#171](https://github.com/mapequation/d3gl/issues/171)). `buildStateGraph({ stateCount, stateToPhysical, source, target })` assembles a state network and derives its physical network (physical nodes = distinct physical ids; links = state edges aggregated across the physical boundary, directed + flow-summed). `net.stateNetwork(graph, { modules })` ingests it and `net.view("state" | "physical")` toggles two renderings of the same data:
  - **physical** — the aggregated physical network, where a physical node whose state nodes span ≥2 modules draws as a **pie-chart glyph** (a wedge per module, sized by that module's flow, module-coloured) and a single-module node as a solid disc;
  - **state** — every state node on a golden-angle **rosette** around its physical node, coloured by module.

  The pie is a new instanced glyph (one GPU instance per wedge — an angular sector of a disc, no wedge texture or per-fragment loop; updates in place) that also traces as filled arc sectors for Canvas/SVG and `toSVG()`, rendering identically across all three backends. New helpers: `rosettePositions` (deterministic state-node placement) and `physicalPieWedges` (overlapping-module → wedge derivation, colours matching `moduleColors`). Positions in this release come from the in-library force layout of the physical graph plus the rosette (a CPU path); the module-aware GPU `stateLayout` is a separate change.

## 0.8.0

### Minor Changes

- [#150](https://github.com/mapequation/d3gl/pull/150) [`4696a20`](https://github.com/mapequation/d3gl/commit/4696a20457eb0f4f37e572d7845974284a555475) Thanks [@danieledler](https://github.com/danieledler)! - Selection API: `selectable` layer option; `select()` + gesture both fire `on("select")` ([#79](https://github.com/mapequation/d3gl/issues/79)).

  **`selectable?: boolean | { multi?: boolean }`** — new per-layer option that opts a layer into click-driven selection. `true` = single-select (plain click replaces). `{ multi: true }` = shift/cmd/ctrl-click toggles add/remove; plain click replaces. Omitting `selectable` leaves the layer un-selectable (no gesture, no click-styling) — **opt-in is preserved**.

  **One managed selection path** — the click gesture (on a `selectable` layer) and the programmatic `select(name, set|null)` both update the managed set, apply styling (`selection.selected`/`others`), and **fire `on("select")`**.

  **`on("select", (selected, ev?) => void)`** — pure observer of selection changes. `ev` is present for a gesture, `undefined` for a programmatic `select()` call. Registering it no longer enables anything (the layer's `selectable` does).

  **`on("click")`** — unchanged: fires first (before selection updates) on every pointer-up that passes the click-slop test, regardless of `selectable`.

  Migration: add `selectable: { multi: true }` (or `selectable: true`) to any layer that was previously activated by `on("select")`. The `on("select", cb)` call stays as the observer.

- [#113](https://github.com/mapequation/d3gl/pull/113) [`71dca06`](https://github.com/mapequation/d3gl/commit/71dca06a3456e42db488b369f50628670ed7613c) Thanks [@danieledler](https://github.com/danieledler)! - Add the `network()` engine for large node–link diagrams, exported from the new `@mapequation/d3gl/network` subpath.
  - **Instanced WebGL rendering**: GPU-instanced nodes (points), links (lines), and triangle arrowheads for directed edges, via a shared instanced-primitive lane in the WebGL backend.
  - **SVG/Canvas + export**: the same glyphs emit through the PathContext seam, so small networks render on the SVG/Canvas backends and `toSVG()` produces publication output.
  - **Data model**: columnar SoA + CSR graph (`buildGraph`), with per-node `degree`, `strength` (weighted degree), and optional app-provided `flow` (`buildGraph({ nodeFlow })`); a label-interning edge-list parser (`parseEdgeList`), a Pajek `.net` parser (`parsePajek`, supporting `*Vertices`/`*Arcs`/`*Edges`/`*Arcslist`/`*Edgeslist` with optional labels and coordinates), and a `parseNetwork(text, filename)` dispatcher (`.net` → Pajek, else edge list).
  - **Node sizing**: `nodeRadius` takes a constant, a per-node `Float32Array`, a `(degree, index, graph) => radius` accessor (a d3 scale fits directly, fed the node's degree), or `{ by, scale }` to size by a metric — `"degree"`, `"strength"`, `"flow"`, or a custom `(index, graph) => value` accessor — through any d3 scale. Resolved once per `style()` with no per-frame or rendering cost (radius is already a per-instance GPU attribute), so degree/flow-scaled sizing holds at millions of nodes.
  - **In-library force layout** (`layout({ backend: "force" })`): force-directed simulation with a Barnes-Hut quadtree (O(n log n)) and deterministic seeding, seeded by default via **multilevel coarsening** (heavy-edge matching) for faster convergence and fewer tangles on clustered graphs (opt out with `multilevel: false`).
  - **Off-thread layout** (`layout({ backend: "worker" })`): runs the whole solve in a Web Worker and streams positions back for **progressive on-screen convergence** while the main thread stays responsive — zero-copy via `SharedArrayBuffer` on cross-origin-isolated pages, postMessage snapshots otherwise, with a synchronous fallback where Workers are unavailable. `stopLayout()` cancels; `whenSettled()` awaits convergence.
  - **Module-free level of detail** (`lod({ … })`): an adaptive hierarchy cut over the retained multilevel-coarsening tree draws dense regions as **aggregate glyphs** that expand into their members as you zoom, with importance-ordered **declutter** of overlapping glyphs and **super-edges** summarising connectivity — so per-frame work tracks the visible frontier rather than the whole graph. The geometry tracks the layout as it converges; panning/zooming only re-runs the cheap cut. `sizeMode: "screen"` keeps glyphs a constant pixel size for navigating large layouts. Runs live every frame on WebGL and re-cuts on zoom-end on the Canvas/SVG backends (so `toSVG()` exports an LOD map — see the vector-backend LOD note).
  - **Worker-built LOD** (`lod()` before `layout({ backend: "worker" })`): the worker builds the LOD tree itself, reusing the coarsening it computes for the multilevel seed, and streams the tree once plus its aggregate geometry each frame (shared via `SharedArrayBuffer`, copied otherwise). The main thread then never coarsens or runs the per-frame O(N) geometry pass — only the on-screen-bounded cut — keeping it free as networks scale toward millions of nodes. The read-only `lodSource` getter reports which tree drives rendering (`"worker"` / `"spatial"` / `"main"` / `"none"`).
  - **Edge-less LOD** (point clouds): a graph with no edges can't be coarsened (heavy-edge matching needs edges), so LOD builds a **spatial quadtree** over the node positions instead (`buildSpatialLODTree`, exported and generic over any positions buffer). The cut then aggregates dense regions and prunes off-screen in O(visible) rather than degenerating to a flat O(N)-per-frame scan with no aggregation. Engaged automatically when `nodeCount > 0 && edgeCount === 0`; tune via `lod({ spatial: { maxDepth } })`.

- [#166](https://github.com/mapequation/d3gl/pull/166) [`18ecd4f`](https://github.com/mapequation/d3gl/commit/18ecd4f9b2e0665c732741f755c504fb5599f7d5) Thanks [@danieledler](https://github.com/danieledler)! - `network()` frontier labels ([#105](https://github.com/mapequation/d3gl/issues/105) N7b). Backfilled changeset.
  - **`net.labels({ labelOf, max })`** — HTML-overlay labels on the visible LOD frontier, importance-ranked (top-`max` by flow/size), re-placed on pan/zoom with overlap culling. Shipped in [#153](https://github.com/mapequation/d3gl/issues/153) (`ef52473`).
  - **Backend-native label text + export** — on the SVG/Canvas backends the labels render as real `<text>` / `fillText` rather than the HTML overlay, so `toSVG()` exports publication output with the labels baked in. Shipped in [#154](https://github.com/mapequation/d3gl/issues/154) (`f33b985`).

- [#166](https://github.com/mapequation/d3gl/pull/166) [`18ecd4f`](https://github.com/mapequation/d3gl/commit/18ecd4f9b2e0665c732741f755c504fb5599f7d5) Thanks [@danieledler](https://github.com/danieledler)! - `network()` pixel-exact GPU-readback link/glyph picking ([#141](https://github.com/mapequation/d3gl/issues/141)). Backfilled changeset; shipped in [#158](https://github.com/mapequation/d3gl/issues/158) (`afdcf44`).

  Opt in with **`net.pickLinks()`**: hover/click then resolve thin links / bent half-arrows / module super-edges that the CPU circle picker can't hit, via a backend pick FBO (`Backend.pickInstanced`, clean-room). A link hit is a `HoverHit` with `layer: "links"` and a `NetworkLinkHit` datum (`{ source, target, weight, aggregate }`). Nodes are drawn on top, so they win where they overlap. Off by default — a non-interactive network pays nothing.

- [#166](https://github.com/mapequation/d3gl/pull/166) [`18ecd4f`](https://github.com/mapequation/d3gl/commit/18ecd4f9b2e0665c732741f755c504fb5599f7d5) Thanks [@danieledler](https://github.com/danieledler)! - `network()` selection/hover ring + `members()` on the instanced lane ([#105](https://github.com/mapequation/d3gl/issues/105) N7c-2). Backfilled changeset; shipped in [#152](https://github.com/mapequation/d3gl/issues/152) (`96b67b2`).
  - `interactive({ selectable, hover })` draws a companion **ring overlay** on selected/hovered nodes and aggregates (instanced glyphs have no Scene drawable to recolor, so styling is a ring rather than a fill change).
  - A hit's **`members()`** enumerates the leaf node ids it covers — itself for a leaf, the whole subtree for a collapsed module — exposed on `on("hover" | "click")` hits and every `selection()` entry.

- [#144](https://github.com/mapequation/d3gl/pull/144) [`d8e8f85`](https://github.com/mapequation/d3gl/commit/d8e8f859edae3bfb56220578ae0418d26f0ea3ed) Thanks [@danieledler](https://github.com/danieledler)! - Two opt-in LOD level-transition options on `lod({ … })`, both **off by default with no added cost when unset**:
  - **`crossLevelEdges`** ([#139](https://github.com/mapequation/d3gl/issues/139)): also draw super-edges between **mixed-level** visible nodes — a visible leaf (or finer aggregate) and a visible _coarser_ aggregate at a different cut level. The off-frontier on-screen endpoint is projected to its nearest present ancestor (an `O(depth)` walk), so an aggregate keeps its links when you expand a neighbouring region instead of losing them until both sides are at the same level. Applies wherever the directed super-edge CSR exists (module and coarsening LOD trees).
  - **`crossFade`** ([#133](https://github.com/mapequation/d3gl/issues/133)): an opacity **cross-fade** across the expand threshold. Over a band whose half-width is `crossFade` × `expandPx`, an aggregate eases out (smoothstep) as its children ease in, so a split/merge reads smoothly instead of popping. The per-node alpha flows through the frontier glyphs' fill and border, the aggregate halo rings, and the super-edges (faded by their least-visible endpoint), and blends on every backend. During the fade a child **ignores its ancestor as a declutter occluder** — so a fading parent doesn't cull the children emerging behind it — while children still declutter normally against their siblings, keeping the split/merge smooth without a blank moment.

- [#144](https://github.com/mapequation/d3gl/pull/144) [`d8e8f85`](https://github.com/mapequation/d3gl/commit/d8e8f859edae3bfb56220578ae0418d26f0ea3ed) Thanks [@danieledler](https://github.com/danieledler)! - Render the network **LOD frontier on the Canvas and SVG (vector) backends**, not just WebGL — so vector backends show the same aggregate map as the instanced lane, and `toSVG()` **exports a level-of-detail network map** ([#138](https://github.com/mapequation/d3gl/issues/138)). The frontier (cut → declutter → super-edges / aggregate glyphs) is traced into retained Scene layers keyed by stable tree-node id, byte-identical to the WebGL lane. On the retained backends the cut can't re-tessellate per frame, so the frontier is static during a gesture and re-cuts on release (the redraw-on-zoom-end model); call `syncScreenGeometry()` to re-cut at a chosen zoom before a programmatic export.

- [#166](https://github.com/mapequation/d3gl/pull/166) [`18ecd4f`](https://github.com/mapequation/d3gl/commit/18ecd4f9b2e0665c732741f755c504fb5599f7d5) Thanks [@danieledler](https://github.com/danieledler)! - `network()` maps of networks ([#104](https://github.com/mapequation/d3gl/issues/104) N6) — render a network as a directed map of modules. Backfilled changeset; shipped in [#127](https://github.com/mapequation/d3gl/issues/127) (`2a1ed81`), [#129](https://github.com/mapequation/d3gl/issues/129) (`3c60fae`), [#130](https://github.com/mapequation/d3gl/issues/130) (`c0d7346`), [#131](https://github.com/mapequation/d3gl/issues/131) (`82bc507`), [#132](https://github.com/mapequation/d3gl/issues/132) (`b9d301a`), [#134](https://github.com/mapequation/d3gl/issues/134) (`150284e`), [#136](https://github.com/mapequation/d3gl/issues/136) (`7e0afd1`).
  - **Provided module hierarchy as an LOD source** — `lod({ modules })` takes an Infomap-style per-node `path` partition; modules collapse to one aggregate glyph (inheriting their module colour) and expand into sub-modules → leaves as you zoom.
  - **Flow-border nodes** — `flowBorder: { flow, scale }` rings each node by its enter/exit flow (a darker shade of the node fill by default).
  - **Bent half-arrow links** — `linkStyle: "half-arrow"` (directed): one filled shape per link that pinches toward the target, curved by `linkBend` — the map-of-networks link glyph.
  - **Directed module super-edges** — under module LOD, half-arrow super-edges between collapsed modules thicken/darken with their accumulated flow.
  - **`moduleColors()`** helper for hierarchical categorical palettes, plus the `modular-lod` and `modular-map` examples.

- [#166](https://github.com/mapequation/d3gl/pull/166) [`18ecd4f`](https://github.com/mapequation/d3gl/commit/18ecd4f9b2e0665c732741f755c504fb5599f7d5) Thanks [@danieledler](https://github.com/danieledler)! - `network()` shift+drag marquee selection ([#159](https://github.com/mapequation/d3gl/issues/159)). Backfilled changeset; shipped in [#160](https://github.com/mapequation/d3gl/issues/160) (`36d71b4`).

  On a multi-selectable lane, **shift+drag** draws a box that adds every node/aggregate whose centre falls inside it to the selection (additive, like shift+click), with a live hover-ring preview of what releasing will select. A CPU range query over the screen-bounded frontier (`pickRegion`), so it stays cheap at millions of nodes; plain drag still pans.

- [#166](https://github.com/mapequation/d3gl/pull/166) [`18ecd4f`](https://github.com/mapequation/d3gl/commit/18ecd4f9b2e0665c732741f755c504fb5599f7d5) Thanks [@danieledler](https://github.com/danieledler)! - `network()` interactive node-drag ([#140](https://github.com/mapequation/d3gl/issues/140)). Backfilled changeset; shipped in [#161](https://github.com/mapequation/d3gl/issues/161) (`b2d31cd`).
  - **`interactive({ draggable: true })`** — a plain drag starting on a node moves it instead of panning; it tracks the cursor with no lag while the layout reheats around it and re-cools on release. Grab a selected node to drag the whole selection; grab a collapsed module to drag its whole subtree. Works on the `force` and `worker` layout backends (reheat) and `positions` (translate-only). `ForceLayout.setPinned` holds the dragged set; the worker is kept alive after convergence and reheats via a pin/unpin protocol.
  - **Marquee subtract** — hold option/alt while shift+dragging to _remove_ the box's glyphs from the selection (red "will-remove" preview ring + a +/− cursor badge); the additive marquee is unchanged.
  - **Consistent selection-ring palette** — defaults are now **blue** `#2563eb` (selected), **green** `#16a34a` (hover / will-add), **red** `#dc2626` (will-remove), overridable via `selection.selected.stroke` and a `hover` HighlightStyle's `stroke`. (Changes the previous orange/white defaults.)

- [#145](https://github.com/mapequation/d3gl/pull/145) [`3311bb8`](https://github.com/mapequation/d3gl/commit/3311bb891154243130c9c8721a9fa47e62e2f6a2) Thanks [@danieledler](https://github.com/danieledler)! - Add picking to the `network()` engine ([#105](https://github.com/mapequation/d3gl/issues/105) N7a): `on("hover" | "click")` now resolve the node — or the aggregate (collapsed module) — under the cursor on the WebGL instanced lane, which the Scene hit index can't see.
  - **CPU hit-test over the LOD cut frontier**: `pick(x, y)` tests the on-screen frontier glyphs as exact circles, or the full node set when LOD is off. Cost is proportional to the _visible_ frontier (screen-bounded), never the graph size, so hover/click stay cheap at millions of nodes with no GPU readback.
  - **Unified interaction API**: uses the same `on("hover" | "click")` surface as the GeoMap/Plot engines — `network()` overrides only the resolver. On the SVG/Canvas backends, where the frontier is drawn as Scene drawables, picking already flows through the shared Scene hit index.
  - **Hit shape**: the `HoverHit`'s `id` is the tree node id (a leaf's id is its original node index; aggregate ids are `≥ leafCount`), and its `datum` is a `NetworkHit` — `{ aggregate, count }` (leaf vs collapsed module, and the leaf count it covers).

- [#164](https://github.com/mapequation/d3gl/pull/164) [`9226fe5`](https://github.com/mapequation/d3gl/commit/9226fe595945df31f532245707a4efd61c852303) Thanks [@danieledler](https://github.com/danieledler)! - Report which position transport the worker layout uses, so the `SharedArrayBuffer` zero-copy path is observable ([#163](https://github.com/mapequation/d3gl/issues/163)):
  - **`sharedMemoryAvailable()`** — new export: whether this environment can use the SAB zero-copy transport (`SharedArrayBuffer` exists and the page is cross-origin isolated via `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`). The environment's _capability_, independent of any run.
  - **`Network.layoutTransport`** (`"shared" | "copy" | "none"`) — new getter: the transport the _active_ worker layout actually selected. `"shared"` = positions stream zero-copy through a `SharedArrayBuffer`; `"copy"` = posted as per-frame snapshots (also when the worker fell back to a synchronous main-thread solve); `"none"` = no worker-backed layout running.
  - **`WorkerLayoutHandle.shared`** — new boolean on the handle returned by `startWorkerLayout`, backing the getter.

  Layout behaviour is unchanged — the SAB path already self-selected at runtime; this only makes the selection inspectable.

- [#148](https://github.com/mapequation/d3gl/pull/148) [`dfc1c30`](https://github.com/mapequation/d3gl/commit/dfc1c30e7430e9ee2bc41292b200a814a8515ea6) Thanks [@danieledler](https://github.com/danieledler)! - Decluttered `plot.points()` scatters now render through the shared instanced lane on WebGL ([#108](https://github.com/mapequation/d3gl/issues/108)-C): draw cost is proportional to the _kept_ (post-declutter) set rather than total N — index compaction instead of draw-all-then-hide — so dense decluttered scatters scale much further. The lane is used for `declutter`-enabled point layers with no `clipTo`, `hover`, or `selection` (those keep the Scene path, so `clipTo` stencil, hover-highlight, and selection restyle are unaffected); plain points, vector (SVG/Canvas) backends, and `passThrough` are unchanged. Under `backend:"auto"`, a declutter layer transparently upgrades from the Scene path to the lane once the WebGL backend is live (and downgrades back on a swap). `tooltip` works on lane layers; `append()` on a declutter layer now throws (rebuild with the full data) rather than silently mishandling the captured snapshot.

### Patch Changes

- [#147](https://github.com/mapequation/d3gl/pull/147) [`d3a4de5`](https://github.com/mapequation/d3gl/commit/d3a4de5ef991b137e9170620b378b896d7f73597) Thanks [@danieledler](https://github.com/danieledler)! - Internal: `BaseEngine` now owns the instanced-selection lane registry ([#108](https://github.com/mapequation/d3gl/issues/108)-B). `setTransform` drives every registered dynamic lane's re-select + re-emit (static lanes emit once and ride the matrix), and `pick()` resolves lanes (topmost-first) before Scene hit-indexes. `network()` registers its LOD (dynamic) and no-LOD (static) lanes via a single `syncLane()` and drops its `setTransform`/`pick` overrides + `emitInstancedLayers`. No behaviour change; this is the seam `plot.points()` will register onto ([#108](https://github.com/mapequation/d3gl/issues/108)-C).

- [#146](https://github.com/mapequation/d3gl/pull/146) [`129ca40`](https://github.com/mapequation/d3gl/commit/129ca407e090b2d0f5acfa93100823f0b80aeece) Thanks [@danieledler](https://github.com/danieledler)! - Internal: introduce `core/InstancedLane` — the shared `select(transform) → visibleIndices → emit → pick` orchestration over an instanced layer — and adopt it in the `network()` LOD frontier. No behaviour change: the cut/declutter/pick math and the glyph emit are unchanged, just routed through the lane. Removes the now-redundant `lodLayers` method and write-only `frontier` field. Groundwork for unifying picking/declutter/`plot.points()` onto one shared instanced lane ([#108](https://github.com/mapequation/d3gl/issues/108)).

- [#166](https://github.com/mapequation/d3gl/pull/166) [`18ecd4f`](https://github.com/mapequation/d3gl/commit/18ecd4f9b2e0665c732741f755c504fb5599f7d5) Thanks [@danieledler](https://github.com/danieledler)! - Fix: correct aggregate leaf-count on worker-streamed LOD trees ([#105](https://github.com/mapequation/d3gl/issues/105)). Backfilled changeset; shipped in [#156](https://github.com/mapequation/d3gl/issues/156) (`01831b3`).

  The per-aggregate leaf count (used for frontier label badges and `members()` sizing) was miscomputed on the worker-built/streamed LOD tree; it now matches the main-thread tree.

## 0.7.0

### Minor Changes

- [#59](https://github.com/mapequation/d3gl/pull/59) [`50a8506`](https://github.com/mapequation/d3gl/commit/50a8506) Thanks [@danieledler](https://github.com/danieledler)! - Collide rotated labels by their true oriented footprint. `LabelBox` / `LabelAnchor` gain
  `rotation` (radians), `textAnchor` (`start | middle | end`, like SVG), and `keepUpright`; the
  library now derives **both** the rendered CSS transform and the collision box from the same
  angle (an oriented-box / separating-axis test, with the fast axis-aligned path kept for plain
  labels). Previously rotated labels were culled by their un-rotated dimensions, so near-vertical
  labels — e.g. toward the top of a radial tree — over-excluded their angular neighbors and left
  gaps that grew with the rotation.

### Patch Changes

- [#65](https://github.com/mapequation/d3gl/pull/65) [`f170ba6`](https://github.com/mapequation/d3gl/commit/f170ba6) Thanks [@danieledler](https://github.com/danieledler)! - Share engine-level options through one `BaseEngineOptions` type. `tooltipClass`,
  `width`/`height`/`aspectRatio`, and `backend` were re-declared per engine and
  consumed in each subclass — so `plot(host, { tooltipClass })` was silently
  dropped (only `geoMap` wired it). These shared fields now live on a single
  `BaseEngineOptions` (exported) that both `GeoMapOptions` and `PlotOptions`
  extend, and the `BaseEngine` constructor consumes them once. `plot()` tooltips
  now honor `tooltipClass`, and base-level options can no longer drift between
  engines.
- [#64](https://github.com/mapequation/d3gl/pull/64) [`3c55631`](https://github.com/mapequation/d3gl/commit/3c55631) Thanks [@danieledler](https://github.com/danieledler)! - Add `h`, a tiny framework-free hyperscript helper exported from `@mapequation/d3gl/map`, for building rich tooltip / HTML-overlay content declaratively. The layer `tooltip` option accepts the returned `HTMLElement`, so `tooltip: (d) => h("div", null, [...])` replaces hand-rolled `document.createElement` ceremony. Children are always inserted as text nodes (never parsed as markup).
- [#94](https://github.com/mapequation/d3gl/pull/94) [`350f1ba`](https://github.com/mapequation/d3gl/commit/350f1ba) Thanks [@danieledler](https://github.com/danieledler)! - Make screen-space glyph `declutter` scale to very large node counts. The per-zoom cull
  ran on every transform but rebuilt transform-independent work each frame and materialized
  the full vector view twice. It now:
  - caches the anchor grouping on the Scene (built once per layer, reused every frame);
  - bins with a reused flat typed-array grid + intrusive linked list (no per-frame `Map`
    or bucket allocation), bounded to the viewport plus a one-cell margin;
  - writes visibility flags in place; and
  - skips the export-only `drawables()` rebuild on WebGL while interacting (the new optional
    `Backend.updateLayerStyles` `drawables` arg + `stylesNeedDrawables` capability — Canvas/SVG
    render from the vector view and still receive it; the settle frame refreshes it for `toSVG`).

  At 131k screen-mode nodes a full zoom frame drops from ~33ms to ~8ms; cull output is
  unchanged (verified against a brute-force reference).

  Also fixes declutter not being applied on the first draw — it now runs before the initial
  upload, not only after the first zoom/pan.

- [#96](https://github.com/mapequation/d3gl/pull/96) [`7968c2c`](https://github.com/mapequation/d3gl/commit/7968c2c) Thanks [@danieledler](https://github.com/danieledler)! - Let screen-space `declutter` act on analytic points (`Plot.points`). A lone point's anchor now
  defaults to its center, and `points()` accepts a `declutter` option, so a decluttered scatter can
  use lightweight GPU points (~4 verts each) instead of tessellated `ctx.arc` paths (tens of verts).
  This lifts a decluttered cloud from ~256k (where the path geometry OOMs a tab) to ~1M. Rendering
  and screen-mode hit-testing are unchanged (the point shader already culls by the visibility flag,
  and hit-testing already used a lone point's center as its anchor).

## 0.6.0

### Minor Changes

- [#55](https://github.com/mapequation/d3gl/pull/55) [`df49dd6`](https://github.com/mapequation/d3gl/commit/df49dd6) Thanks [@danieledler](https://github.com/danieledler)! - Make the engines responsive to their parent and resize in place. `width`/`height` are now
  optional on `plot()` / `geoMap()` (and the React `<Plot>` / `<GeoMap>`), with a new `aspectRatio`
  option. Sizing is **responsive by default**:
  - `aspectRatio` set → width-driven: fills the parent's width and keeps the ratio.
  - nothing set → fill-parent: tracks the parent box (the parent supplies the height).
  - both `width` & `height` → fixed: a static size (the previous behavior, unchanged).

  In responsive modes the engine observes its host (a `ResizeObserver`, coalesced per animation
  frame) and resizes **in place** via a new `setSize(width, height)` — no teardown, so the view
  transform, layers, hover, and selection are preserved. A resized `geoMap` also refits its
  projection to the new box (uniform resizes preserve the original framing exactly; an aspect-ratio
  change re-letterboxes via the engine's own retained geometry). The React wrappers no longer
  recreate the engine on a size change — they call `setSize` instead.

## 0.5.1

### Patch Changes

- [#52](https://github.com/mapequation/d3gl/pull/52) [`a0294c8`](https://github.com/mapequation/d3gl/commit/a0294c8) Thanks [@danieledler](https://github.com/danieledler)! - Make the declarative interaction options (`hover`, `tooltip`, `selection`) universal across
  both engines. They were only exposed on `geoMap` layers, even though the underlying machinery
  (hover overlay, tooltip, selection styling, hit-testing) already lived in the shared base —
  so `plot` layers could not declare hover/tooltip/selection. The options are now lifted into a
  shared `InteractiveLayerOptions` interface and forwarded by both `Plot.layer()`/`Plot.points()`
  and `GeoMap.layer()`, so `plot.layer(..., { hover, tooltip, selection })` and
  `plot.points(..., { hover, … })` work exactly like their `geoMap` counterparts. No change to
  existing `geoMap` behavior.

## 0.5.0

### Minor Changes

- [#51](https://github.com/mapequation/d3gl/pull/51) [`b459367`](https://github.com/mapequation/d3gl/commit/b459367) Thanks [@danieledler](https://github.com/danieledler)! - Interactive styling for retained layers: `on("click")` (drag-suppressed), hover
  highlight via per-item overlay (`hover` layer option / `highlight()`, with custom
  draw through `HighlightBuilder`), core tooltips (`tooltip` option + `tooltipClass`),
  click selection with complement dimming (`selection` option + `select()`), per-drawable
  style overrides (`setStyle`/`clearStyle`) on a new styles-only backend path
  (`updateLayerStyles`), faster `recolor()`, and clip-aware picking (`clipTo` layers no
  longer hit where they are visibly clipped away).

### Patch Changes

- [#49](https://github.com/mapequation/d3gl/pull/49) [`9b7a40f`](https://github.com/mapequation/d3gl/commit/9b7a40f) Thanks [@danieledler](https://github.com/danieledler)! - Backend swap now re-inserts the new rendering surface at the previous surface's DOM
  position instead of appending it to the end of the host. This keeps the canvas a stable
  base layer, so HTML elements the caller appended to the host after it (e.g. an overlay)
  keep painting on top across a `setBackend()` switch or the `"auto"` canvas→WebGL upgrade,
  with no `z-index` needed.

## 0.4.1

### Patch Changes

- [#39](https://github.com/mapequation/d3gl/pull/39) [`672f1fa`](https://github.com/mapequation/d3gl/commit/672f1fa) Thanks [@danieledler](https://github.com/danieledler)! - Fix layout shift in `"auto"` backend mode. Backend `<canvas>` elements are now
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
- [#43](https://github.com/mapequation/d3gl/pull/43) [`464fc3b`](https://github.com/mapequation/d3gl/commit/464fc3b) Thanks [@danieledler](https://github.com/danieledler)! - WebGL now composites overlapping fills and strokes in the same painter's order as Canvas and SVG. Previously WebGL drew all fills then all strokes, so a shape's border always landed on top of every fill — overlapping bordered shapes (e.g. node range pies) looked different on WebGL than on Canvas/SVG, where a later shape's fill correctly occludes an earlier shape's border. The three backends now match. (Internally this is one fewer draw call per layer, not a slowdown.)

  Stroke joins and caps now match across backends too: WebGL renders **miter**/**round** joins and **square**/**round** caps (previously only bevel joins + butt caps), and all three backends are pinned to the same join/cap/miter-limit (Canvas/SVG no longer use their differing defaults of 10 and 4). New layer options `lineJoin` (`"bevel"` default | `"miter"` | `"round"`), `miterLimit` (default 10), and `lineCap` (`"butt"` default | `"square"` | `"round"`) on `plot().layer()` and `geoMap().layer()` control this consistently everywhere. The default join is `"bevel"` (matching the prior WebGL look); pass `lineJoin: "miter"` for sharp corners.

  Stroke joins now emit only the outer-side geometry (the inner side is already covered by the segment quads), and a miter replaces the bevel rather than stacking on top of it. This removes redundant overlapping triangles, so translucent strokes no longer double-blend (darken) at joins — keeping WebGL close to Canvas/SVG for semi-transparent borders too.

  Also renders the raster backends at `devicePixelRatio`, so WebGL and Canvas stay crisp on HiDPI/retina displays instead of upscaling a CSS-resolution buffer.

- [#37](https://github.com/mapequation/d3gl/pull/37) [`776876c`](https://github.com/mapequation/d3gl/commit/776876c) Thanks [@danieledler](https://github.com/danieledler)! - Export `version` from the package root, inlined from `package.json` at build time.
  Downstream apps can surface the d3gl version (e.g. a "Powered by d3gl v0.4.0" badge)
  without importing `@mapequation/d3gl/package.json`:

  ```ts
  import { version } from "@mapequation/d3gl";
  console.log(`Powered by d3gl v${version}`);
  ```

- [#42](https://github.com/mapequation/d3gl/pull/42) [`456b923`](https://github.com/mapequation/d3gl/commit/456b923) Thanks [@danieledler](https://github.com/danieledler)! - Render the orthographic globe via the same per-frame CPU reprojection as Canvas/SVG instead of an equirectangular bake-to-texture. WebGL now matches Canvas/SVG output (crisp coastlines and lines, correct globe size, no "droplet" artifact when changing layers mid-globe), honors `hideOnInteraction` while rotating/zooming the globe, and shares one zoom/rotate state model across backends — fixing the inability to zoom back out after switching backends.

## 0.4.0

### Minor Changes

- [#27](https://github.com/mapequation/d3gl/pull/27) [`a03c1f8`](https://github.com/mapequation/d3gl/commit/a03c1f8) Thanks [@danieledler](https://github.com/danieledler)! - Add an opt-in `backend: "auto"` mode that paints with the Canvas backend
  synchronously for an instant first paint, then creates the WebGL device in the
  background and swaps to it transparently when ready. `whenReady()` (and the React
  `onReady`) resolve at the canvas first paint, so consumers see a working map
  immediately without paying the WebGL device-creation startup cost up front. If
  WebGL is unavailable the map stays on Canvas (with a `console.warn`). Existing
  `"webgl"` / `"canvas"` / `"svg"` behavior is unchanged.
- [#35](https://github.com/mapequation/d3gl/pull/35) [`cc33ebb`](https://github.com/mapequation/d3gl/commit/cc33ebb) Thanks [@danieledler](https://github.com/danieledler)! - Add a `passThrough: true` layer mode for huge / streaming datasets. A pass-through
  layer retains **no** per-feature geometry in d3gl (no Scene entry, no hit index):
  you own the data and d3gl projects, draws, and discards it on each repaint. This
  lifts the retained ceiling (~4–7M features, where Canvas runs out of memory and
  WebGL silently stops drawing) up to whatever your own array costs — 250M+ for a
  packed `Float32Array`.
  - Opt in via `geoMap.layer(name, features, { passThrough: true })` or
    `plot.points(name, data, { passThrough: true })`. The data argument may be a
    **callback** (`() => features`) that d3gl re-invokes on each full repaint, so it
    always reflects your current array; `handle.append(batch)` draws new arrivals
    immediately (O(new)).
  - Works for **all GeoJSON geometry** — points/multipoints (analytic circles) and
    polygons/lines (projected paths) — on **both Canvas and WebGL**. WebGL accumulates
    into an offscreen FBO with per-vertex color (no per-drawable color texture) and
    re-tessellates path geometry per repaint.
  - Pan/zoom uses snapshot-pan (a slightly stale raster during the gesture, re-crisp
    on settle); full repaints are time-sliced so a multi-million-feature redraw never
    freezes the main thread. `auto` mode upgrades Canvas→WebGL with pass-through
    layers intact.
  - Limitations: pass-through layers are not pickable, `clipTo` is not applied to
    them yet, path geometry is world-mode only, and the `svg` backend rejects
    `passThrough`. Retained rendering is unchanged for all existing layers.

## 0.3.0

### Minor Changes

- [#14](https://github.com/mapequation/d3gl/pull/14) [`925b635`](https://github.com/mapequation/d3gl/commit/925b635) Thanks [@danieledler](https://github.com/danieledler)! - GPU-accelerate orthographic-globe rotation on the WebGL backend: the map is baked
  into an equirectangular texture and drawn on a spinning 3D sphere, so rotation and
  zoom are uniform updates instead of per-frame re-projection. Activation is
  automatic (WebGL + orthographic); canvas/SVG and other projections are unchanged.
  `GeoMap.enableZoom(extent)` now auto-dispatches: versor rotation for spherical
  projections (azimuthal, `clipAngle > 0`), affine pan/zoom for flat ones.
- [#15](https://github.com/mapequation/d3gl/pull/15) [`4397a4b`](https://github.com/mapequation/d3gl/commit/4397a4b) Thanks [@danieledler](https://github.com/danieledler)! - Add incremental layer append for live-streaming data:
  - `GeoMap.layer()`, `Plot.layer()`, and `Plot.points()` now return a `LayerHandle`
    (previously the engine instance). The handle exposes `append(items)`, plus
    `recolor()` / `setClip(clipTo?)`.
  - `LayerHandle.append(features)` builds and projects only the new items and re-pushes
    only that layer — existing features are not re-projected. This makes live streaming
    (e.g. species occurrences) cheap instead of quadratic in the total point count.
  - Appended features survive `setProjection` and globe rotation (re-projected from the
    layer's accumulated data).
  - A duplicate drawable id within a layer now throws (previously it silently corrupted
    the layer's id index).

- [#12](https://github.com/mapequation/d3gl/pull/12) [`524132f`](https://github.com/mapequation/d3gl/commit/524132f) Thanks [@danieledler](https://github.com/danieledler)! - Add map projection switching and a rotatable globe:
  - `GeoMap.setProjection(projection)` re-projects existing layers against a new
    projection and resets the view.
  - `GeoMap.enableRotation(opts?)` drag-rotates a spherical projection (versor
    trackball) and wheel-scales it, re-projecting on the CPU per frame.
  - `BaseEngine.disableInteraction()` detaches the current pan/zoom or rotation.
  - `LayerOptions.hideOnInteraction` drops dense layers from the render while the
    user is interacting — a rotation drag or a zoom/pan gesture — so only cheap
    layers re-project per frame; they reappear when the gesture ends.
  - The WebGL backend now alpha-blends, so fills/strokes with alpha < 1 (e.g.
    `"#9bd1a466"`) composite correctly instead of rendering opaque.
  - On azimuthal projections (e.g. orthographic), point geometries on the back
    hemisphere are culled instead of showing through the globe.

- [#16](https://github.com/mapequation/d3gl/pull/16) [`c98087c`](https://github.com/mapequation/d3gl/commit/c98087c) Thanks [@danieledler](https://github.com/danieledler)! - Make incremental layer append O(new) on the Canvas backend (and lay the groundwork
  for WebGL):
  - `Scene.appendedBuffers(name, fromDrawable)` returns GPU-ready buffers for only the
    appended tail (group-absolute indices), and `Scene.drawables(name, from)` reads only
    the new vector views — so an append serializes O(new), not O(total).
  - New `Backend.appendToLayer(delta)` contract carrying a `RenderDelta` (delta buffers +
    new drawables). The Canvas backend implements it as **draw-on-top**: new drawables are
    drawn over the current canvas with no clear; full redraws happen only on
    transform/recolor/resize. This restores cheap live streaming on canvas.
  - Fix: appending a large batch no longer throws `RangeError` — the engine and backends
    extend their arrays with loops instead of `push(...spread)` (which exceeded the
    argument-count limit for big batches).

  WebGL still rebuilds the layer's renderer on a count change (correct, O(total) per
  batch); a true O(new) WebGL `bufferSubData` path is a follow-up.

- [#23](https://github.com/mapequation/d3gl/pull/23) [`310db91`](https://github.com/mapequation/d3gl/commit/310db91) Thanks [@danieledler](https://github.com/danieledler)! - Reduce memory for very large layers (live streaming):
  - New `pickable: false` option on `GeoMap.layer` / `Plot.layer` / `Plot.points` skips
    building the CPU hit index for that layer (no hover/pick on it) — saves one `Entry`
    object per drawable, which dominates memory for huge non-interactive layers.
  - Drawable ids are now keyed by their raw value (string or number) instead of
    `String(id)` in the scene's id map and the engine's per-layer id set, so numeric-id
    layers no longer allocate a string per drawable.

- [#24](https://github.com/mapequation/d3gl/pull/24) [`be9c7bf`](https://github.com/mapequation/d3gl/commit/be9c7bf) Thanks [@danieledler](https://github.com/danieledler)! - SVG pan/zoom is now O(1). The SVG backend keeps persistent `<defs>` / view-`<g>` /
  screen-`<g>` elements; `setTransform` updates only the view group's `transform`
  attribute instead of re-serializing the whole document every frame. This applies
  whenever no layer uses `sizeMode: "screen"` (the common case — maps, polygons,
  world points). Screen-mode content (constant-pixel circles/glyphs) still bakes the
  transform into coordinates and is re-serialized on a move, as before. `svgFromLayers`
  output is unchanged.
- [#21](https://github.com/mapequation/d3gl/pull/21) [`e111f6c`](https://github.com/mapequation/d3gl/commit/e111f6c) Thanks [@danieledler](https://github.com/danieledler)! - WebGL incremental append is now O(new) per batch. `Backend.appendToLayer` is
  implemented on the WebGL backend with capacity-doubling growable buffers
  (`bufferSubData` for the appended tail, reallocate + rebind the model only when a
  buffer overflows) and incremental color/flag texture growth, bumping the indexed
  draw count. Previously a `LayerHandle.append` on WebGL rebuilt the whole layer
  renderer each batch (O(total)), which made live streaming slow down as the layer
  grew; appends are now constant-time in the existing size.

## 0.2.0

### Minor Changes

- [#8](https://github.com/mapequation/d3gl/pull/8) [`f2bf4c5`](https://github.com/mapequation/d3gl/commit/f2bf4c5) Thanks [@danieledler](https://github.com/danieledler)! - Declarative React API and rendering fixes.
  - **react:** new `<Plot>` / `<Layer>` / `<Points>` components for declarative,
    non-geo rendering — the imperative-engine sibling of `<GeoMap>`.
  - **geo:** `GeoInput` now accepts a GeoJSON `Sphere` (`{ type: "Sphere" }`)
    directly, with no casts.
  - **svg:** the SVG backend sets a `viewBox` so it maps identically to the
    Canvas2D / WebGL2 backends when the rendered element is resized.
  - **map:** `enableZoom` gains an optional `onTransform` callback and seeds
    d3-zoom from the engine's current transform, so zoom centres correctly from a
    non-identity base view.
  - **fix:** destroying an engine mid backend-swap no longer leaves an orphaned
    canvas; re-applying a layer keeps the current view transform.
