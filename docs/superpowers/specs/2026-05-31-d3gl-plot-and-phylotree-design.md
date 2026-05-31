# d3gl — generic `plot()` engine + phylogenetic tree example

**Date:** 2026-05-31
**Status:** Design approved, building

## Summary

Adds a **non-geo, d3-familiar rendering engine** to d3gl and a **phylogenetic tree
example** built on it. The engine, `plot()`, is a sibling of `geoMap()` that shares all the
backend/transform/zoom/hover/clip/export machinery but whose layers take a **draw
function** `(ctx, datum, i) => void` instead of GeoJSON — exactly how d3's shape/line
generators emit to a context. This realizes the polymorphic-context vision for arbitrary
charts (trees now; chord/arc/area later) and lets `geoMap` become a thin geo specialization
of the same base.

The example renders a generated phylogenetic tree with **switchable rectangular ⇄ radial**
layouts and a **size slider** (small→thousands of tips), GPU-accelerated, with tip labels,
backend switching, pan/zoom, and hover — the long-intended replacement for
`@phylocanvas/phylocanvas.gl`.

## Motivation

Trees are the second target after maps. They are pure geometry — links (lines) + nodes
(dots) + tip labels — with no projection. Today the only high-level engine (`geoMap`) is
geo-specific. A generic draw-based engine unlocks trees and any other d3 chart while reusing
the proven backend/interaction layer. Layout stays in **d3-hierarchy**, which d3 users
already know.

## Tech stack

TypeScript, d3-hierarchy (layout), `@d3gl/map` (engine), `@d3gl/labels` (culled HTML tip
labels), the three backends. Vitest browser. No new heavy deps.

## Design decisions (approved)

- Both **rectangular** and **radial** tree layouts, switchable.
- Tree **size slider** (small fully-labeled → large GPU-stress).
- API must feel familiar to d3 users → layers take a draw-into-context function.

## Library: the `plot()` engine (`@d3gl/map`)

Refactor: extract the shared engine machinery from `GeoMap` into a base class
`BaseEngine` (private/protected): owns the `Scene`, ordered layer specs, per-layer
`HitIndex`, `ViewTransform`, the active backend (via `createBackend`, async + `whenReady`),
and implements `setBackend`, `setTransform`, `enableZoom`, `on("hover")`, `pick`, `recolor`,
`setClip`, `render`, `toSVG`, `toPNG`, `destroy`. The base exposes a protected
`registerLayer(name, data, opts, buildGroup)` that builds the Scene group via a supplied
builder, applies fill/stroke accessors, indexes for hit-testing, and pushes to the backend.

Two thin public engines extend the base:

```ts
// Generic, draw-into-context layers (NEW).
export interface PlotLayerOptions<D = any> {
  draw: (ctx: PathContext, datum: D, index: number) => void;
  fill?: string | ((d: D, i: number) => string);
  stroke?: string | ((d: D, i: number) => string);
  lineWidth?: number;
  id?: (d: D, i: number) => string | number;
  clipTo?: string;
}
export interface Plot {
  layer<D>(name: string, data: readonly D[], opts: PlotLayerOptions<D>): Plot;
  // ...plus the shared surface: setBackend, setTransform, enableZoom, on, recolor,
  // setClip, render, toSVG, toPNG, pick, whenReady, destroy
}
export function plot(el: HTMLElement, opts: { width: number; height: number; backend?: BackendType }): Plot;
```

`plot().layer` builds its Scene group by calling `g.drawable(id(d,i), (ctx) => opts.draw(ctx, d, i), { lineWidth })` for each datum — the draw function speaks the existing `PathContext` (moveTo/lineTo/bezierCurveTo/arc/closePath), so it renders identically on WebGL/Canvas/SVG.

`GeoMap` is reimplemented on the same base: its `layer(name, features, opts)` calls
`registerLayer` with `buildGroup = geoLayer(features, projection, …)`. **GeoMap's public API
and behavior are unchanged** (guarded by existing tests + the bioregions example).

Coordinates in `plot()` are world/screen units (no projection); the `ViewTransform` (`k,
x, y`) applies on top, identical to geo. Hit-test inverts the transform the same way.

### Optional engine addition: `onTransform`

`enableZoom` updates the transform internally. For label sync the example wires d3-zoom
itself and calls `setTransform` + `LabelLayer.update`, so no engine change is strictly
required. (We will NOT add `onTransform` unless the example proves it necessary — YAGNI.)

## Example: `examples/phylotree`

A Vite + React app (mirrors `examples/bioregions` structure).

### Layout (d3-hierarchy — the user's familiar tool)
- Generate a synthetic tree: a recursive random bifurcating tree with random branch lengths
  and a tip count driven by the slider (e.g. 64 → 4096 tips). Each tip gets a label and a
  categorical group (for coloring).
- `d3.hierarchy(root, d => d.children)`; `d3.cluster().size([span, 1])` for even tip spacing.
- **Rectangular phylogram:** cross-axis position from cluster; main-axis position from
  cumulative branch length (root-to-node distance) scaled to width. Links = elbow connectors
  (right-angle step).
- **Radial:** map (cross-axis → angle θ ∈ [0, 2π), distance → radius r) to Cartesian
  `(cx + r cos θ, cy + r sin θ)`. Links = radial step (arc segment at parent radius + radial
  line) approximated by short polylines.

### Rendering (via `plot()`)
- `links` layer: `draw` traces each link's connector into the context; `stroke` by group or
  uniform; thin `lineWidth`.
- `nodes` layer: `draw` traces a small filled dot per node; `fill` by group; optional —
  internal nodes smaller/omitted at scale.
- Layout toggle re-runs the layout and re-adds the two layers (geometry change → re-tessellate
  is acceptable on an explicit toggle/slider change).

### Labels (`@d3gl/labels`)
- A `LabelLayer` over the canvas; anchors = tip nodes (`refX/refY` = world coords, `text` =
  tip name, `priority` by branch length so prominent tips win). On every transform change the
  example calls `labelLayer.update(anchors, transform, viewport)` — culling shows only
  visible, non-overlapping labels (LOD), which is what makes thousands of tips tractable.

### Interaction & controls
- Manual d3-zoom on the wrapper → `plot.setTransform(t)` + `labelLayer.update(...)` (manual
  so labels stay in sync).
- Hover → `plot.on("hover")` (or `plot.pick`) → tooltip with the node's name/branch length.
- Controls: **layout** (rectangular/radial), **backend** (webgl/canvas/svg), **tip-count
  slider**, color toggle, Export PNG/SVG.

## Package structure & dependencies

- `@d3gl/map`: add `plot()`, `Plot`, `PlotLayerOptions`; internal `BaseEngine`. `GeoMap`
  reimplemented on `BaseEngine` (no API change).
- New `examples/phylotree`: deps `@d3gl/map`, `@d3gl/labels`, `@d3gl/react` (optional — may
  use `plot()` directly without `<GeoMap>`, or add a `<Plot>` wrapper later), `d3-hierarchy`,
  `d3-scale-chromatic`, `d3-selection`, `d3-zoom`, React. Vite alias for the workspace pkgs.
- No `@d3gl/labels` API change expected; `LabelLayer` is consumed as-is.

## Testing strategy

- **Engine refactor:** existing `geoMap`/`set-clip`/`backend-factory` browser tests must stay
  green (proves GeoMap behavior preserved). New `plot.browser.test.ts`: a draw-based layer
  renders + recolors + hit-tests + switches backend (mirrors the geoMap engine test).
- **Layout helpers (Node):** rectangular and radial layout functions produce finite
  coordinates, leaves ordered, root at expected position; link connectors have ≥2 points.
- **Example:** `typecheck` + `build` clean; controller verifies via headless screenshots
  (rectangular & radial × a backend; labels present; no console errors).

## Performance & trade-offs

- Links/nodes are static after layout; pan/zoom is the transform uniform (cheap), recolor is
  a texture write — same hot paths as maps. Re-layout (slider/layout toggle) re-tessellates,
  which is the expected cost of a geometry change.
- Labels are HTML; culling caps the DOM to visible non-overlapping tips. Very large trees
  show labels only as you zoom (documented LOD), exactly as discussed.
- SVG backend at thousands of links is slow (documented); WebGL is the default.

## Out of scope (future)

- Newick/Nexus parsing (synthetic data for the example; a parser can come later).
- A `<Plot>` React wrapper (the example can use `plot()` imperatively first; add the wrapper
  if it earns its keep).
- Edge bundling, collapsible clades, animated transitions, MSDF GPU text.
