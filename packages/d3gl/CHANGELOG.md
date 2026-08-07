# @mapequation/d3gl

## 0.9.1

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
