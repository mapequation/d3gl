# @mapequation/d3gl

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
