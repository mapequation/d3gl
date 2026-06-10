# @mapequation/d3gl

## 0.4.1

### Patch Changes

- 672f1fa: Fix layout shift in `"auto"` backend mode. Backend `<canvas>` elements are now
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
- 464fc3b: WebGL now composites overlapping fills and strokes in the same painter's order as Canvas and SVG. Previously WebGL drew all fills then all strokes, so a shape's border always landed on top of every fill — overlapping bordered shapes (e.g. node range pies) looked different on WebGL than on Canvas/SVG, where a later shape's fill correctly occludes an earlier shape's border. The three backends now match. (Internally this is one fewer draw call per layer, not a slowdown.)

  Stroke joins and caps now match across backends too: WebGL renders **miter**/**round** joins and **square**/**round** caps (previously only bevel joins + butt caps), and all three backends are pinned to the same join/cap/miter-limit (Canvas/SVG no longer use their differing defaults of 10 and 4). New layer options `lineJoin` (`"bevel"` default | `"miter"` | `"round"`), `miterLimit` (default 10), and `lineCap` (`"butt"` default | `"square"` | `"round"`) on `plot().layer()` and `geoMap().layer()` control this consistently everywhere. The default join is `"bevel"` (matching the prior WebGL look); pass `lineJoin: "miter"` for sharp corners.

  Stroke joins now emit only the outer-side geometry (the inner side is already covered by the segment quads), and a miter replaces the bevel rather than stacking on top of it. This removes redundant overlapping triangles, so translucent strokes no longer double-blend (darken) at joins — keeping WebGL close to Canvas/SVG for semi-transparent borders too.

  Also renders the raster backends at `devicePixelRatio`, so WebGL and Canvas stay crisp on HiDPI/retina displays instead of upscaling a CSS-resolution buffer.

- 776876c: Export `version` from the package root, inlined from `package.json` at build time.
  Downstream apps can surface the d3gl version (e.g. a "Powered by d3gl v0.4.0" badge)
  without importing `@mapequation/d3gl/package.json`:

  ```ts
  import { version } from "@mapequation/d3gl";
  console.log(`Powered by d3gl v${version}`);
  ```

- 456b923: Render the orthographic globe via the same per-frame CPU reprojection as Canvas/SVG instead of an equirectangular bake-to-texture. WebGL now matches Canvas/SVG output (crisp coastlines and lines, correct globe size, no "droplet" artifact when changing layers mid-globe), honors `hideOnInteraction` while rotating/zooming the globe, and shares one zoom/rotate state model across backends — fixing the inability to zoom back out after switching backends.

## 0.4.0

### Minor Changes

- a03c1f8: Add an opt-in `backend: "auto"` mode that paints with the Canvas backend
  synchronously for an instant first paint, then creates the WebGL device in the
  background and swaps to it transparently when ready. `whenReady()` (and the React
  `onReady`) resolve at the canvas first paint, so consumers see a working map
  immediately without paying the WebGL device-creation startup cost up front. If
  WebGL is unavailable the map stays on Canvas (with a `console.warn`). Existing
  `"webgl"` / `"canvas"` / `"svg"` behavior is unchanged.
- cc33ebb: Add a `passThrough: true` layer mode for huge / streaming datasets. A pass-through
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

- 925b635: GPU-accelerate orthographic-globe rotation on the WebGL backend: the map is baked
  into an equirectangular texture and drawn on a spinning 3D sphere, so rotation and
  zoom are uniform updates instead of per-frame re-projection. Activation is
  automatic (WebGL + orthographic); canvas/SVG and other projections are unchanged.
  `GeoMap.enableZoom(extent)` now auto-dispatches: versor rotation for spherical
  projections (azimuthal, `clipAngle > 0`), affine pan/zoom for flat ones.
- 4397a4b: Add incremental layer append for live-streaming data:
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

- 524132f: Add map projection switching and a rotatable globe:
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

- c98087c: Make incremental layer append O(new) on the Canvas backend (and lay the groundwork
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

- 310db91: Reduce memory for very large layers (live streaming):
  - New `pickable: false` option on `GeoMap.layer` / `Plot.layer` / `Plot.points` skips
    building the CPU hit index for that layer (no hover/pick on it) — saves one `Entry`
    object per drawable, which dominates memory for huge non-interactive layers.
  - Drawable ids are now keyed by their raw value (string or number) instead of
    `String(id)` in the scene's id map and the engine's per-layer id set, so numeric-id
    layers no longer allocate a string per drawable.

- be9c7bf: SVG pan/zoom is now O(1). The SVG backend keeps persistent `<defs>` / view-`<g>` /
  screen-`<g>` elements; `setTransform` updates only the view group's `transform`
  attribute instead of re-serializing the whole document every frame. This applies
  whenever no layer uses `sizeMode: "screen"` (the common case — maps, polygons,
  world points). Screen-mode content (constant-pixel circles/glyphs) still bakes the
  transform into coordinates and is re-serialized on a move, as before. `svgFromLayers`
  output is unchanged.
- e111f6c: WebGL incremental append is now O(new) per batch. `Backend.appendToLayer` is
  implemented on the WebGL backend with capacity-doubling growable buffers
  (`bufferSubData` for the appended tail, reallocate + rebind the model only when a
  buffer overflows) and incremental color/flag texture growth, bumping the indexed
  draw count. Previously a `LayerHandle.append` on WebGL rebuilt the whole layer
  renderer each batch (O(total)), which made live streaming slow down as the layer
  grew; appends are now constant-time in the existing size.

## 0.2.0

### Minor Changes

- f2bf4c5: Declarative React API and rendering fixes.
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
