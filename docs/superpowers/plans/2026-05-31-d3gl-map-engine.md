# d3gl Map Engine (geo helpers + `@d3gl/map`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A d3-familiar, backend-agnostic `geoMap()` engine: declare GeoJSON layers with
d3-style accessors, switch backend (webgl/canvas/svg) live, clip layers, pan/zoom, hover,
and export — built on Plan 1 (core) + Plan 2 (backends). Plus a `geoLayer` geo helper that
projects **any** of the six GeoJSON geometry types into a Scene group.

**Architecture:** `geoLayer` (in `@d3gl/geo`) projects each feature once: points become
closed-arc dots, everything else goes through `geoPath`. The new `@d3gl/map` package owns a
`Scene`, the projection, the active `Backend`, a per-layer `HitIndex`, and d3-zoom glue. It
builds `RenderLayer[]` from the Scene and hands them to whichever backend is active;
switching backend re-attaches a DOM element and re-applies the same layers/transform.

**Tech stack:** TypeScript, d3-geo, d3-zoom, d3-selection, luma.gl (transitively via webgl
backend). Vitest browser mode for the engine (needs DOM + canvas + WebGL).

This is Plan 3 of 4. Depends on: `@d3gl/core` (`Scene.drawables`, `HitIndex`, `Backend`,
`RenderLayer`, `ViewTransform`), `@d3gl/canvas` (`CanvasBackend`), `@d3gl/svg`
(`SvgBackend`), `@d3gl/webgl` (`WebGLBackend`), `@d3gl/geo` (`featureGroup`,
`fitProjection`). Plan 4 (React + example) builds on this.

---

### Task 1: `geoLayer` — project any GeoJSON geometry into a Scene group (`@d3gl/geo`)

**Files:**
- Create: `packages/geo/src/geo-layer.ts`
- Modify: `packages/geo/src/index.ts`
- Test: `packages/geo/src/__tests__/geo-layer.test.ts` (Node)

Context: `featureGroup` (existing) handles fill/stroke via `geoPath`, but `geoPath` emits a
`Point` as `moveTo`+`arc` with no `closePath`, and the core fill pipeline only fills closed
subpaths — so points don't render. `geoLayer` handles all six geometry types: `Point`/
`MultiPoint` → closed-arc dots (projected then traced), all others → `geoPath`. It accepts
GeoJSON `Feature`s, raw geometries, or a `FeatureCollection`’s features.

- [ ] **Step 1: Write the failing test**

```ts
// packages/geo/src/__tests__/geo-layer.test.ts
import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { Scene } from "@d3gl/core";
import { geoLayer } from "../geo-layer.js";

const proj = geoEquirectangular().scale(50).translate([180, 90]);

function build(features: any[], opts: any) {
  const scene = new Scene();
  scene.group("g", geoLayer(features, proj, opts));
  return scene;
}

describe("geoLayer", () => {
  it("renders Point/MultiPoint as filled dots (closed subpaths)", () => {
    const scene = build(
      [
        { type: "Point", coordinates: [0, 0] },
        { type: "MultiPoint", coordinates: [[10, 10], [20, 20]] },
      ],
      { pointRadius: 4 },
    );
    const ds = scene.drawables("g");
    expect(ds.length).toBe(2);
    expect(ds[0]!.subpaths[0]!.closed).toBe(true);          // dot is fillable
    expect(ds[1]!.subpaths.length).toBeGreaterThanOrEqual(2); // two dots in one drawable
  });

  it("renders Polygon (closed) and LineString (open stroke)", () => {
    const scene = build(
      [
        { type: "Polygon", coordinates: [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]] },
        { type: "LineString", coordinates: [[0, 0], [10, 10], [20, 0]] },
      ],
      { lineWidth: 1 },
    );
    const ds = scene.drawables("g");
    expect(ds[0]!.subpaths[0]!.closed).toBe(true);   // polygon ring
    expect(ds[1]!.subpaths[0]!.closed).toBe(false);  // line is open
  });

  it("applies the id accessor", () => {
    const scene = build([{ type: "Point", coordinates: [0, 0] }], { id: () => "x" });
    expect(scene.drawables("g")[0]!.id).toBe("x");
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** From repo root: `corepack pnpm@9.15.9 test geo-layer` → FAIL.

- [ ] **Step 3: Implement** `packages/geo/src/geo-layer.ts`:

```ts
import { geoPath } from "d3-geo";
import type { GeoProjection } from "d3-geo";
import type { GroupBuilder, PathContext } from "@d3gl/core";
import type { GeoInput } from "./project.js";

export interface GeoLayerOptions<F> {
  id?: (feature: F, index: number) => string | number;
  /** Stroke width in projected px (Line/MultiLine and polygon outlines). */
  lineWidth?: number;
  /** Dot radius in projected px for Point/MultiPoint. */
  pointRadius?: number;
}

function geomOf(input: GeoInput): GeoJSON.Geometry | null {
  if (input.type === "Feature") return input.geometry;
  if (input.type === "FeatureCollection" || input.type === "GeometryCollection") return null;
  return input as GeoJSON.Geometry;
}

function dot(ctx: PathContext, x: number, y: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.closePath();
}

function drawFeature(ctx: PathContext, feature: GeoInput, projection: GeoProjection, radius: number): void {
  const geom = geomOf(feature);
  if (geom && geom.type === "Point") {
    const p = projection(geom.coordinates as [number, number]);
    if (p) dot(ctx, p[0], p[1], radius);
    return;
  }
  if (geom && geom.type === "MultiPoint") {
    for (const c of geom.coordinates) {
      const p = projection(c as [number, number]);
      if (p) dot(ctx, p[0], p[1], radius);
    }
    return;
  }
  // Everything else (Line/MultiLine/Polygon/MultiPolygon/Sphere/GeometryCollection/Feature).
  geoPath(projection, ctx)(feature as Parameters<ReturnType<typeof geoPath>>[0]);
}

/** A Scene.group builder projecting any GeoJSON geometry once. Points → filled dots. */
export function geoLayer<F extends GeoInput>(
  features: readonly F[],
  projection: GeoProjection,
  opts: GeoLayerOptions<F> = {},
): (g: GroupBuilder) => void {
  const radius = opts.pointRadius ?? 3;
  const drawOpts = opts.lineWidth != null ? { lineWidth: opts.lineWidth } : undefined;
  return (g) => {
    features.forEach((feature, i) => {
      const id = opts.id ? opts.id(feature, i) : i;
      g.drawable(id, (ctx: PathContext) => drawFeature(ctx, feature, projection, radius), drawOpts);
    });
  };
}
```

Export `geoLayer` and `GeoLayerOptions` from `index.ts`.

- [ ] **Step 4: Run, verify pass.** `corepack pnpm@9.15.9 test geo-layer` → pass; full `corepack pnpm@9.15.9 test` green.

- [ ] **Step 5: Commit:** `git commit -m "feat(geo): geoLayer — project any GeoJSON geometry (points as filled dots) into a Scene group"`

---

### Task 2: `@d3gl/map` package scaffold + backend factory

**Files:**
- Create: `packages/map/package.json`, `packages/map/tsconfig.json`, `packages/map/src/index.ts`, `packages/map/src/backend-factory.ts`, `packages/map/vitest.config.ts`
- Modify: root `tsconfig` references if present (check `tsconfig.json`/`tsconfig.base.json`); add `@d3gl/map` to the example later (Plan 4)
- Test: `packages/map/src/backend-factory.browser.test.ts`

`package.json` (mirror `@d3gl/geo`, add canvas/svg/webgl + d3 deps):
```json
{
  "name": "@d3gl/map",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "build": "tsc -b" },
  "dependencies": {
    "@d3gl/core": "workspace:*",
    "@d3gl/canvas": "workspace:*",
    "@d3gl/svg": "workspace:*",
    "@d3gl/webgl": "workspace:*",
    "@d3gl/geo": "workspace:*",
    "d3-geo": "^3.1.1",
    "d3-selection": "^3.0.0",
    "d3-zoom": "^3.0.0"
  },
  "devDependencies": {
    "@types/d3-geo": "^3.1.0",
    "@types/d3-selection": "^3.0.10",
    "@types/d3-zoom": "^3.0.8",
    "@types/geojson": "^7946.0.14",
    "@luma.gl/core": "^9.3.3",
    "@luma.gl/engine": "^9.3.3",
    "@luma.gl/webgl": "^9.3.3"
  }
}
```
`tsconfig.json` = copy `packages/geo/tsconfig.json`. `vitest.config.ts` = copy
`packages/geo/vitest.config.ts` (browser). After creating, run `corepack pnpm@9.15.9 install`.

Context: `WebGLBackend.create` is async; `CanvasBackend`/`SvgBackend` are sync. The factory
normalizes this to one async function that also creates the DOM element each backend needs
(a `<canvas>` for webgl/canvas; the host element itself for svg) and returns both.

- [ ] **Step 1: Write the failing browser test**

```ts
// packages/map/src/backend-factory.browser.test.ts
import { describe, it, expect } from "vitest";
import { createBackend } from "./backend-factory.js";

describe("createBackend", () => {
  it("creates a working backend + element for each type", async () => {
    for (const type of ["canvas", "svg", "webgl"] as const) {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const { backend, element } = await createBackend(type, host, 64, 64);
      expect(backend).toBeTruthy();
      expect(element).toBeTruthy();
      backend.destroy();
      host.remove();
    }
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `cd packages/map && corepack pnpm@9.15.9 exec vitest run --config vitest.config.ts backend-factory` → FAIL.

- [ ] **Step 3: Implement** `packages/map/src/backend-factory.ts`:

```ts
import type { Backend } from "@d3gl/core";
import { CanvasBackend } from "@d3gl/canvas";
import { SvgBackend } from "@d3gl/svg";
import { WebGLBackend } from "@d3gl/webgl";

export type BackendType = "webgl" | "canvas" | "svg";

export interface BackendHandle {
  backend: Backend;
  /** The DOM node the backend draws into (a <canvas> for raster, the host for svg). */
  element: HTMLElement;
}

function makeCanvas(host: HTMLElement, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.style.display = "block";
  host.appendChild(canvas);
  return canvas;
}

export async function createBackend(type: BackendType, host: HTMLElement, width: number, height: number): Promise<BackendHandle> {
  if (type === "canvas") {
    const canvas = makeCanvas(host, width, height);
    return { backend: new CanvasBackend(canvas, width, height), element: canvas };
  }
  if (type === "svg") {
    return { backend: new SvgBackend(host, width, height), element: host };
  }
  const canvas = makeCanvas(host, width, height);
  const backend = await WebGLBackend.create(canvas, { width, height });
  return { backend, element: canvas };
}
```

Export `createBackend`, `BackendType`, `BackendHandle` from `index.ts`.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit:** `git commit -m "feat(map): @d3gl/map scaffold + backend factory (webgl/canvas/svg)"`

---

### Task 3: `geoMap()` engine — layers, backend switch, transform, recolor, hover, zoom, export

**Files:**
- Create: `packages/map/src/geo-map.ts`
- Modify: `packages/map/src/index.ts`
- Test: `packages/map/src/geo-map.browser.test.ts`

Context: the engine owns a `Scene`, the projection, ordered layer specs, the active backend
(created via the factory; async), a per-layer `HitIndex`, the current `ViewTransform`, and
optional d3-zoom. `layer()` adds a spec, builds its Scene group via `geoLayer`, applies
fill/stroke accessors, and marks dirty; the next `render()` (re)builds `RenderLayer[]` and
pushes them to the backend. Hover inverts the screen point through the transform
(`projected = (screen - {x,y}) / k`) and queries layer `HitIndex`es top-down.

Engine structure (implement to satisfy the test; this is the required surface):

```ts
import { geoPath, type GeoProjection } from "d3-geo";
import { select } from "d3-selection";
import { zoom as d3zoom, type D3ZoomEvent } from "d3-zoom";
import { Scene, HitIndex, type RenderLayer, type ViewTransform } from "@d3gl/core";
import { geoLayer } from "@d3gl/geo";
import { createBackend, type BackendType, type BackendHandle } from "./backend-factory.js";

type Accessor<F, T> = T | ((f: F, i: number) => T);

export interface LayerOptions<F = any> {
  fill?: Accessor<F, string>;
  stroke?: Accessor<F, string>;
  lineWidth?: number;
  pointRadius?: number;
  clipTo?: string;
  id?: (f: F, i: number) => string | number;
}

export interface GeoMapOptions {
  width: number;
  height: number;
  projection: GeoProjection;
  backend?: BackendType;
}

export interface HoverHit { layer: string; id: string | number; feature: unknown; }

interface LayerSpec {
  name: string;
  features: any[];
  opts: LayerOptions;
  ids: (string | number)[];   // resolved per-feature ids (drawable order)
}

export class GeoMap {
  private scene = new Scene();
  private specs: LayerSpec[] = [];
  private hitIndexes = new Map<string, HitIndex>();
  private transform: ViewTransform = { k: 1, x: 0, y: 0 };
  private handle: BackendHandle | null = null;
  private ready: Promise<void>;
  private hoverCb: ((hit: HoverHit | null, ev: PointerEvent) => void) | null = null;

  constructor(private host: HTMLElement, private opts: GeoMapOptions) {
    this.ready = this.swapBackend(opts.backend ?? "webgl");
  }
  whenReady(): Promise<void> { return this.ready; }

  layer<F>(name: string, features: F | readonly F[], opts: LayerOptions<F> = {}): this {
    const list = Array.isArray(features) ? (features as F[]) : [features as F];
    const ids = list.map((f, i) => (opts.id ? opts.id(f, i) : i));
    this.scene.group(name, geoLayer(list as any[], this.opts.projection, {
      id: (_f, i) => ids[i]!, lineWidth: opts.lineWidth, pointRadius: opts.pointRadius,
    }));
    this.applyAccessors(name, list as any[], opts);
    this.specs = this.specs.filter((s) => s.name !== name).concat({ name, features: list as any[], opts, ids });
    this.hitIndexes.set(name, new HitIndex(this.scene.drawables(name)));
    this.pushLayers();
    return this;
  }

  recolor(name: string): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    this.applyAccessors(name, spec.features, spec.opts);
    this.handle?.backend.updateLayer(name, this.renderLayer(spec));
    this.render();
    return this;
  }

  setBackend(type: BackendType): this { this.ready = this.swapBackend(type); return this; }
  setTransform(t: ViewTransform): this {
    this.transform = t;
    this.handle?.backend.setTransform(t);
    this.render();
    return this;
  }
  enableZoom(extent: [number, number] = [1, 50]): this {
    const sel = select(this.host as Element);
    const behavior = d3zoom<Element, unknown>().scaleExtent(extent).on("zoom", (e: D3ZoomEvent<Element, unknown>) => {
      this.setTransform({ k: e.transform.k, x: e.transform.x, y: e.transform.y });
    });
    (sel as any).call(behavior);
    return this;
  }
  on(event: "hover", cb: (hit: HoverHit | null, ev: PointerEvent) => void): this {
    if (event === "hover") {
      this.hoverCb = cb;
      this.host.addEventListener("pointermove", this.onPointerMove);
      this.host.addEventListener("pointerleave", this.onPointerLeave);
    }
    return this;
  }

  pick(x: number, y: number): HoverHit | null {
    const px = (x - this.transform.x) / this.transform.k;
    const py = (y - this.transform.y) / this.transform.k;
    for (let i = this.specs.length - 1; i >= 0; i--) {        // topmost layer first
      const spec = this.specs[i]!;
      const id = this.hitIndexes.get(spec.name)?.pick(px, py);
      if (id != null) {
        const fi = spec.ids.indexOf(id);
        return { layer: spec.name, id, feature: fi >= 0 ? spec.features[fi] : null };
      }
    }
    return null;
  }

  render(): this { this.handle?.backend.render(); return this; }
  toSVG(): string { return this.handle?.backend.toSVG() ?? ""; }
  toPNG(): string { return this.handle?.backend.toPNG() ?? ""; }
  destroy(): void {
    this.host.removeEventListener("pointermove", this.onPointerMove);
    this.host.removeEventListener("pointerleave", this.onPointerLeave);
    this.handle?.backend.destroy();
    if (this.handle && this.handle.element !== this.host) this.handle.element.remove();
    this.handle = null;
  }

  // ---- internals ----
  private onPointerMove = (e: PointerEvent): void => {
    if (!this.hoverCb) return;
    const r = this.host.getBoundingClientRect();
    this.hoverCb(this.pick(e.clientX - r.left, e.clientY - r.top), e);
  };
  private onPointerLeave = (e: PointerEvent): void => { this.hoverCb?.(null, e); };

  private resolve<T>(a: Accessor<any, T> | undefined, f: any, i: number): T | undefined {
    return typeof a === "function" ? (a as (f: any, i: number) => T)(f, i) : a;
  }
  private applyAccessors(name: string, features: any[], opts: LayerOptions): void {
    features.forEach((f, i) => {
      const id = opts.id ? opts.id(f, i) : i;
      const fill = this.resolve(opts.fill, f, i);
      if (fill) this.scene.setFill(name, id, fill);
      const stroke = this.resolve(opts.stroke, f, i);
      if (stroke) this.scene.setStroke(name, id, stroke);
    });
  }
  private renderLayer(spec: LayerSpec): RenderLayer {
    return { name: spec.name, buffers: this.scene.buffers(spec.name), drawables: this.scene.drawables(spec.name), clipTo: spec.opts.clipTo };
  }
  private pushLayers(): void {
    const layers = this.specs.map((s) => this.renderLayer(s));
    this.handle?.backend.setLayers(layers);
    this.handle?.backend.setTransform(this.transform);
    this.render();
  }
  private async swapBackend(type: BackendType): Promise<void> {
    const old = this.handle;
    const next = await createBackend(type, this.host, this.opts.width, this.opts.height);
    old?.backend.destroy();
    if (old && old.element !== this.host) old.element.remove();
    this.handle = next;
    next.backend.setLayers(this.specs.map((s) => this.renderLayer(s)));
    next.backend.setTransform(this.transform);
    next.backend.render();
  }
}

export function geoMap(host: HTMLElement, opts: GeoMapOptions): GeoMap {
  return new GeoMap(host, opts);
}
```

Note for the implementer: `geoPath` import is unused in the snippet — drop it unless you use
it. The `as any` casts on heterogeneous GeoJSON arrays are acceptable here (the engine is
generic over feature shape); keep them localized. Ensure SVG-backend `clipTo` works:
because `swapBackend`/`pushLayers` re-`setLayers`, switching to SVG re-serializes with the
clip. `recolor` on the Canvas/SVG backends still calls `updateLayer` then `render` (full
redraw) — that's expected.

- [ ] **Step 1: Write the failing browser test**

```ts
// packages/map/src/geo-map.browser.test.ts
import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { geoMap } from "./geo-map.js";

const proj = () => geoEquirectangular().scale(50).translate([100, 100]);
const sqPoly = (x: number, y: number, s: number): GeoJSON.Feature => ({
  type: "Feature", properties: {},
  geometry: { type: "Polygon", coordinates: [[[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]]] },
});

describe("geoMap engine", () => {
  it("renders, recolors, switches backend, and hit-tests", async () => {
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);

    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    await map.whenReady();
    map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], {
      fill: (_f, i) => (i === 0 ? "rgb(255,0,0)" : "rgb(0,0,255)"),
      id: (_f, i) => `c${i}`,
    });
    map.render();

    // hit-test: pick within the projected bounds of one of the cells (center of map ~ [100,100]).
    const hit = map.pick(100, 100);
    expect(hit?.layer).toBe("cells");

    // recolor: no throw, returns engine
    map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], { fill: "rgb(0,255,0)", id: (_f, i) => `c${i}` });
    map.recolor("cells");

    // switch backends without throwing
    map.setBackend("svg");
    await map.whenReady();
    expect(host.querySelector("svg")).toBeTruthy();

    map.setBackend("webgl");
    await map.whenReady();
    expect(host.querySelector("canvas")).toBeTruthy();

    map.destroy();
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `cd packages/map && corepack pnpm@9.15.9 exec vitest run --config vitest.config.ts geo-map` → FAIL.

- [ ] **Step 3: Implement** `geo-map.ts` per the structure above. Adjust the hit-test
coordinate expectation in the test if the projected square doesn't cover `[100,100]` — pick
a point you compute from the projection (project a known lon/lat with `proj()` and pick
there). The test must end green.

- [ ] **Step 4: Run, verify pass.** Engine browser test green; full Node suite green.

- [ ] **Step 5: Commit:** `git commit -m "feat(map): geoMap engine — layers, backend switch, transform, recolor, hover, zoom, export"`

---

## Self-review notes
- Spec coverage: `geoLayer` covers all six geometry types (Task 1); `geoMap` provides
  declarative layers + d3 accessors, `setBackend` live switch, `setTransform`/`enableZoom`,
  `on("hover")` via `HitIndex`, `recolor`, `toSVG`/`toPNG` (Tasks 2–3).
- Type consistency: `RenderLayer`/`ViewTransform`/`HitIndex` from core; `geoLayer` from geo;
  `createBackend` from Task 2 used by the engine in Task 3.
- Async: `WebGLBackend.create` is async; the engine exposes `whenReady()` and re-applies
  layers/transform after every backend swap. React (Plan 4) awaits `whenReady`.
- Localized `as any` for heterogeneous GeoJSON feature arrays is intentional and contained
  to the engine boundary.
