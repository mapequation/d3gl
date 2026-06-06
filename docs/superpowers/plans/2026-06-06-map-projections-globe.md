# Map projections + rotatable globe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Map projections" docs example with a projection dropdown (d3-geo core), where spherical projections render as a drag-to-rotate globe; add the small `@mapequation/d3gl` capabilities it needs (`setProjection`, `enableRotation`, `disableInteraction`, `LayerOptions.hideOnRotation`).

**Architecture:** The map engine projects features once into 2D and pans/zooms via an affine GPU transform. Rotation can't reuse that (the stored geometry is already-projected 2D), so a spherical projection re-projects features per drag frame on the CPU via `projection.rotate(...)` (versor trackball). Dense layers can opt out per-frame with `hideOnRotation` and re-project once on drag release. Works identically across webgl/canvas/svg.

**Tech Stack:** TypeScript, d3-geo (core projections + `geoPath`/`invert`), vendored versor quaternion math, pnpm workspace, vitest (node + headless-Chromium browser), Astro Starlight + React islands for the docs site.

**Spec:** `docs/superpowers/specs/2026-06-06-map-projections-globe-design.md`

---

## File Structure

**Library (`packages/d3gl/`):**
- Create: `src/geo/versor.ts` — vendored versor quaternion helper (internal).
- Create: `src/geo/__tests__/versor.test.ts` — node unit test for versor.
- Modify: `src/map/base-engine.ts` — `rotating` flag, `renderSpecs()` filter, in-place `registerLayer`, `hideOnRotation` on `LayerSpec`, interaction-cleanup slot + `disableInteraction()`.
- Modify: `src/map/geo-map.ts` — mutable projection, layer defs, `buildSpec`, `setProjection`, `rebuildLayers`, `enableRotation`, `LayerOptions.hideOnRotation`, `RotationOptions`.
- Create: `src/map/geo-map-globe.browser.test.ts` — `setProjection` / `enableRotation` / `hideOnRotation` behavior.

**Website (`website/`):**
- Modify: `src/examples/types.ts` — add the `select` control type.
- Modify: `src/components/Example.tsx` — seed + render the `select` control.
- Create: `src/examples/map-projections/draw.ts` — the example (code-tab source).
- Create: `src/examples/map-projections/MapProjections.tsx` — harness wrapper.
- Create: `src/content/docs/examples/map/map-projections.mdx` — the docs page.
- Modify: `astro.config.mjs` — sidebar entry under Examples → Map.

**Release:**
- Create: `.changeset/map-projections-globe.md` — minor bump.

---

## Task 1: Vendored versor quaternion helper

**Files:**
- Create: `packages/d3gl/src/geo/versor.ts`
- Test: `packages/d3gl/src/geo/__tests__/versor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/d3gl/src/geo/__tests__/versor.test.ts
import { describe, it, expect } from "vitest";
import versor from "../versor.js";

const close = (a: number[], b: number[], tol = 1e-6) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, Math.round(-Math.log10(tol))));
};

describe("versor", () => {
  it("builds identity quaternion from zero angles", () => {
    close(versor([0, 0, 0]), [1, 0, 0, 0]);
  });
  it("maps lon/lat to cartesian unit vectors", () => {
    close(versor.cartesian([0, 0]), [1, 0, 0]);
    close(versor.cartesian([90, 0]), [0, 1, 0]);
    close(versor.cartesian([0, 90]), [0, 0, 1]);
  });
  it("recovers euler angles from identity quaternion", () => {
    close(versor.rotation([1, 0, 0, 0]), [0, 0, 0]);
  });
  it("returns the identity quaternion for a zero delta", () => {
    const v = versor.cartesian([12, 34]);
    close(versor.delta(v, v), [1, 0, 0, 0]);
  });
  it("round-trips rotation(versor(angles))", () => {
    close(versor.rotation(versor([20, 10, 0])), [20, 10, 0], 1e-6);
  });
  it("composes a non-identity rotation from two distinct points", () => {
    const q = versor.multiply(
      versor([0, 0, 0]),
      versor.delta(versor.cartesian([0, 0]), versor.cartesian([30, 10])),
    );
    const r = versor.rotation(q);
    expect(Math.hypot(r[0], r[1], r[2])).toBeGreaterThan(1); // actually rotated
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/d3gl && pnpm exec vitest run src/geo/__tests__/versor.test.ts`
Expected: FAIL — `Cannot find module '../versor.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/d3gl/src/geo/versor.ts
/**
 * versor — quaternion helpers for trackball-style globe rotation.
 *
 * Ported (TypeScript) from d3/versor by Mike Bostock and Philippe Rivière,
 * ISC License (https://github.com/d3/versor). Internal to @mapequation/d3gl;
 * used by GeoMap.enableRotation to rotate a spherical projection from pointer
 * drags. Not part of the public export surface.
 */
type Vec3 = [number, number, number];
type Quaternion = [number, number, number, number];
/** Projection rotation triple `[lambda, phi, gamma]` in degrees. */
export type Angles = [number, number, number];

const { acos, asin, atan2, cos, max, min, PI, sin, sqrt } = Math;
const radians = PI / 180;
const degrees = 180 / PI;

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Quaternion for a projection rotation `[lambda, phi, gamma]` (degrees). */
function versor(e: Angles): Quaternion {
  const l = (e[0] / 2) * radians, sl = sin(l), cl = cos(l);
  const p = (e[1] / 2) * radians, sp = sin(p), cp = cos(p);
  const g = (e[2] / 2) * radians, sg = sin(g), cg = cos(g);
  return [
    cl * cp * cg + sl * sp * sg,
    sl * cp * cg - cl * sp * sg,
    cl * sp * cg + sl * cp * sg,
    cl * cp * sg - sl * sp * cg,
  ];
}

/** Unit cartesian vector for a `[lon, lat]` (degrees) coordinate. */
versor.cartesian = function (e: [number, number]): Vec3 {
  const l = e[0] * radians, p = e[1] * radians, cp = cos(p);
  return [cp * cos(l), cp * sin(l), sin(p)];
};

/** Euler angles `[lambda, phi, gamma]` (degrees) for a quaternion. */
versor.rotation = function (q: Quaternion): Angles {
  return [
    atan2(2 * (q[0] * q[1] + q[2] * q[3]), 1 - 2 * (q[1] * q[1] + q[2] * q[2])) * degrees,
    asin(max(-1, min(1, 2 * (q[0] * q[2] - q[3] * q[1])))) * degrees,
    atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] * q[2] + q[3] * q[3])) * degrees,
  ];
};

/** Quaternion rotating unit vector `v0` to `v1` (by fraction `alpha`). */
versor.delta = function (v0: Vec3, v1: Vec3, alpha = 1): Quaternion {
  const w = cross(v0, v1), l = sqrt(dot(w, w));
  if (!l) return [1, 0, 0, 0];
  const t = (alpha * acos(max(-1, min(1, dot(v0, v1))))) / 2, s = sin(t);
  return [cos(t), (w[2] / l) * s, -(w[1] / l) * s, (w[0] / l) * s];
};

/** Hamilton product of two quaternions. */
versor.multiply = function (q0: Quaternion, q1: Quaternion): Quaternion {
  return [
    q0[0] * q1[0] - q0[1] * q1[1] - q0[2] * q1[2] - q0[3] * q1[3],
    q0[0] * q1[1] + q0[1] * q1[0] + q0[2] * q1[3] - q0[3] * q1[2],
    q0[0] * q1[2] - q0[1] * q1[3] + q0[2] * q1[0] + q0[3] * q1[1],
    q0[0] * q1[3] + q0[1] * q1[2] - q0[2] * q1[1] + q0[3] * q1[0],
  ];
};

export default versor;
export type { Vec3, Quaternion };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/d3gl && pnpm exec vitest run src/geo/__tests__/versor.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/d3gl/src/geo/versor.ts packages/d3gl/src/geo/__tests__/versor.test.ts
git commit -m "feat(geo): vendor versor quaternion helper for globe rotation"
```

---

## Task 2: BaseEngine — rotation state, render filter, in-place layers, interaction cleanup

**Files:**
- Modify: `packages/d3gl/src/map/base-engine.ts`

This task has no standalone test (its behavior is exercised by Task 4 through `GeoMap`). Implement, typecheck, and run the existing suite to confirm no regressions.

- [ ] **Step 1: Add `hideOnRotation` to `LayerSpec`**

In `interface LayerSpec` (after `sizeMode?`), add:

```ts
  /** When true, this layer is dropped from the render during an active rotation
   *  drag (and not re-projected per frame); it re-projects + reappears on release. */
  hideOnRotation?: boolean;
```

- [ ] **Step 2: Add rotation + interaction-cleanup fields**

In the `BaseEngine` field block (after `private destroyed = false;`), add:

```ts
  /** True while a rotation drag is in progress (set by enableRotation). Layers
   *  flagged hideOnRotation are excluded from the render while this is true. */
  protected rotating = false;
  /** Detaches the currently-attached interaction (zoom or rotation), if any. */
  private interactionCleanup: (() => void) | null = null;
```

- [ ] **Step 3: Add the render-spec filter and use it everywhere layers are pushed**

Add this private helper (near `renderLayer`):

```ts
  /** Specs to actually render: hidden-on-rotation layers drop out mid-drag. */
  private renderSpecs(): LayerSpec[] {
    return this.specs.filter((s) => !(this.rotating && s.hideOnRotation));
  }
```

In `pushLayers()`, change `this.specs.map(...)` to `this.renderSpecs().map(...)`:

```ts
  private pushLayers(): void {
    this.handle?.backend.setLayers(this.renderSpecs().map((s) => this.renderLayer(s)));
    this.handle?.backend.setTransform(this.transform);
    this.render();
  }
```

In `swapBackend(...)`, change the post-swap `setLayers` line the same way:

```ts
    next.backend.setLayers(this.renderSpecs().map((s) => this.renderLayer(s)));
```

- [ ] **Step 4: Make `registerLayer` replace in place (stable draw order)**

Replace the `this.specs = this.specs.filter(...).concat(spec);` line in `registerLayer` with an in-place replace so re-registering a layer (on projection change / per rotation frame) does not reorder layers:

```ts
    const at = this.specs.findIndex((s) => s.name === spec.name);
    if (at >= 0) this.specs[at] = spec;
    else this.specs.push(spec);
```

- [ ] **Step 5: Register cleanup in `enableZoom` and add `disableInteraction`**

At the very top of `enableZoom(...)` (before `const sel = ...`), add:

```ts
    this.disableInteraction();
```

At the end of `enableZoom(...)`, just before `return this;`, register its cleanup:

```ts
    this.interactionCleanup = () => { (sel as any).on(".zoom", null); };
```

Add this public method (after `setBackend`):

```ts
  /** Detach the current pan/zoom or rotation interaction (no-op if none). */
  disableInteraction(): this {
    this.interactionCleanup?.();
    this.interactionCleanup = null;
    return this;
  }
```

Add a protected setter so `GeoMap.enableRotation` can register its own cleanup:

```ts
  /** Subclasses (GeoMap.enableRotation) register their interaction teardown here.
   *  Call disableInteraction() first if replacing an existing interaction. */
  protected setInteractionCleanup(fn: () => void): void {
    this.interactionCleanup = fn;
  }
```

- [ ] **Step 6: Typecheck + run the existing suite**

Run: `cd packages/d3gl && pnpm exec tsc -b && cd ../.. && pnpm test`
Expected: typecheck clean; all existing node + browser tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/d3gl/src/map/base-engine.ts
git commit -m "feat(map): rotation render filter, in-place layers, interaction cleanup in BaseEngine"
```

---

## Task 3: GeoMap — setProjection, enableRotation, hideOnRotation

**Files:**
- Modify: `packages/d3gl/src/map/geo-map.ts`

Behavior is verified by Task 4; implement then typecheck here.

- [ ] **Step 1: Rewrite `geo-map.ts`**

Replace the whole file with:

```ts
import { type GeoProjection } from "d3-geo";
import { geoLayer } from "../geo/index.js";
import versor, { type Angles, type Vec3, type Quaternion } from "../geo/versor.js";
import { BaseEngine, type HoverHit, type LayerSpec } from "./base-engine.js";
import type { BackendType } from "./backend-factory.js";

export interface GeoMapOptions { width: number; height: number; projection: GeoProjection; backend?: BackendType; }
export interface LayerOptions<F = any> {
  fill?: string | ((f: F, i: number) => string);
  stroke?: string | ((f: F, i: number) => string);
  lineWidth?: number; pointRadius?: number; clipTo?: string;
  id?: (f: F, i: number) => string | number;
  /** "world" (default): radius scales with zoom. "screen": constant pixel size. */
  sizeMode?: "world" | "screen";
  /** Drop this layer from the render during a rotation drag (re-projects + reappears
   *  on release). Use for dense layers so only cheap layers re-project per frame. */
  hideOnRotation?: boolean;
}

/** Options for {@link GeoMap.enableRotation}. */
export interface RotationOptions {
  /** Wheel-zoom limits as multiples of the fitted scale. Default [0.5, 8]. */
  scaleExtent?: [number, number];
  /** Called with the new `[lambda, phi, gamma]` after each rotation step. */
  onRotate?: (rotation: Angles) => void;
}

interface LayerDef { name: string; list: any[]; opts: LayerOptions; }

export class GeoMap extends BaseEngine {
  private projection: GeoProjection;
  private defs: LayerDef[] = [];

  constructor(host: HTMLElement, opts: GeoMapOptions) {
    super(host, opts.width, opts.height, opts.backend ?? "webgl");
    this.projection = opts.projection;
  }

  layer<F>(name: string, features: F | readonly F[], opts: LayerOptions<F> = {}): this {
    const list = Array.isArray(features) ? (features as F[]) : [features as F];
    this.defs = this.defs.filter((d) => d.name !== name).concat({ name, list, opts });
    this.registerLayer(this.buildSpec(name, list, opts));
    return this;
  }

  /** Swap the projection on the existing map: re-project every layer once and
   *  reset the affine view to identity (the caller fits the new projection). */
  setProjection(projection: GeoProjection): this {
    this.projection = projection;
    this.rebuildLayers();
    this.setTransform({ k: 1, x: 0, y: 0 });
    return this;
  }

  /** Drag to trackball-rotate a spherical projection; wheel to scale it. Re-projects
   *  on the CPU per frame. Layers flagged hideOnRotation are hidden mid-drag. */
  enableRotation(opts: RotationOptions = {}): this {
    this.disableInteraction();
    const host = this.host;
    const [minK, maxK] = opts.scaleExtent ?? [0.5, 8];
    const scale0 = this.projection.scale();
    let v0: Vec3 | null = null;
    let q0: Quaternion | null = null;
    let r0: Angles = [0, 0, 0];
    let active = false;

    const at = (e: PointerEvent): [number, number] => {
      const r = host.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const down = (e: PointerEvent): void => {
      const inv = this.projection.invert?.(at(e));
      if (!inv) return;
      v0 = versor.cartesian(inv);
      r0 = this.projection.rotate();
      q0 = versor(r0);
      active = true;
      this.rotating = true;
      host.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent): void => {
      if (!active || !v0 || !q0) return;
      const inv = this.projection.rotate(r0).invert?.(at(e));
      if (!inv) return;
      const q1 = versor.multiply(q0, versor.delta(v0, versor.cartesian(inv)));
      const rot = versor.rotation(q1);
      this.projection.rotate(rot);
      this.rebuildLayers({ skipHidden: true });
      opts.onRotate?.(rot);
    };
    const up = (e: PointerEvent): void => {
      if (!active) return;
      active = false;
      this.rotating = false;
      host.releasePointerCapture?.(e.pointerId);
      this.rebuildLayers(); // re-project all (incl. hidden) at the final rotation
    };
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      const s = Math.max(scale0 * minK, Math.min(scale0 * maxK, this.projection.scale() * Math.exp(-e.deltaY * 0.001)));
      this.projection.scale(s);
      this.rebuildLayers({ skipHidden: this.rotating });
    };

    host.addEventListener("pointerdown", down);
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerup", up);
    host.addEventListener("pointercancel", up);
    host.addEventListener("wheel", wheel, { passive: false });
    this.setInteractionCleanup(() => {
      host.removeEventListener("pointerdown", down);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerup", up);
      host.removeEventListener("pointercancel", up);
      host.removeEventListener("wheel", wheel);
      this.rotating = false;
    });
    return this;
  }

  /** Re-register layers against the current projection (re-project once). During a
   *  rotation drag, skipHidden avoids re-projecting hideOnRotation layers. */
  private rebuildLayers(o: { skipHidden?: boolean } = {}): void {
    for (const def of this.defs) {
      if (o.skipHidden && def.opts.hideOnRotation) continue;
      this.registerLayer(this.buildSpec(def.name, def.list, def.opts));
    }
  }

  private buildSpec(name: string, list: any[], opts: LayerOptions): LayerSpec {
    const ids = list.map((f, i) => (opts.id ? opts.id(f, i) : i));
    return {
      name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo,
      sizeMode: opts.sizeMode, hideOnRotation: opts.hideOnRotation,
      build: geoLayer(list, this.projection, { id: (_f, i) => ids[i]!, lineWidth: opts.lineWidth, pointRadius: opts.pointRadius, sizeMode: opts.sizeMode }),
    };
  }
}
export function geoMap(host: HTMLElement, opts: GeoMapOptions): GeoMap { return new GeoMap(host, opts); }
export type { HoverHit };
```

- [ ] **Step 2: Export `LayerSpec` as a type from `base-engine.ts`**

`geo-map.ts` now imports `type LayerSpec`. In `base-engine.ts`, change the `interface LayerSpec {` declaration to `export interface LayerSpec {` (add `export`).

- [ ] **Step 3: Typecheck**

Run: `cd packages/d3gl && pnpm exec tsc -b`
Expected: clean (note `GeoProjection.invert` is optional in d3 types — the `?.` and null guards handle it).

- [ ] **Step 4: Commit**

```bash
git add packages/d3gl/src/map/geo-map.ts packages/d3gl/src/map/base-engine.ts
git commit -m "feat(map): GeoMap.setProjection + versor enableRotation + hideOnRotation"
```

---

## Task 4: Library behavior tests (browser)

**Files:**
- Create: `packages/d3gl/src/map/geo-map-globe.browser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/d3gl/src/map/geo-map-globe.browser.test.ts
import { describe, it, expect } from "vitest";
import { geoEquirectangular, geoOrthographic } from "d3-geo";
import { geoMap } from "./geo-map.js";

const sphere = { type: "Sphere" } as const;
const land = (): GeoJSON.Feature => ({
  type: "Feature", properties: {},
  geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 30], [30, 30], [30, 0], [0, 0]]] },
});

function mount() {
  const host = document.createElement("div");
  host.style.width = "200px"; host.style.height = "200px";
  document.body.appendChild(host);
  return host;
}

describe("geoMap projections + rotation", () => {
  it("setProjection re-projects features and resets the transform", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoEquirectangular().fitSize([200, 200], sphere), backend: "canvas" });
    await map.whenReady();
    map.layer("land", [land()], { fill: "rgb(0,128,0)", id: () => "L" });
    map.render();
    const before = (map as any).scene.drawables("land")[0].path.commands.length ?? 0;

    map.setProjection(geoOrthographic().fitSize([200, 200], sphere));
    expect((map as any).transform).toEqual({ k: 1, x: 0, y: 0 });
    // Re-projection produced a (different) path; just assert it still has geometry.
    const after = (map as any).scene.drawables("land")[0];
    expect(after).toBeTruthy();
    map.destroy();
  });

  it("enableRotation attaches a wheel handler and disableInteraction detaches it", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "canvas" });
    await map.whenReady();
    map.layer("land", [land()], { fill: "rgb(0,128,0)" });
    map.enableRotation();

    const scaleBefore = (map as any).projection.scale();
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect((map as any).projection.scale()).toBeGreaterThan(scaleBefore);

    map.disableInteraction();
    const scaleAfter = (map as any).projection.scale();
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect((map as any).projection.scale()).toBe(scaleAfter); // no longer listening
    map.destroy();
  });

  it("hideOnRotation drops the layer from the render only while rotating", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "canvas" });
    await map.whenReady();
    map.layer("land", [land()], { fill: "rgb(0,128,0)" });
    map.layer("dense", [land()], { fill: "rgb(0,0,200)", hideOnRotation: true });

    const names = () => (map as any).renderSpecs().map((s: any) => s.name);
    expect(names()).toContain("dense"); // visible at rest

    (map as any).rotating = true;
    expect(names()).not.toContain("dense"); // hidden mid-rotation
    expect(names()).toContain("land");

    (map as any).rotating = false;
    expect(names()).toContain("dense"); // back after release
    map.destroy();
  });
});
```

Note: the test reaches into private members (`scene`, `transform`, `projection`, `renderSpecs`) via `as any` — acceptable for white-box behavior tests in this repo's browser suites. If `path.commands` is not the actual drawable shape, simplify the first test to only assert the transform reset + that a drawable still exists (the re-projection itself is covered by rendering not throwing).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/d3gl && pnpm exec vitest run src/map/geo-map-globe.browser.test.ts`
Expected: FAIL (methods/behavior not yet wired, or — if Tasks 2–3 are already merged — PASS; in that case confirm it passes and proceed).

- [ ] **Step 3: Make it pass**

If any assertion fails due to internal shape mismatches (e.g. `drawables(...)[0].path.commands`), adjust the assertion to the actual drawable structure (inspect via `console.log((map as any).scene.drawables("land")[0])`). Do not weaken the three behaviors under test: transform reset on `setProjection`, wheel attach/detach, and `hideOnRotation` filtering.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/d3gl && pnpm exec vitest run src/map/geo-map-globe.browser.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/d3gl/src/map/geo-map-globe.browser.test.ts
git commit -m "test(map): cover setProjection, enableRotation, hideOnRotation"
```

---

## Task 5: Website `select` control type

**Files:**
- Modify: `website/src/examples/types.ts`
- Modify: `website/src/components/Example.tsx`

- [ ] **Step 1: Add the `select` variant to `ControlSpec`**

In `types.ts`, add a third member to the `ControlSpec` union (after the `range` member):

```ts
  | {
      type: "select";
      key: string;
      label: string;
      /** Option values (value === visible label). */
      options: string[];
      /** Default value (else options[0]). */
      value?: string;
    };
```

- [ ] **Step 2: Seed select defaults in `Example.tsx`**

In the `useState` options initializer, replace the seeding line:

```ts
      o[c.key] = c.type === "range" ? c.value : c.options[0];
```

with:

```ts
      o[c.key] =
        c.type === "range" ? c.value : c.type === "select" ? (c.value ?? c.options[0]) : c.options[0];
```

- [ ] **Step 3: Filter and render selects**

After the existing `segmented` / `ranges` derivations, change `segmented` to exclude selects and add a `selects` list:

```ts
  const selects = controls.filter((c) => c.type === "select") as Extract<
    ControlSpec,
    { type: "select" }
  >[];
  const segmented = controls.filter((c) => c.type !== "range" && c.type !== "select") as Extract<
    ControlSpec,
    { options: string[] }
  >[];
```

Update `hasControlsRow`:

```ts
  const hasControlsRow = segmented.length > 0 || ranges.length > 0 || selects.length > 0;
```

In the controls row JSX (inside the `hasControlsRow` block, alongside the `segmented.map(...)` and `ranges.map(...)`), add:

```tsx
            {selects.map((c) => (
              <label key={c.key} className="flex items-center gap-1.5">
                <span className="text-muted-foreground text-[11px]">{c.label}</span>
                <select
                  className="border-border bg-background text-foreground focus-visible:ring-outline/50 h-6 rounded-md border px-1.5 text-[11px] outline-none focus-visible:ring-2"
                  value={String(options[c.key])}
                  onChange={(e) => setOptions((o) => ({ ...o, [c.key]: e.target.value }))}
                >
                  {c.options.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </label>
            ))}
```

- [ ] **Step 4: Typecheck the website**

Run: `cd website && pnpm exec astro check --minimumSeverity error` (or `pnpm exec tsc --noEmit` if astro check is slow)
Expected: no errors in `types.ts` / `Example.tsx`.

- [ ] **Step 5: Commit**

```bash
git add website/src/examples/types.ts website/src/components/Example.tsx
git commit -m "feat(website): add select control type to the example harness"
```

---

## Task 6: Map-projections example (draw + harness wrapper)

**Files:**
- Create: `website/src/examples/map-projections/draw.ts`
- Create: `website/src/examples/map-projections/MapProjections.tsx`

- [ ] **Step 1: Write `draw.ts`**

```ts
// website/src/examples/map-projections/draw.ts
import {
  geoNaturalEarth1, geoEqualEarth, geoMercator, geoTransverseMercator,
  geoEquirectangular, geoConicConformal, geoConicEqualArea, geoConicEquidistant,
  geoAlbers, geoOrthographic, geoStereographic, geoAzimuthalEqualArea,
  geoAzimuthalEquidistant, geoGnomonic, type GeoProjection,
} from "d3-geo";
import { geoMap } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import type { ImperativeSetup } from "../types.js";
import { loadWorld, makeGraticule } from "../shared/geo-data.js";

const OCEAN = "#d4e6f5";
const LAND = "#e3e6ea";
const GRATICULE = "#c2d4e4";

interface ProjEntry { create: () => GeoProjection; spherical: boolean; }

/** d3-geo core projections. Spherical (azimuthal) ones rotate; the rest zoom. */
const PROJECTIONS: Record<string, ProjEntry> = {
  Orthographic: { create: geoOrthographic, spherical: true },
  Stereographic: { create: geoStereographic, spherical: true },
  "Azimuthal Equal Area": { create: geoAzimuthalEqualArea, spherical: true },
  "Azimuthal Equidistant": { create: geoAzimuthalEquidistant, spherical: true },
  Gnomonic: { create: geoGnomonic, spherical: true },
  "Natural Earth": { create: geoNaturalEarth1, spherical: false },
  "Equal Earth": { create: geoEqualEarth, spherical: false },
  Mercator: { create: geoMercator, spherical: false },
  "Transverse Mercator": { create: geoTransverseMercator, spherical: false },
  Equirectangular: { create: geoEquirectangular, spherical: false },
  "Conic Conformal": { create: geoConicConformal, spherical: false },
  "Conic Equal Area": { create: geoConicEqualArea, spherical: false },
  "Conic Equidistant": { create: geoConicEquidistant, spherical: false },
  Albers: { create: geoAlbers, spherical: false },
};

export const PROJECTION_NAMES = Object.keys(PROJECTIONS);
const DEFAULT = "Orthographic";

/**
 * Pick any d3-geo projection. Spherical projections (orthographic, azimuthal, …)
 * become a drag-to-rotate globe — each drag frame re-projects the land via
 * `projection.rotate(...)`; the wheel scales it. Flat projections use d3-zoom
 * pan/zoom. Switching projection calls `map.setProjection(...)`, which
 * re-projects the existing layers and resets the view.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const world = loadWorld();
  const graticule = makeGraticule();
  const fit = (name: string): GeoProjection =>
    fitProjection((PROJECTIONS[name] ?? PROJECTIONS[DEFAULT]!).create(), { type: "Sphere" }, width, height);

  const map = geoMap(host, { width, height, projection: fit(DEFAULT), backend });
  map.layer("ocean", [world.sphere], { fill: OCEAN });
  map.layer("graticule", [graticule], { stroke: GRATICULE, lineWidth: 0.5 });
  map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.5 });

  return {
    engine: map,
    // Switch projection on the existing map (re-projects layers, resets the view),
    // then enable the interaction the projection calls for.
    render: (options) => {
      const name = (options.projection as string) ?? DEFAULT;
      const entry = PROJECTIONS[name] ?? PROJECTIONS[DEFAULT]!;
      map.setProjection(fit(name));
      if (entry.spherical) map.enableRotation();
      else map.enableZoom([1, 8]);
      map.render();
    },
  };
};
```

- [ ] **Step 2: Write `MapProjections.tsx`**

```tsx
// website/src/examples/map-projections/MapProjections.tsx
import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup, PROJECTION_NAMES } from "./draw.js";
import type { ControlSpec } from "../types.js";

const controls: ControlSpec[] = [
  { type: "select", key: "projection", label: "Projection", options: PROJECTION_NAMES, value: "Orthographic" },
];

/** Harness wrapper: projection picker + rotatable globe driven by <Example>. */
export default function MapProjections() {
  return (
    <Example width={720} height={480} controls={controls}>
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
```

- [ ] **Step 3: Verify the example builds (typecheck via website build later in Task 8)**

Run: `cd website && pnpm exec tsc --noEmit`
Expected: no errors in `map-projections/`.

- [ ] **Step 4: Commit**

```bash
git add website/src/examples/map-projections/
git commit -m "feat(website): map-projections example (projection picker + rotatable globe)"
```

---

## Task 7: Docs page + sidebar entry

**Files:**
- Create: `website/src/content/docs/examples/map/map-projections.mdx`
- Modify: `website/astro.config.mjs`

- [ ] **Step 1: Write the MDX page**

```mdx
---
title: Map projections
description: Pick any d3-geo projection — spherical ones become a drag-to-rotate globe.
---

import ExampleCard from "../../../../components/ExampleCard.astro";
import MapProjections from "../../../../examples/map-projections/MapProjections.tsx";

Choose any d3-geo core projection from the dropdown. Spherical projections
(Orthographic, Stereographic, the Azimuthal family, Gnomonic) render as a
**rotatable globe** — drag to spin, scroll to zoom. The rest are flat maps with
d3-zoom pan/zoom. Switching projection calls `map.setProjection(...)`, which
re-projects the existing layers; spherical projections then `enableRotation()`,
flat ones `enableZoom()`.

<ExampleCard files={["map-projections/draw.ts"]}>
  <MapProjections client:visible slot="demo" />
</ExampleCard>

Dragging a globe re-projects the land on the CPU each frame. For dense layers,
mark them `hideOnRotation` so only the cheap layers move during the drag and the
full detail re-projects once on release.
```

- [ ] **Step 2: Add the sidebar entry**

In `astro.config.mjs`, in the Examples group's Map items (after the World map / GeoJSON / Heatmap entries — i.e. after the `{ label: "Heatmap", slug: "examples/map/heatmap" }` line), add:

```js
          { label: "Map projections", slug: "examples/map/map-projections" },
```

- [ ] **Step 3: Build the website (smoke)**

Run: `cd website && pnpm build`
Expected: build succeeds; `examples/map/map-projections` is generated.

- [ ] **Step 4: Playwright smoke (dev server)**

Run the dev server (`pnpm --filter @d3gl/website dev`) and verify with a short Playwright check (headless) that `/d3gl/examples/map/map-projections/`:
- renders a canvas inside `.d3gl-canvas`,
- the Projection `<select>` exists and lists 14 options,
- switching to "Mercator" and back to "Orthographic" does not throw (watch console).

Expected: page renders a globe; switching projections works on webgl/canvas/svg.

- [ ] **Step 5: Commit**

```bash
git add website/src/content/docs/examples/map/map-projections.mdx website/astro.config.mjs
git commit -m "feat(website): map-projections docs page + sidebar entry"
```

---

## Task 8: Changeset

**Files:**
- Create: `.changeset/map-projections-globe.md`

- [ ] **Step 1: Write the changeset**

```md
---
"@mapequation/d3gl": minor
---

Add map projection switching and a rotatable globe:

- `GeoMap.setProjection(projection)` re-projects existing layers against a new
  projection and resets the view.
- `GeoMap.enableRotation(opts?)` drag-rotates a spherical projection (versor
  trackball) and wheel-scales it, re-projecting on the CPU per frame.
- `BaseEngine.disableInteraction()` detaches the current pan/zoom or rotation.
- `LayerOptions.hideOnRotation` drops dense layers from the render during a
  rotation drag (they re-project and reappear on release).
```

- [ ] **Step 2: Commit**

```bash
git add .changeset/map-projections-globe.md
git commit -m "chore: changeset for map projections + rotatable globe"
```

---

## Final review

- [ ] Run the full test suite: `pnpm test` (node + browser) — all PASS.
- [ ] Typecheck everything: `pnpm typecheck`.
- [ ] Build the library: `pnpm build:lib`.
- [ ] Build the website: `pnpm --filter @d3gl/website build`.
- [ ] Manual: open the example, spin the globe on each backend (webgl/canvas/svg), switch to a flat projection (zoom/pan works), switch back (globe re-fits), and export (PNG for webgl/canvas, SVG for svg).
- [ ] Dispatch a final code reviewer over the whole diff, then use superpowers:finishing-a-development-branch.
