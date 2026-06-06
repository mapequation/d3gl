# GPU globe mode — design

**Date:** 2026-06-07
**Status:** Approved approach, pending spec review
**Affects:** `@mapequation/d3gl` (minor) — internal rendering path; no new public API
**Follows:** `docs/superpowers/specs/2026-06-06-map-projections-globe-design.md` ("Future work: GPU globe mode")

## Goal

Make orthographic-globe rotation fast on the WebGL backend by rendering the map
to an equirectangular texture once and spinning a textured 3D sphere — instead of
re-projecting + re-tessellating the geometry on the CPU every frame. Canvas/SVG
and non-orthographic projections keep today's CPU path. Activation is automatic;
there is no new user-facing API.

## Background

Today `GeoMap.enableRotation()` re-projects every layer through `geoPath` on each
drag frame and re-uploads the buffers. On WebGL this re-tessellates the land
(earcut over the ~110m coastline) and re-uploads GPU buffers every frame, which is
slow **even when dense layers are hidden** — the land fill alone is the
bottleneck. Canvas/SVG just replay paths, so they stay smooth.

A texture-mapped sphere removes per-frame geometry work entirely: bake the map
into an equirectangular texture once, then rotation/zoom are uniform-only updates
on a static sphere mesh. Cost is independent of data density (it's a texture), the
limb is exact (sphere silhouette), and seam/pole handling is free (UV wrapping).
The tradeoff is raster, not vector — addressed by an adaptive, power-of-2 texture
resolution (below). Crisp vector/billboard overlays are deferred (Future work).

## Approach (chosen)

**Texture-mapped sphere**, **automatic activation with CPU fallback**.

### Unified activation: one `enableZoom` for all projections

`"spherical"` is detectable from d3: azimuthal projections report a positive
`clipAngle()` (orthographic 90, stereographic 142, azimuthal\* ~180, gnomonic 60),
while cylindrical/conic/pseudocylindrical projections report `0`. So a single
public entry point handles every projection:

- `GeoMap.enableZoom(extent?, onTransform?)` auto-dispatches on `clipAngle() > 0`:
  - **spherical** → delegates to `enableRotation({ scaleExtent: extent })` —
    versor drag-rotate plus wheel-zoom bounded by the same `extent` (so one range
    argument sets the zoom limits for both kinds of projection); for WebGL +
    orthographic this in turn takes the GPU path below.
  - **flat** → today's d3-zoom affine pan/zoom (`super.enableZoom`).
- `enableRotation(opts?)` remains the explicit primitive (and what `enableZoom`
  delegates to); callers who want rotation regardless can still call it directly.

This removes the `if (spherical) enableRotation() else enableZoom()` branch from
userland — the map-projections example simplifies to `map.enableZoom([1, 8])` for
every projection. The `clipAngle()` check is cheap and cached alongside the
orthographic probe (re-evaluated only on projection/backend change).

### Activation & detection (GPU vs CPU rotation)

`enableRotation()` uses the GPU globe path iff:

1. the active backend is WebGL, **and**
2. the projection is **orthographic**.

Orthographic is detected by a cheap numeric probe: build a reference
`geoOrthographic()` with the live projection's `scale`/`translate`/`rotate`/
`clipAngle`, then compare `projection(p)` against the reference at ~3 sample
lon/lat points; equal within epsilon ⇒ orthographic. The probe runs **once per
projection or backend change** (in `setProjection`, on `enableRotation`, and on
`setBackend`) and the boolean is cached — it never runs in the render loop. A few
`projection()` evaluations ≈ microseconds.

Any other case — canvas/SVG backend, or a non-orthographic spherical projection
(stereographic, gnomonic, azimuthal\*) on WebGL — falls back to today's CPU
re-projection path.

### Bake pipeline

In GPU globe mode, `GeoMap` builds layer geometry with an internal
**equirectangular** projection fitted to a texture rectangle `texW × texH`
(`fitSize([texW, texH], { type: "Sphere" })`, so the full sphere fills the
texture). The WebGL backend renders those layers into an offscreen
**equirectangular framebuffer** (identity view transform) — this is the bake.

Texture resolution is adaptive, quantized to power-of-2 zoom levels:

- `base` ≈ 2048 × 1024 (configurable; ~2× a typical canvas width, 2:1 aspect).
- `level = clamp(floor(log2(viewScale)), 0, maxLevel)`.
- `texW = base.w << level`, `texH = base.h << level`.
- `maxLevel` is bounded by the GPU's `MAX_TEXTURE_SIZE` (e.g. cap so `texW`/`texH`
  stay ≤ device max, typically 8192–16384).

A re-bake happens only when:

- the level changes (zoom crosses a power of 2), **debounced** (~200 ms), or
- the layer data / colors change (recolor, `setProjection`, layer add/remove).

Within a level, zoom and rotation never re-bake — they are uniform-only.

### Sphere render

Draw a UV-sphere mesh (lat/lon tessellation, built once). The fragment shader
samples the equirectangular FBO by surface direction: `uv = [0.5 + atan2(d.x,
d.z)/2π, 0.5 - asin(d.y)/π]`. A **rotation uniform** (a 3×3 / mat4 from the
existing versor drag) spins the sphere; **back-face culling** yields the exact
limb. The affine view transform (`{k, x, y}` from zoom/pan) scales/translates the
sphere on screen. Flat map look — no 3D lighting/atmosphere.

### Interaction integration

The existing versor trackball in `enableRotation` is reused; in GPU mode its
output drives `backend.setGlobeRotation(R)` (a uniform update — free) instead of
`projection.rotate()` + rebuild. Wheel zoom updates the view scale and, if it
crosses a power-of-2 level, schedules a debounced re-bake. Recolor / data changes
re-bake the FBO (geometry/mesh unchanged).

## Components

- **`GeoMap`** — orchestration: detect orthographic (cached); in globe mode build
  baked geometry with the internal equirectangular projection at the current
  `texW×texH`, drive `setGlobeRotation` from versor, manage the level/re-bake
  debounce. Out of globe mode, unchanged.
- **`WebGLBackend`** — a globe render mode: an equirectangular FBO (sized to the
  level), a `bake()` that renders the current layers into it, a UV-sphere mesh +
  globe shader, `setGlobeRotation(R)`, and a `render()` that draws the sphere
  (sampling the FBO) under the current view transform. `setLayers`/`updateLayer`
  mark the bake dirty.
- **Shaders/mesh** — a new globe vertex/fragment shader pair and a sphere-mesh
  builder, alongside the existing fill/stroke/point shaders.

## `hideOnInteraction` semantics (refined)

`hideOnInteraction` is honored on **every CPU-rotation path** — canvas/SVG
everywhere, **and WebGL with a non-orthographic spherical projection** (still
CPU-re-projected, still slow, still benefits). It is a **no-op only while the GPU
globe path is actually live** (WebGL + orthographic), where rotation is already
free. The rule is keyed to "is the GPU globe active right now", not "is the
backend WebGL".

## Behavior notes

- Everything bakes into the texture, so **back-face points are hidden for free**
  (sphere back-face cull) — no per-point culling needed on this path. Points are
  baked (not crisp/constant-size); crisp overlays are Future work.
- Canvas/SVG and non-orthographic projections are **unchanged**.
- **Export:** on the WebGL globe, `toPNG()` captures the current sphere view.
  `toSVG()` from a globe falls back to a CPU orthographic snapshot at the current
  rotation (SVG can't render the 3D sphere); the SVG backend itself is always the
  CPU path.
- The existing **map-projections example** benefits automatically (orthographic on
  WebGL becomes smooth) **and** simplifies: it calls `map.enableZoom([1, 8])` for
  every projection, dropping its `if (entry.spherical)` branch.

## Fallback matrix

| Backend | Projection | Rotation path |
| --- | --- | --- |
| WebGL | orthographic | **GPU globe (this spec)** |
| WebGL | other spherical (stereographic, gnomonic, azimuthal\*) | CPU re-project (`hideOnInteraction` honored) |
| Canvas / SVG | any spherical | CPU re-project (`hideOnInteraction` honored) |
| any | flat (Mercator, …) | d3-zoom affine (unchanged) |

## Testing

- **Unified dispatch (browser):** `GeoMap.enableZoom([min,max])` attaches rotation
  for a spherical projection (`clipAngle() > 0`: orthographic, stereographic,
  gnomonic, azimuthal\*) and affine d3-zoom for a flat one (Mercator, Equal Earth,
  conic\*); switching projection re-dispatches.
- **Detection (node/browser):** the orthographic probe returns true for
  `geoOrthographic()` (any scale/translate/rotate) and false for
  `geoStereographic`/`geoGnomonic`/`geoMercator`; cached, not re-run per frame.
- **Backend (browser, headless WebGL):** `bake()` renders layers into the FBO;
  `setGlobeRotation` changes the rendered pixels without re-baking; a recolor
  triggers a re-bake; `readPixel` on the sphere shows the expected base map
  color at the centre and transparent (culled) outside the disc.
- **Level selection:** `level` maps `viewScale` to the right power-of-2 and is
  clamped by `maxLevel`; crossing a power of 2 marks a (debounced) re-bake.
- **Fallback:** non-orthographic / canvas / SVG still take the CPU path
  (`hideOnInteraction` still drops layers there).
- **Playwright:** the globe rotates smoothly on WebGL (no per-frame re-tessellate),
  back points don't show through, and switching to a non-orthographic projection
  still works.

## Out of scope

- Non-orthographic azimuthal projections on the GPU (they keep the CPU path).
- Crisp vector / billboard point & label overlays on the sphere (Future work:
  hybrid texture-sphere + vector overlay).
- 3D lighting, atmosphere, terrain/bump — it's a flat data-viz map.
- Deep-zoom vector crispness (the texture softens past its level; bounded by the
  power-of-2 re-bake).

## Risks

- **WebGL backend complexity:** a second render path (FBO bake + sphere) alongside
  the existing flat path. Mitigated by isolating it behind a clear "globe mode"
  on the backend and leaving the flat path untouched.
- **Texture memory at high levels:** capped by `maxLevel`/`MAX_TEXTURE_SIZE`.
- **Orthographic detection false-negative:** if the probe fails to recognize an
  orthographic-equivalent projection, it harmlessly falls back to the (correct but
  slower) CPU path — never wrong output.

## Release

Changeset: `@mapequation/d3gl` **minor** — WebGL orthographic-globe rotation is
GPU-accelerated via a texture-mapped sphere (automatic; canvas/SVG and other
projections unchanged). No new public API.
