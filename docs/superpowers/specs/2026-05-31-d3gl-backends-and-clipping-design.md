# d3gl — backend-switchable rendering, cross-backend clipping, and a high-level map API

**Date:** 2026-05-31
**Status:** Design approved, pending spec review

## Summary

This builds on the shipped d3gl foundation (core scene/drawable model, WebGL2
backend, geo project-once, React wrapper, SVG/Canvas path contexts). It adds three
things the first real consumer (Infomap Bioregions) needs:

1. **A backend-agnostic renderer abstraction.** Today only WebGL is a real
   interactive Scene renderer; `@d3gl/canvas` and `@d3gl/svg` are low-level
   `PathContext` seams (and a static SVG-string assembler). We introduce a common
   `Backend` interface implemented by **WebGL, Canvas, and SVG**, all consuming the
   same `Scene` + `ViewTransform`. The live, interactive map (zoom/pan/hover) works
   on **all three**; the user switches backend with one setting.

2. **True clip-to-shape, across all backends.** The current example clips by cell
   centroid (whole cells in/out). Real clipping masks **at the pixel** so cells
   straddling a coastline are partially clipped — the semantics of `ctx.clip()` /
   SVG `<clipPath>`. WebGL uses the **stencil buffer**, the GPU-native equivalent.

3. **A d3-familiar high-level API.** A new `@d3gl/map` package exposes `geoMap()`:
   declare GeoJSON layers with d3-style accessors, switch backend, clip layers,
   pan/zoom, hover, and export — without touching backend specifics. The existing
   low-level seams (`SvgPathContext`, `CanvasContext`, `GroupRenderer`) stay exposed.

The example is rewritten to exercise all of it and to render **every GeoJSON
geometry type**: `Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`,
`MultiPolygon`.

## Tech stack

TypeScript, pnpm monorepo (existing). luma.gl v9.3 (WebGL2). d3-geo, d3-scale,
d3-scale-chromatic. React 19. Vitest 4 (Node + Playwright browser mode). No new
heavyweight runtime deps; `topojson-client` + `world-atlas` already added for the
example.

## Motivation

- **Clipping fidelity.** Bioregions clips grid/overlay data to land borders. v1 used
  SVG `clip-path="url(#land)"`; v2 used Canvas `ctx.clip()`. Centroid filtering is a
  visibly wrong approximation at coastlines. We need real masking on the default
  (GPU) view too.
- **Backend parity.** Publication export (SVG/PNG) and the live view should be the
  same scene viewed through different backends, not separate code paths. Users pick
  the backend for their constraints (crisp vector vs. raster vs. GPU throughput).
- **Ergonomics.** Driving the Scene/GroupRenderer directly is verbose. d3 users
  expect `map.layer(geojson, { fill: d => scale(d.value) })`.

## Design decisions (approved)

- **API shape:** imperative core engine (`geoMap()`) usable anywhere, with a thin
  React `<GeoMap>` façade on top.
- **Interactive parity:** all three backends (WebGL, Canvas, SVG) support the full
  interactive map. WebGL is the performant default; SVG is documented as slow at
  large cell counts.
- **Scope:** one spec covering all of the above plus the all-geometry example.
- **Package:** the high-level engine lives in a new `@d3gl/map` package (not core).
- **Risk-first:** a luma stencil-clip spike is the first build task.

## Core model changes (`@d3gl/core`)

### Scene retains vector paths

Today `Scene` records drawables via `PathRecorder` (subpaths), tessellates them, and
`buffers(name)` returns only GPU triangle data. Vector backends (Canvas/SVG) and the
quadtree hit-test need the **subpaths**, not triangles.

Change: `Scene` retains, per drawable, the recorded `Subpath[]` alongside the
existing tessellated arrays. New accessor:

```ts
interface DrawableVector {
  id: string | number;
  subpaths: Subpath[];      // flattened polylines (curves/arcs already flattened)
  fill: [number, number, number, number];   // RGBA bytes
  stroke: [number, number, number, number];
  lineWidth: number;
  flags: number;            // bit 0 = visible
}
// New:
scene.drawables(name: string): DrawableVector[];   // vector view (Canvas/SVG/hit-test)
scene.buffers(name: string): GroupBuffers;         // unchanged (WebGL)
```

`Subpath` is the existing `{ points: number[]; closed: boolean }` already exported
from core. Storing subpaths roughly doubles per-drawable memory; acceptable at
target scales and documented.

### The `Backend` interface

```ts
export interface RenderLayer {
  name: string;
  buffers: GroupBuffers;          // for raster/GPU
  drawables: DrawableVector[];    // for vector backends
  clipTo?: string;                // name of another layer whose silhouette clips this one
}

export interface Backend {
  /** Replace the full layer set (geometry changed). */
  setLayers(layers: RenderLayer[]): void;
  /** Recolor / show-hide without geometry rebuild. */
  updateLayer(name: string, layer: RenderLayer): void;
  /** Pan/zoom. */
  setTransform(t: ViewTransform): void;
  /** Draw everything in layer order. */
  render(): void;
  /** PNG data URL (raster backends rasterize; SVG backend may rasterize via canvas). */
  toPNG(): string;
  /** SVG document string (all backends can serialize the scene to SVG). */
  toSVG(): string;
  destroy(): void;
}
```

`ViewTransform` (`{ k, x, y }`) and `clipFromView` stay in `@d3gl/webgl` and are
re-exported where needed; the matrix math is backend-internal. Layers render in array
order (painter's order). `clipTo` names an earlier layer; the backend masks the
clipped layer to that layer's filled silhouette.

Picking is **not** on the `Backend` — see Interaction.

## Backends

### CanvasBackend (`@d3gl/canvas`)

Immediate-mode replay of `DrawableVector` subpaths into a `CanvasRenderingContext2D`:

- Per render: clear; `ctx.setTransform(k,0,0,k,x,y)` for pan/zoom; for each layer, for
  each visible drawable, trace subpaths (`moveTo`/`lineTo`, `closePath` per closed
  subpath), then `fill()` and/or `stroke()` with the drawable's colors.
- **Clip:** for a layer with `clipTo`, `ctx.save()`, trace the clip layer's silhouette,
  `ctx.clip()`, draw the layer, `ctx.restore()`.
- `toPNG()`: `canvas.toDataURL("image/png")`. `toSVG()`: delegate to the SVG
  serializer over the same drawables.

Reuses `CanvasContext` for the tracing primitives where practical; the backend owns the
scene-replay/transform/clip loop.

### SvgBackend (`@d3gl/svg`)

Builds and patches a live DOM `<svg>`:

- One `<path>` per drawable (or per layer via a single `d`), grouped in a `<g>` per
  layer. Pan/zoom = `transform="translate(x,y) scale(k)"` on the root `<g>`.
- **Clip:** a `<clipPath id="…">` referencing the clip layer's path; the clipped layer's
  `<g>` gets `clip-path="url(#…)"`. This is exactly bioregions v1.
- Recolor/show-hide patches `fill`/`stroke`/`display` attributes in place.
- `toSVG()`: serialize the live DOM (or rebuild via `svgDocument`). `toPNG()`: draw the
  serialized SVG onto an offscreen canvas and export, or document as unsupported and
  route PNG through a raster backend (decision: rasterize via canvas for parity).
- Style strings are interpolated verbatim (existing `svgDocument` contract) — trusted
  CSS only.

### WebGLBackend (`@d3gl/webgl`)

Wraps the existing `GroupRenderer` (one per layer) and adds stencil clipping:

- Framebuffers (onscreen canvas context + offscreen) gain a **depth-stencil
  attachment**. Per render pass, stencil clears to 0.
- For a `clipTo` layer: first draw the clip layer's fill geometry with **color writes
  off**, stencil compare `always`, pass op `replace`, reference `1` → stencil = 1 under
  the mask. Then draw the clipped layer with stencil compare `equal`, reference `1`, no
  stencil write → only fragments inside the mask survive. Unclipped layers draw with the
  stencil test disabled.
- Exact luma v9.3 API (Model `parameters` stencil fields, `RenderPass.setStencilReference`,
  framebuffer stencil format) is confirmed by the **spike (Task 0)**. Fallback if the
  stencil path is impractical: render the mask to an `r8unorm` texture and `discard` in
  the clipped layer's fragment shader (reuses existing framebuffer/texture machinery,
  allows antialiased edges).
- `toPNG()` keeps the existing framebuffer readback. `toSVG()` delegates to the SVG
  serializer over the layers' drawables (vector export from the GPU view).

## Clipping summary

| Backend | Mask mechanism |
|---|---|
| SVG     | `<clipPath>` + `clip-path="url(#…)"` |
| Canvas  | `ctx.clip()` within `save`/`restore` |
| WebGL   | stencil buffer mask pass (fallback: mask texture + `discard`) |

Clipping is general: `clipTo: <layerName>` clips a layer to the filled silhouette of any
other layer; land is the common case. The clip shape comes from the clip layer's
subpaths (vector backends) and its fill triangles (WebGL stencil).

## Interaction (backend-independent)

- **Transform / zoom:** unchanged `{ k, x, y }` `ViewTransform`; the consumer wires
  d3-zoom and passes the transform to the engine. Project-once is unchanged.
- **Hover / pick:** a **CPU quadtree** over projected drawable bounds + point-in-ring
  test, built from `scene.drawables()` and queried in screen space via the inverse of
  the current transform. Backend-independent: identical hover on WebGL/Canvas/SVG.
  WebGL retains GPU color-picking as an optional fast path, but the quadtree is the
  unified hit-test. Lives in `@d3gl/core` (geometry) with a thin geo entry point.
  Respects layer visibility and `clipTo` (a hover over a clipped-away pixel misses).

## High-level engine (`@d3gl/map`, new package)

```ts
export interface GeoMapOptions {
  width: number;
  height: number;
  projection: GeoProjection;
  backend?: "webgl" | "canvas" | "svg";   // default "webgl"
}

export interface LayerOptions<F> {
  fill?: string | ((f: F, i: number) => string);
  stroke?: string | ((f: F, i: number) => string);
  lineWidth?: number;
  pointRadius?: number;                    // for Point/MultiPoint
  clipTo?: string;                          // name of another layer
  id?: (f: F, i: number) => string | number;
}

export interface GeoMap {
  layer<F extends GeoJSON.GeoJSON>(name: string, features: F | readonly F[], opts?: LayerOptions<F>): GeoMap;
  removeLayer(name: string): GeoMap;
  recolor(name: string): GeoMap;          // re-run accessors, texture-write update
  setBackend(b: "webgl" | "canvas" | "svg"): GeoMap;
  setTransform(t: ViewTransform): GeoMap;
  enableZoom(extent?: [number, number]): GeoMap;
  on(event: "hover" | "click", cb: (hit: { layer: string; feature: unknown; id: string | number } | null, ev: PointerEvent) => void): GeoMap;
  render(): GeoMap;
  toSVG(): string;
  toPNG(): string;
  destroy(): void;
}

export function geoMap(el: HTMLElement, opts: GeoMapOptions): GeoMap;
```

Responsibilities:
- Owns a `Scene`, the projection (project-once via `featureGroup`/new point+line
  helpers), the active `Backend`, and the quadtree.
- `layer()` accepts a single feature, an array, or a FeatureCollection; normalizes to
  features; projects once; registers a Scene group; applies fill/stroke accessors.
  Handles all six geometry types (Point/MultiPoint as filled dots via closed arcs;
  Line/MultiLine as stroke-only; Polygon/MultiPolygon as fill+optional stroke).
- `setBackend()` tears down the old backend, constructs the new one against a freshly
  (re)attached canvas/SVG element in `el`, re-applies layers + transform, renders.
- `enableZoom()` attaches d3-zoom to `el` and feeds `setTransform`.
- `on("hover")` uses the quadtree; emits the matched feature + layer + id.

### Geo helpers (`@d3gl/geo`)

Extend beyond `featureGroup`:
- `pointGroup(points, projection, { radius })` — closed-arc dots (the example's
  `cityMarkers`, promoted and generalized to Point + MultiPoint).
- `lineGroup(lines, projection, { lineWidth })` — stroke-only groups for LineString /
  MultiLineString (incl. `d3.geoGraticule()` output).
- A geometry-type dispatcher used by `geoMap.layer()` so a single call handles any
  GeoJSON geometry.

## React wrapper (`@d3gl/react`)

- `<GeoMap>` props: `width`, `height`, `projection`, `backend`, `transform`, `onHover`,
  `onReady(map)`. Children or a `layers` prop declare layers.
- Implemented as a thin hook over `geoMap()`: create on mount, push prop changes
  (backend/transform/layers) without rebuilding geometry, destroy on unmount.
- The existing `D3GL`/`MapController` stay for the low-level WebGL-only path
  (back-compat), with `<GeoMap>` as the recommended entry point.

## Export

- `toPNG()`: WebGL → framebuffer readback (existing); Canvas → `toDataURL`; SVG →
  rasterize the serialized SVG via an offscreen canvas (parity across backends).
- `toSVG()`: all backends serialize the layer drawables to an SVG document (reusing
  `svgDocument`), including `<clipPath>` for clipped layers.

## Example (`examples/bioregions`)

Rewritten to use `geoMap()` via `<GeoMap>`:
- Controls: **backend switcher** (WebGL/Canvas/SVG), **clip-to-land** toggle (real
  masking), heatmap/bioregion toggle, **Export PNG/SVG**.
- Interaction: scroll-zoom, drag-pan, hover tooltip — working under all three backends.
- Layers covering every geometry type:
  - `Polygon` — grid cells.
  - `MultiPolygon` — land (world-atlas 110m), used as the clip silhouette.
  - `MultiLineString` — `d3.geoGraticule()` lat/long grid.
  - `LineString` — a great-circle route between two cities.
  - `Point` — individual city markers.
  - `MultiPoint` — a clustered set of locations as one feature.

## Package structure & dependencies

```
core   ← canvas, svg, webgl            (each implements Backend; core defines it)
core,webgl ← geo                       (project-once, helpers)
core,canvas,svg,webgl,geo ← map        (geoMap engine; new)
map ← react                            (<GeoMap>)
```

New package: `@d3gl/map`. New backends added to existing `@d3gl/canvas`,
`@d3gl/svg`, `@d3gl/webgl`. New helpers in `@d3gl/geo`. New quadtree in `@d3gl/core`.

## Testing strategy

- **Core:** Scene vector retention (`drawables()` returns flattened subpaths matching
  recorded paths); quadtree hit-test (point-in-ring, bounds, miss). Node + Vitest.
- **Backends (browser, Playwright):** each backend renders a known 2-color scene to the
  expected pixels; clip masks correctly (a cell straddling the clip boundary is
  partially filled — sample pixels inside vs. outside the mask). For SVG, assert DOM
  structure (`<clipPath>`, per-layer `<g>`, transform) and rasterized pixels.
- **Cross-backend parity:** the same scene + transform produces visually equivalent
  output across backends within tolerance (sample-point comparison).
- **Engine:** `geoMap.layer()` handles each geometry type; `setBackend()` preserves
  layers/transform; `recolor()` is a texture-write (no geometry rebuild); hover returns
  the right feature.
- **Stencil spike (Task 0):** a standalone browser test proving luma stencil clip
  before the WebGLBackend depends on it.
- **Example:** headless screenshots per backend × clip on/off (the existing
  verification approach).

## Performance & trade-offs

- **SVG interactive at scale:** thousands of cells as DOM nodes pan/zoom slowly. It
  works (parity is a requirement) and is ideal for export/small data; WebGL stays the
  default live backend. Documented, not hidden.
- **Scene memory:** retaining vector subpaths + tessellated buffers ~doubles
  per-drawable storage. Fine at target scales.
- **WebGL clip cost:** one extra mask draw per frame (the clip layer is ~one drawable)
  plus a near-free stencil test. Follows pan/zoom via the same transform uniform.
- **Recolor stays cheap:** texture write on WebGL, attribute patch on SVG, full redraw
  on Canvas (Canvas has no cheap recolor — documented).

## Risks

- **luma stencil API (primary):** retired by the Task 0 spike; mask-texture fallback
  defined.
- **Canvas/SVG transform vs. project-once:** the view transform must compose with
  projected pixel coordinates identically to the WebGL `clipFromView` matrix; covered by
  cross-backend parity tests.
- **SVG `toPNG` rasterization** (tainted-canvas / async image load): if it proves
  unreliable headless, PNG export from the SVG backend documents routing through a raster
  backend; `toSVG` is always available.

## Out of scope (future)

- WebGPU backend (the abstraction is designed to admit it).
- Phylogenetic trees / `d3-hierarchy` layers and HTML label sync.
- Globe/orthographic interaction.
- Soft/feathered clip edges (mask-texture enables this later).
- Canvas incremental/dirty-rect redraw.
