# `backend: "auto"` — progressive canvas-first → WebGL — design

**Date:** 2026-06-08
**Branch:** `feat/auto-backend-progressive-webgl` (to be created off `main`)
**Status:** Approved scope (core `"auto"` mode; opt-in, non-breaking)

## Problem

WebGL is the best backend for an interactive map, but it carries a fixed startup
cost that Canvas does not: creating the luma.gl device (a WebGL2 context, plus
GPU-process / driver spin-up on the first context of a page). Canvas, by contrast,
paints synchronously with effectively zero startup.

Measured in headless Chromium (SwiftShader — absolute ms are inflated vs a real
GPU, but the relative breakdown and GL-call counts hold):

| Phase | world-map (2 layers) | bioregions-like (4 layers, single build) | canvas (same 4 layers) |
|---|---|---|---|
| sync tessellate (no GPU) | 6.6ms | 10.5ms | 10.7ms |
| device + upload + first render | 64ms | 208ms | 6.5ms |
| **total to first paint** | **70ms** | **219ms** | **17ms** |
| `compileShader` / `createProgram` | 3 / 2 | 3 / 2 | — |

Isolated device creation: cold **32ms**, warm (2nd context) **11ms**.

Two findings frame this work:

1. **Shader compilation is already optimal.** `compileShader:3, createProgram:2`
   appears regardless of layer count — luma.gl v9 caches compiled shaders/programs
   by source. Tessellation already runs concurrently with the in-flight async
   device creation. So "tessellate off the first-paint path" is not a lever.
2. **The remaining WebGL floor is device creation** (~32ms cold here; 100s of ms on
   real machines with a GPU process to spin up), versus ~0 for Canvas. This is the
   target.

The architecture already supports everything needed to hide this cost: the `Scene`
and layer specs are backend-independent, and `BaseEngine` already swaps backends
cleanly mid-life (`setBackend` / `swapBackend`). We can paint Canvas immediately and
upgrade to WebGL transparently in the background.

### Out of scope (investigated, deferred)

- **Lazy offscreen framebuffer** (`WebGLBackend.create` allocates a 720×380 rgba8 +
  depth24-stencil8 framebuffer eagerly; only `toPNG`/`readPixel`/`pick` need it).
  Small (~7ms here) independent win — separate change.
- **Device pool / warm-device reuse** across React resize-driven engine recreations
  (~3× cheaper warm). More involved (canvas-bound device) — separate change.
- **Bioregions double-`buildLayers`** (`MapStore.initEngine` rebuilds in
  `whenReady`, re-tessellating and recreating every renderer; ~3.3× startup cost).
  That is a userland fix in the bioregions repo, not this d3gl change.

## Goal

Add a fourth `BackendType` value, `"auto"`, that:

- paints with the **Canvas** backend **synchronously** for an instant first paint;
- resolves `whenReady()` / fires `onReady` **at that first canvas paint** (early);
- creates the **WebGL** device in the **background** and swaps to it transparently
  when ready, preserving layers, colors, transform, and interaction;
- falls back to staying on Canvas (with a `console.warn`) if WebGL is unavailable.

`"auto"` is **opt-in**. Existing `"webgl"` / `"canvas"` / `"svg"` behavior is
unchanged.

## Design

### Lifecycle

```
geoMap(host, { backend: "auto" })
  │
  ├─ (sync) install CanvasBackend → push layers → render      ← first paint, ~0ms
  │         this.ready resolves here  (whenReady / onReady fire)
  │         currentBackend = "canvas"
  │
  └─ (background) create WebGLBackend device …
        ├─ on ready : swap handle (destroy canvas), re-push specs from this.specs,
        │             re-apply this.transform, re-render, onBackendSwapped()
        │             currentBackend = "webgl"
        └─ on failure: keep canvas, console.warn, currentBackend stays "canvas"
```

`"auto"` is **not** a real backend — there is no `AutoBackend` class. It is an
engine-level orchestration of two real backends. `currentBackend` always reflects
the **live** backend, so `backendType()`-dependent logic (notably GeoMap's gpuGlobe
check) is correct in each phase and re-evaluates on swap.

The upgrade is **one-way** (canvas → webgl, never back) and runs **once** per engine.

### Components & changes

**`map/backend-factory.ts`**
- Add `"auto"` to `BackendType`.
- Add a synchronous `createCanvasBackend(host, w, h): BackendHandle` (the
  `CanvasBackend` constructor is already synchronous; this skips the `Promise`
  wrapper that `createBackend` adds). `createBackend` stays async for real backends.

**`map/base-engine.ts`** (the orchestration)
- New private flag tracking that an auto-upgrade is pending / has run (guards
  once-only execution).
- **Constructor:** when `backend === "auto"`, synchronously install the canvas
  handle via `createCanvasBackend`, set `currentBackend = "canvas"`, push layers +
  transform + render, set `this.ready = Promise.resolve()`, then start the
  background upgrade. Otherwise unchanged (`this.ready = this.swapBackend(backend)`).
- **`startUpgrade()`** (private, once-guarded): create the WebGL backend through the
  existing async swap path, **without reassigning `this.ready`** (preserves the
  early resolution). On success, the existing swap tail runs (destroy old canvas
  handle + remove its element, `setLayers` from `this.specs`, `setTransform`,
  `render`) and then `onBackendSwapped()`. On throw, leave the canvas handle in
  place and `console.warn("d3gl: WebGL upgrade failed, staying on canvas", err)`.
  The existing `swapToken` / `destroyed` guards make a destroy-during-upgrade safe
  (the freshly created WebGL backend is torn down and its element removed).
- **`onBackendSwapped()`** (new protected, default no-op): called at the end of
  every successful swap (both `setBackend` and the auto-upgrade). Subclasses react
  to a live-backend change here.
- **`setBackend("auto")`** later in life behaves like the constructor's auto path
  (install canvas now if the live backend isn't already canvas, then upgrade).

**`map/geo-map.ts`**
- Move the gpuGlobe re-evaluation + interaction re-dispatch out of the `setBackend`
  override and into `onBackendSwapped()`, so it fires for **both** an explicit
  `setBackend` and the transparent auto-upgrade (an orthographic globe switches from
  CPU rotation to the GPU globe on swap). `setBackend` keeps its
  `disableInteraction()` pre-step.

**`react/GeoMap.tsx` (+ types)**
- `"auto"` flows through as a valid `backend` prop value. The `createdBackend` ref
  logic already tolerates a new enum value; no behavioral change unless a caller
  opts in.

### Data flow during the canvas window

Between first paint and WebGL-ready, the canvas handle is live and `this.specs` is
the source of truth, so existing machinery already covers every interaction:

- `.layer()` / `.append()` / `.recolor()` → applied to the canvas backend; the
  swap's `setLayers` re-pushes all specs to WebGL from `this.specs`.
- `.setTransform()` → stored in `this.transform`, re-applied on swap.
- `.enableZoom()` / rotation → set up against canvas (CPU path; gpuGlobe is false
  while the live backend is canvas). On swap, `onBackendSwapped()` re-evaluates
  gpuGlobe and re-dispatches the stored `interactionRequest`.

### Error handling

- WebGL device creation throws / WebGL2 unsupported → caught in `startUpgrade()`;
  keep the canvas handle, `console.warn`, `currentBackend` stays `"canvas"`. The map
  keeps working — the point of degrading gracefully.
- Engine destroyed mid-upgrade → existing `swapToken` / `destroyed` guard tears down
  the freshly created WebGL backend and removes its orphan element.

### Trade-offs

- A brief visible **swap "pop"** when WebGL takes over (Canvas vs WebGL anti-aliasing
  differ slightly). Acceptable and opt-in.
- One extra render (canvas paint, then the post-swap WebGL render).

## Testing

Browser-mode suites (`*.browser.test.ts`), matching existing conventions. Per the
project memory these hang in the Claude Code sandbox; run locally with the sandbox
disabled.

- `backend:"auto"` → `whenReady()` resolves with a **canvas** element live; a pixel
  is painted immediately.
- After the upgrade settles → the live backend is WebGL (host holds a WebGL-backed
  canvas; a readback pixel matches expected geometry/color).
- Layers + transform set during the canvas window survive the swap (geometry + color
  present post-upgrade).
- Orthographic + `enableRotation` under `"auto"`: rotation works on canvas pre-swap;
  the GPU globe is active post-swap.
- Destroy-during-upgrade leaves no orphan canvas in the host.
- Failing-WebGL path (stub `createBackend` to reject the webgl create): stays on
  canvas and still renders.

## Rollout

Opt-in only; no default changes. A follow-up could make `backend:"webgl"` an alias
for `"auto"` once the swap pop is judged acceptable for all callers, but that is a
separate decision. The bioregions app can adopt `backend:"auto"` (alongside its own
double-`buildLayers` fix) to get a canvas-speed first paint with WebGL interactivity.
