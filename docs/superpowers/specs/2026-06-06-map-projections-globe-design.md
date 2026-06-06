# Map projections + rotatable globe — design

**Date:** 2026-06-06
**Status:** Approved approach, pending spec review
**Affects:** `@mapequation/d3gl` (minor), `@d3gl/website`

## Goal

Add a new "Map projections" example where the user can pick any d3-geo *core*
projection from a dropdown, including spherical projections (orthographic,
azimuthal, …) rendered as a **rotatable 3D globe** you can spin by dragging.
Add the small library capabilities this requires so the work lives in the core
library, not as an example workaround.

## Background: why rotation is different from zoom

The map engine projects every feature **once** into 2D world coordinates
(`geoLayer` runs `geoPath(projection, ctx)` into a `PathContext`, tessellated
into 2D buffers). Zoom/pan is then a pure 2D affine transform
(`screen = k·world + t`) applied on the GPU — exact, cheap, project-once.

A **rotatable globe** changes `projection.rotate([λ,φ,γ])`, which rotates the
sphere *before* projecting. Because the pipeline only stores 2D-projected
geometry, there is no way to rotate it correctly without going back to lon/lat
and **re-projecting**. So rotation cannot reuse the affine path.

### Why CPU re-project (not GPU) for this example

A genuine "project once" globe is possible on the GPU: project each vertex once
to a 3D cartesian unit vector, rotate via a shader uniform (`v' = R·v`), project
per-vertex (orthographic = use x,y / drop z), and `discard` back-hemisphere
fragments (`z < 0`) for the limb. It preserves project-once and scales to dense
geometry.

We are **not** doing that here because:

- It is **WebGL-only**. Canvas/SVG backends are CPU 2D rasterizers and would
  still need a CPU re-projection path — so GPU adds a *second* path rather than
  replacing the CPU one.
- It is a substantial new subsystem (3D buffers, a dedicated shader with
  rotation uniform + per-projection vertex math + fragment-discard clipping).
- Limb clipping of filled polygons is only approximate on the GPU; d3-geo's CPU
  clipper inserts the exact limb arc (crisp coastline at the edge).

For low-poly world land, CPU re-project per frame is a few ms, correct on all
three backends, and reuses the entire existing pipeline. The GPU globe is
recorded as a future enhancement (see "Future work").

### Dense data: `hideOnInteraction`

To keep the GPU-globe ambition unnecessary for dense datasets (e.g. the
downstream Infomap Bioregions map), layers can opt out of rendering while the
user interacts. A layer flagged `hideOnInteraction` is dropped from the render
while interacting — a rotation drag, or a zoom/pan gesture (tracked by a shared
`interacting` flag set on pointerdown/up for rotation and on d3-zoom start/end
for zoom). During a rotation drag only cheap layers like land re-project per
frame; when the gesture ends, *all* layers re-project and reappear. Smooth
interaction, full detail on release.

## Library additions (`@mapequation/d3gl`)

### 1. `GeoMap.setProjection(projection: GeoProjection): this`

Swap the projection on an existing map:

- Store the new projection.
- Re-run each registered layer's build against it (re-project once).
- **Reset the affine transform to identity** (the new projection is freshly
  fitted by the caller, so the view starts clean).
- Re-push layers + transform to the backend; render.

To support this without userland recreation, `GeoMap` retains each layer's
definition (`name`, features, `LayerOptions`) and rebuilds specs from them.

### 2. `GeoMap.enableRotation(opts?): this`

Versor trackball rotation for spherical projections:

- **drag** → rotate via `projection.rotate(...)` using vendored versor
  quaternion math; rebuild the (non-hidden) geo layers and render. Guard on
  `projection.invert(pointer)` returning `null` (pointer off the disc).
- **wheel** → scale the projection (clamped to a multiple of the fitted scale);
  rebuild and render.
- Sets the shared `interacting` flag `true` from pointerdown until pointerup.
  While `true`, layers with `hideOnInteraction` are excluded from the render and
  not re-projected. On pointerup, all layers re-project at the final rotation
  and the engine renders the full detail.
- `opts` (all optional): `scaleExtent?: [number, number]` (default `[0.5, 8]`,
  relative to the fitted scale), `onRotate?: (rotation: [number, number,
  number]) => void`.

### 3. Interaction cleanup / `disableInteraction()`

`enableZoom` and `enableRotation` bind listeners to the same host and are
mutually exclusive. Add a single interaction-cleanup slot in `BaseEngine`:

- `BaseEngine` holds `private interactionCleanup: (() => void) | null`.
- `enableZoom` and `enableRotation` call the existing cleanup (if any) **before**
  attaching, then store their own cleanup.
- `enableZoom` cleanup: `select(host).on(".zoom", null)`.
- `enableRotation` cleanup: remove its pointer/wheel listeners.
- Public `disableInteraction(): this` runs and clears the cleanup.

### 4. `LayerOptions.hideOnInteraction?: boolean`

Per-layer flag (default `false`). Threaded onto `LayerSpec`. The layer push
(`pushLayers` / `setBackend`) excludes specs where
`this.interacting && spec.hideOnInteraction` from `setLayers`, and the rotation
rebuild skips re-projecting them while interacting. The `interacting` flag is set
by both `enableRotation` (pointerdown/up) and `enableZoom` (d3-zoom start/end), so
flagged layers also drop out during a flat-map zoom/pan. `setInteracting` only
re-pushes when some layer opts in, so ordinary maps keep zero zoom overhead.

### 5. Vendored versor (`src/geo/versor.ts`)

Port the canonical ~50-line versor quaternion helper (Mike Bostock / Philippe
Rivière, ISC) with attribution: `cartesian(lonlat)`, `delta(v0, v1)`,
`multiply(q0, q1)`, `rotation(q)`, and the default `versor(angles)`. Internal to
the library (used by `enableRotation`); not part of the public export surface.
This keeps the published package dependency-free for this feature.

## Website additions (`@d3gl/website`)

### New `select` control type

A 14-entry segmented bar is unusable, so add a `select` control:

```ts
| {
    type: "select";
    key: string;
    label: string;
    options: string[];      // value === label (projection display names)
    value?: string;         // default (else options[0])
  }
```

- `types.ts`: extend `ControlSpec`.
- `Example.tsx`: seed default with `c.type === "select" ? (c.value ?? c.options[0]) : …`;
  add a `selects` filter and render a themed native `<select>` (theme tokens, h-6,
  text-[11px]) alongside the segmented/range controls.

### New example `src/examples/map-projections/`

- `draw.ts` (`ImperativeSetup`, the file shown in the code tab — pure d3gl):
  - A projection registry tagging each entry `flat | spherical`:
    - **flat (zoom):** Natural Earth, Equal Earth, Mercator, Transverse Mercator,
      Equirectangular, Conic Conformal, Conic Equal Area, Conic Equidistant, Albers.
    - **spherical (rotate):** Orthographic, Stereographic, Azimuthal Equal Area,
      Azimuthal Equidistant, Gnomonic.
  - `setup`: build the default fitted projection (**Orthographic**), create the
    `geoMap`, add layers: ocean (`{type:"Sphere"}` fill), 20° graticule
    (`makeGraticule()`), land (`loadWorld().land`). Return `{ engine, render }`.
  - `render(options)`: look up `options.projection`, build + fit that projection,
    call `map.setProjection(p)`, then `map.enableRotation()` (spherical) or
    `map.enableZoom([1, 8])` (flat).
- `MapProjections.tsx`: harness wrapper (`<Example>` + `<Imperative>`), default
  control = the projection `select`.
- `examples/map/map-projections.mdx`: intro + `<ExampleCard files={["map-projections/draw.ts"]}>`.
- `astro.config.mjs`: add to the Examples → Map sidebar group (after World map).

## Testing

- **Library (browser tests, existing harness):**
  - `setProjection` re-projects: after switching projection, a known feature's
    projected anchor/path changes and the transform resets to identity.
  - `enableRotation`: simulating a drag changes `projection.rotate()` and the
    rendered geometry; `disableInteraction()` removes listeners.
  - `hideOnInteraction`: while `interacting`, a flagged layer is absent from the
    pushed layers; when the gesture ends it is present again.
- **Website smoke:** existing `pnpm --filter @d3gl/website build` covers the new
  MDX/example compiling. Playwright check the page renders a globe and the
  dropdown switches projections (webgl/canvas/svg).

## Out of scope

- **GPU globe mode** (see Future work).
- Hover/picking on the rotated globe (`pick()` assumes the affine inverse).
- `d3-geo-projection` extended set (Mollweide, Robinson, Winkel Tripel, …) — core
  only, no new dependency.
- `geoAlbersUsa` (US-only composite; doesn't render a world sphere).

## Future work

**GPU globe mode** (its own spec when dense-data globes need it): project once to
3D cartesian, rotate via a shader uniform, project per-vertex, discard
back-hemisphere fragments for the limb. WebGL-only; keeps the CPU path for
canvas/svg. Until then, `hideOnInteraction` covers dense data by hiding it during
the drag.

## Release

Changeset: `@mapequation/d3gl` **minor** — adds `GeoMap.setProjection`,
`GeoMap.enableRotation`, `BaseEngine.disableInteraction`, and
`LayerOptions.hideOnInteraction`.
