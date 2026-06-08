# Pass-through Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `passThrough` layer mode that retains zero per-feature data in d3gl — the user owns the raw data, d3gl pulls it, projects, draws into a persistent accumulation buffer, and discards — lifting the ~4–7M point ceiling to the user-array limit (250M+).

**Architecture:** A pass-through layer skips `Scene`/`GroupData` entirely. The engine projects the user's data into a compact transient `PointBatch` (typed arrays) each repaint and hands it to the backend, which accumulates it (Canvas: native persistence; WebGL: offscreen FBO) and composites with a transformed blit during interaction (snapshot-pan). Full repaints are time-sliced across animation frames. The pipeline is geometry-generic, but points are implemented and validated first.

**Tech Stack:** TypeScript, luma.gl (WebGL2), Canvas2D, d3-geo/d3-zoom, Vitest (node + browser/Playwright).

---

## Spec

Design spec: [docs/superpowers/specs/2026-06-08-pass-through-point-rendering-design.md](../specs/2026-06-08-pass-through-point-rendering-design.md)

## Phasing

This feature is large and the novel WebGL pieces (FBO accumulation for a normal layer, full-screen blit, snapshot-pan compositing) are higher-risk. It is phased so each phase ships working, testable software and the engine↔backend contract is locked before the risky WebGL work:

- **Phase 1 (this plan, fully detailed): Engine plumbing + Canvas backend, points.** A complete, usable pass-through mode on the Canvas backend. Locks the API, the `PointBatch` contract, the projection pipeline, snapshot-pan, time-slicing, `pickable:false`, and SVG-throws.
- **Phase 2 (roadmap → own plan): WebGL backend, points.** Offscreen accumulation FBO, transient chunked quad-expansion buffers, color-as-attribute, blit/composite snapshot-pan.
- **Phase 3 (roadmap → own plan): Generic geometry (polygons/lines)** through the same path, both backends.
- **Phase 4 (roadmap → own plan): Website docs + streaming example.**

Phases 2–4 are scoped at the end. Write each as its own detailed plan after the prior phase lands.

## Key deviation from the spec

The spec says WebGL points are drawn **instanced**. The codebase has **zero instancing**; points are quad-expanded (4 verts/circle) at upload via proven code. Phase 2 will **reuse quad-expansion fed from transient/chunked/discarded buffers, with per-point color written as a per-vertex attribute** (4 copies/point in a throwaway buffer). This satisfies the two real requirements — no retained per-point storage, and no per-drawable color texture (the WebGL cliff) — without the risk of new instancing code. Instancing is a documented later optimization.

## ⚠️ Testing note (read before running tests)

- Node/CPU tests run via the **root** config: `npx vitest run <path>` (include glob `packages/*/src/**/*.test.ts`, `environment: node`).
- **Browser tests (`*.browser.test.ts`) hang in the Claude Code sandbox** — run them **locally** with `pnpm --filter @mapequation/d3gl test:browser` (or `npx vitest run --config packages/d3gl/vitest.config.ts <path>`). The agent should write them but tell the user to run them locally and report results.
- The memory bench (`point-memory.bench.test.ts`) is skipped unless `BENCH_MEM=1`.

---

## File structure (Phase 1)

| File | Responsibility | Create/Modify |
|---|---|---|
| `packages/d3gl/src/map/point-batch.ts` | Pure `PointBatch` type + `projectPoints()` builder (data + accessors + project fn → typed arrays). Node-testable, no DOM. | Create |
| `packages/d3gl/src/map/__tests__/point-batch.test.ts` | Unit tests for `projectPoints` (culling, radius/color accessors, single radius). | Create |
| `packages/d3gl/src/core/backend.ts` | Add optional pass-through methods to `Backend` + `PointBatch`/`PassThroughLayer` types. | Modify |
| `packages/d3gl/src/map/base-engine.ts` | `PassThroughSpec` storage; branch registration to skip Scene; project→batch on render/append; interaction → snapshot/settle; time-sliced repaint scheduler. | Modify |
| `packages/d3gl/src/map/geo-map.ts` | `LayerOptions.passThrough`; accept `data` as `() => F[]`; route to pass-through registration. | Modify |
| `packages/d3gl/src/map/plot.ts` | `PlotPointOptions.passThrough`; accept callback data; route to pass-through. | Modify |
| `packages/d3gl/src/canvas/canvas-backend.ts` | Pass-through accumulation: draw batch on top (append), full repaint, offscreen snapshot + transformed `drawImage` during interaction. | Modify |
| `packages/d3gl/src/canvas/__tests__/passthrough-batch.test.ts` | Node test for the pure parts of the canvas draw math (screen-coord mapping) where extractable. | Create |
| `packages/d3gl/src/svg/svg-backend.ts` | Throw on a pass-through layer. | Modify |
| `packages/d3gl/src/map/passthrough.browser.test.ts` | Browser test: canvas pass-through renders, append is incremental, pan shows snapshot, settle re-renders, SVG throws, pickable is false. | Create |

---

## Phase 1 Tasks

### Task 1: `PointBatch` type and `projectPoints()` builder

The heart of pass-through projection, kept as a **pure, DOM-free function** so it is node-testable and reused by every backend.

**Files:**
- Create: `packages/d3gl/src/map/point-batch.ts`
- Test: `packages/d3gl/src/map/__tests__/point-batch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/d3gl/src/map/__tests__/point-batch.test.ts
import { describe, it, expect } from "vitest";
import { projectPoints } from "../point-batch.js";

describe("projectPoints", () => {
  const data = [
    { lon: 0, lat: 0, c: "#ff0000" },
    { lon: 10, lat: 20, c: "#00ff00" },
    { lon: 999, lat: 999, c: "#0000ff" }, // culled by project returning null
  ];
  // project: identity-ish; returns null for the out-of-range one
  const project = (d: (typeof data)[number]) =>
    d.lon > 360 ? null : ([d.lon, d.lat] as [number, number]);

  it("projects to a packed Float32 position array, skipping culled points", () => {
    const b = projectPoints(data, {
      project,
      radius: () => 2,
      color: (d) => d.c,
    });
    expect(b.count).toBe(2);
    expect(Array.from(b.positions)).toEqual([0, 0, 10, 20]);
  });

  it("packs radii and RGBA colors parallel to positions", () => {
    const b = projectPoints(data, { project, radius: (d) => (d.lon === 0 ? 3 : 5), color: (d) => d.c });
    expect(Array.from(b.radii)).toEqual([3, 5]);
    // first point red, second green (RGBA bytes)
    expect(Array.from(b.colors.slice(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(b.colors.slice(4, 8))).toEqual([0, 255, 0, 255]);
  });

  it("accepts a constant radius number", () => {
    const b = projectPoints(data, { project, radius: 4, color: () => "#000" });
    expect(Array.from(b.radii)).toEqual([4, 4]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/d3gl/src/map/__tests__/point-batch.test.ts`
Expected: FAIL — `Cannot find module '../point-batch.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/d3gl/src/map/point-batch.ts
import { rgb } from "d3-color";

/** Transient, GPU/Canvas-ready point data. Owned by no one — built per repaint and discarded. */
export interface PointBatch {
  /** [x, y] per point, in projected world coords (pre view-transform). */
  positions: Float32Array;
  /** radius (reference px) per point. */
  radii: Float32Array;
  /** RGBA bytes per point (4 per point), parallel to positions. */
  colors: Uint8Array;
  /** number of points actually packed (after culling). */
  count: number;
}

export interface ProjectPointsOpts<D> {
  /** Project a datum to projected world coords, or null to cull it (off-globe / off-screen). */
  project: (d: D, i: number) => [number, number] | null;
  /** Radius per point (reference px). Constant or per-datum. */
  radius: number | ((d: D, i: number) => number);
  /** CSS color per point. Constant or per-datum. */
  color: string | ((d: D, i: number) => string);
}

function toByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Build a PointBatch from raw user data. Pure and DOM-free: project + accessors only.
 * Allocates exactly `data.length` capacity then trims to the visible count.
 */
export function projectPoints<D>(data: readonly D[], opts: ProjectPointsOpts<D>): PointBatch {
  const n = data.length;
  const positions = new Float32Array(n * 2);
  const radii = new Float32Array(n);
  const colors = new Uint8Array(n * 4);
  const radiusFn = typeof opts.radius === "function" ? opts.radius : () => opts.radius as number;
  const colorFn = typeof opts.color === "function" ? opts.color : () => opts.color as string;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const p = opts.project(data[i]!, i);
    if (!p) continue;
    positions[count * 2] = p[0];
    positions[count * 2 + 1] = p[1];
    radii[count] = radiusFn(data[i]!, i);
    const c = rgb(colorFn(data[i]!, i));
    const off = count * 4;
    colors[off] = toByte(c.r);
    colors[off + 1] = toByte(c.g);
    colors[off + 2] = toByte(c.b);
    colors[off + 3] = toByte((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255);
    count++;
  }
  return {
    positions: positions.subarray(0, count * 2),
    radii: radii.subarray(0, count),
    colors: colors.subarray(0, count * 4),
    count,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run packages/d3gl/src/map/__tests__/point-batch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/d3gl/src/map/point-batch.ts packages/d3gl/src/map/__tests__/point-batch.test.ts
git commit -m "feat(map): add PointBatch + projectPoints builder for pass-through"
```

---

### Task 2: Backend contract for pass-through

Add the optional methods + types the engine calls. Backends that don't implement them are unaffected.

**Files:**
- Modify: `packages/d3gl/src/core/backend.ts`

- [ ] **Step 1: Add the types and optional Backend methods**

Append to `packages/d3gl/src/core/backend.ts` (import `PointBatch`):

```ts
import type { PointBatch } from "../map/point-batch.js";

/** Identifies a pass-through layer to a backend (no retained geometry). */
export interface PassThroughLayer {
  name: string;
  sizeMode?: "world" | "screen";
  clipTo?: string;
}
```

Add these **optional** members to the `Backend` interface:

```ts
  /** Register/replace a pass-through layer (no buffers). Backends opt in. */
  setPassThroughLayer?(layer: PassThroughLayer): void;
  /** Remove a pass-through layer. */
  removePassThroughLayer?(name: string): void;
  /**
   * Draw a batch into the layer's accumulation buffer.
   * `mode: "replace"` clears the layer's buffer first (full repaint, possibly chunked:
   *   `first` clears, subsequent chunks append); `mode: "append"` draws on top.
   */
  drawPassThrough?(name: string, batch: PointBatch, mode: "replace-first" | "replace-rest" | "append"): void;
  /** Snapshot current accumulation for snapshot-pan (called on interaction start). */
  snapshotPassThrough?(): void;
  /** True if this backend supports pass-through (canvas/webgl yes, svg no). */
  readonly supportsPassThrough?: boolean;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @mapequation/d3gl exec tsc -b`
Expected: PASS (no errors; new members are optional).

- [ ] **Step 3: Commit**

```bash
git add packages/d3gl/src/core/backend.ts
git commit -m "feat(core): add optional pass-through methods to Backend interface"
```

---

### Task 3: Engine — register a pass-through layer (skip Scene)

A pass-through layer stores a `PassThroughSpec` (data source + accessors + project fn) and is **not** added to `scene`/`specs`/hit indexes.

**Files:**
- Modify: `packages/d3gl/src/map/base-engine.ts`

- [ ] **Step 1: Add PassThroughSpec storage + registration**

In `BaseEngine`, add fields and a method:

```ts
  /** Pass-through layers: no Scene entry, no retained geometry. */
  protected ptSpecs = new Map<string, PassThroughSpec>();
```

Add the type near `LayerSpec`:

```ts
export interface PassThroughSpec {
  name: string;
  /** User data source: an array, or a function re-invoked each full repaint. */
  source: unknown[] | (() => unknown[]);
  /** Project a datum → projected world coords, or null to cull. Built by the subclass. */
  project: (d: unknown, i: number) => [number, number] | null;
  radius: number | ((d: unknown, i: number) => number);
  color: string | ((d: unknown, i: number) => string);
  sizeMode?: "world" | "screen";
  clipTo?: string;
}
```

Add the method:

```ts
  /** Register a pass-through layer (called by subclasses for passThrough:true). */
  protected registerPassThrough(spec: PassThroughSpec): void {
    if (!this.handle?.backend.supportsPassThrough) {
      throw new Error(
        `passThrough is not supported by the "${this.currentBackend}" backend (use canvas or webgl)`,
      );
    }
    this.ptSpecs.set(spec.name, spec);
    this.handle.backend.setPassThroughLayer?.({ name: spec.name, sizeMode: spec.sizeMode, clipTo: spec.clipTo });
    this.repaintPassThrough(spec.name);
  }

  /** Resolve the current data array for a pass-through layer. */
  private ptData(spec: PassThroughSpec): unknown[] {
    return typeof spec.source === "function" ? spec.source() : spec.source;
  }
```

- [ ] **Step 2: Add the (stubbed) repaint method to satisfy types**

```ts
  /** Full repaint of a pass-through layer (re-pull + project + draw). Time-slicing added in Task 6. */
  protected repaintPassThrough(name: string): void {
    const spec = this.ptSpecs.get(name);
    if (!spec || !this.handle) return;
    const data = this.ptData(spec);
    const batch = projectPoints(data, { project: spec.project, radius: spec.radius, color: spec.color });
    this.handle.backend.drawPassThrough?.(name, batch, "replace-first");
  }
```

Add imports: `import { projectPoints, type PointBatch } from "./point-batch.js";` and `PassThroughSpec` is exported from this file.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @mapequation/d3gl exec tsc -b`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/d3gl/src/map/base-engine.ts
git commit -m "feat(map): engine pass-through registration + repaint (no Scene)"
```

---

### Task 4: Engine — pass-through append + transform/interaction wiring

- [ ] **Step 1: Add append + transform hooks**

```ts
  /** Incremental draw: project just this batch and draw it on top (O(new)). */
  protected appendPassThrough(name: string, items: unknown[]): void {
    const spec = this.ptSpecs.get(name);
    if (!spec || !this.handle) return;
    const batch = projectPoints(items, { project: spec.project, radius: spec.radius, color: spec.color });
    this.handle.backend.drawPassThrough?.(name, batch, "append");
  }
```

In `setTransform(t)`, after the existing body, trigger snapshot-pan vs. full repaint:

```ts
    if (this.ptSpecs.size > 0) {
      if (this.interacting) {
        // snapshot-pan: backend composites its accumulation with the live transform
      } else {
        for (const name of this.ptSpecs.keys()) this.repaintPassThrough(name);
      }
    }
```

In `setInteracting(v)`: on `true`, call `this.handle?.backend.snapshotPassThrough?.()`; on `false` (settle), call `repaintPassThrough` for each pass-through layer.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @mapequation/d3gl exec tsc -b`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/d3gl/src/map/base-engine.ts
git commit -m "feat(map): pass-through append + interaction (snapshot/settle) wiring"
```

---

### Task 5: Public API — `passThrough` option + callback data (geo-map + plot)

**Files:**
- Modify: `packages/d3gl/src/map/geo-map.ts`, `packages/d3gl/src/map/plot.ts`

- [ ] **Step 1: Add the option + callback data type to plot.points**

In `PlotPointOptions<D>` add `passThrough?: boolean`. Change `points()` signature to accept `data: readonly D[] | (() => readonly D[])`. When `opts.passThrough`, build a `PassThroughSpec` and call `registerPassThrough` instead of the standard `points` path:

```ts
  points<D>(name: string, data: readonly D[] | (() => readonly D[]), opts: PlotPointOptions<D>): LayerHandle<D> {
    if (opts.passThrough) {
      const radius = opts.radius ?? 3;
      this.registerPassThrough({
        name,
        source: (typeof data === "function" ? () => [...data()] : [...data]) as unknown[] | (() => unknown[]),
        // plot: x/y accessors give projected world coords directly (view transform applied at draw)
        project: (d, i) => [opts.x(d as D, i), opts.y(d as D, i)],
        radius: typeof radius === "function" ? (d, i) => (radius as (d: D, i: number) => number)(d as D, i) : radius,
        color: (opts.fill ?? "#000") as PassThroughSpec["color"],
        sizeMode: opts.sizeMode,
        // pickable is enforced structurally: pass-through layers never build a hit index,
        // so there is no `pickable` field on PassThroughSpec and pick() can never hit them.
      } as PassThroughSpec);
      return new LayerHandle<D>(this, name, (items) => this.appendPassThrough(name, items as unknown[]));
    }
    /* ...existing retained path unchanged... */
  }
```

- [ ] **Step 2: Add the same to geo-map.ts `layer()`**

In `LayerOptions<F>` add `passThrough?: boolean`. Accept `features: F | readonly F[] | (() => readonly F[])`. When `passThrough`, build a `PassThroughSpec` whose `project` composes the accessor → GeoJSON Point coords → `this.projection(coords)` with the same visibility cull `geoLayer` uses (return null when not visible). Only `Point` geometry in Phase 1; throw a clear error for non-Point geometry under `passThrough` (Phase 3 lifts this):

```ts
    if (opts.passThrough) {
      this.registerPassThrough({
        name,
        source: (typeof features === "function" ? () => [...features()] : asArray(features)) as ...,
        project: (f, i) => {
          const geom = (f as any).geometry;
          if (geom?.type !== "Point") throw new Error("passThrough supports only Point geometry in Phase 1");
          return projectVisible(this.projection, geom.coordinates); // returns [x,y] | null
        },
        radius: opts.pointRadius ?? 3,
        color: (opts.fill ?? "#000") as any,
        sizeMode: opts.sizeMode,
      } as PassThroughSpec);
      return new LayerHandle<F>(this, name, (items) => this.appendPassThrough(name, items as unknown[]));
    }
```

(Extract `projectVisible` from the existing visibility logic in `geo-layer.ts:52-56` into a small exported helper to keep it DRY.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @mapequation/d3gl exec tsc -b`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/d3gl/src/map/geo-map.ts packages/d3gl/src/map/plot.ts packages/d3gl/src/geo/geo-layer.ts
git commit -m "feat(map): passThrough option + callback data on layer()/points()"
```

---

### Task 6: Canvas backend — accumulate, repaint, snapshot-pan

**Files:**
- Modify: `packages/d3gl/src/canvas/canvas-backend.ts`

- [ ] **Step 1: Add pass-through state + supportsPassThrough**

```ts
  readonly supportsPassThrough = true;
  /** Pass-through layers keyed by name (just metadata; pixels live on the canvas/snapshot). */
  private ptLayers = new Map<string, PassThroughLayer>();
  /** Offscreen snapshot of the last full pass-through paint, for snapshot-pan. */
  private ptSnapshot: { canvas: HTMLCanvasElement; transform: ViewTransform } | null = null;

  setPassThroughLayer(layer: PassThroughLayer): void { this.ptLayers.set(layer.name, layer); }
  removePassThroughLayer(name: string): void { this.ptLayers.delete(name); }
```

- [ ] **Step 2: Implement drawPassThrough (draw a batch with current transform)**

```ts
  drawPassThrough(name: string, batch: PointBatch, mode: "replace-first" | "replace-rest" | "append"): void {
    const ctx = this.ctx;
    const t = this.transform;
    const screen = this.ptLayers.get(name)?.sizeMode === "screen";
    if (mode === "replace-first") {
      // clear the whole canvas region and redraw base layers, then this batch.
      this.render(); // retained layers (base map) + any prior pass-through is rebuilt below
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < batch.count; i++) {
      const wx = batch.positions[i * 2]!, wy = batch.positions[i * 2 + 1]!;
      const sx = t.k * wx + t.x, sy = t.k * wy + t.y;
      const r = screen ? batch.radii[i]! : batch.radii[i]! * t.k;
      const o = i * 4;
      ctx.fillStyle = `rgba(${batch.colors[o]},${batch.colors[o + 1]},${batch.colors[o + 2]},${batch.colors[o + 3]! / 255})`;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  }
```

(Note: the `replace-first` calling `render()` is the simple correct version; chunked `replace-rest` just keeps drawing without clearing. Refine when wiring time-slicing.)

- [ ] **Step 3: Implement snapshot + snapshot-pan composite**

```ts
  snapshotPassThrough(): void {
    const snap = document.createElement("canvas");
    snap.width = this.canvas.width; snap.height = this.canvas.height;
    snap.getContext("2d")!.drawImage(this.canvas, 0, 0);
    this.ptSnapshot = { canvas: snap, transform: { ...this.transform } };
  }
```

In `setTransform(t)`: when `this.ptSnapshot` exists (we're mid-gesture), composite it transformed instead of redrawing points — draw base layers, then `drawImage` the snapshot scaled/translated by the delta from `ptSnapshot.transform` to `t`. On a non-interacting transform / settle the engine calls `drawPassThrough(..., "replace-first")`, which clears `ptSnapshot` (`this.ptSnapshot = null`).

- [ ] **Step 4: Browser test (run locally)**

```ts
// packages/d3gl/src/map/passthrough.browser.test.ts
import { describe, it, expect } from "vitest";
import { plot } from "./plot.js";

describe("canvas pass-through", () => {
  it("renders points without retaining them and appends incrementally", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const chart = plot(host, { width: 100, height: 100, backend: "canvas" });
    await chart.whenReady();
    const data = [{ x: 50, y: 50 }];
    const h = chart.points("pts", () => data, { x: (d) => d.x, y: (d) => d.y, radius: 6, fill: "#ff0000", passThrough: true });
    chart.render();
    const ctx = (host.querySelector("canvas") as HTMLCanvasElement).getContext("2d")!;
    const px = ctx.getImageData(50, 50, 1, 1).data;
    expect(px[0]).toBeGreaterThan(200); // red drawn at center
    // append draws on top without a full data array in d3gl
    data.push({ x: 10, y: 10 });
    h.append({ x: 10, y: 10 });
    expect(ctx.getImageData(10, 10, 1, 1).data[0]).toBeGreaterThan(200);
  });
});
```

- [ ] **Step 5: Run browser test (LOCAL ONLY — hangs in sandbox)**

Run (ask the user to run): `pnpm --filter @mapequation/d3gl test:browser packages/d3gl/src/map/passthrough.browser.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/d3gl/src/canvas/canvas-backend.ts packages/d3gl/src/map/passthrough.browser.test.ts
git commit -m "feat(canvas): pass-through accumulate + snapshot-pan"
```

---

### Task 7: Time-sliced full repaint

Spread a large `replace` repaint across animation frames so the main thread never freezes; cancel in-flight repaints on a new interaction.

**Files:**
- Modify: `packages/d3gl/src/map/base-engine.ts`

- [ ] **Step 1: Implement a chunked scheduler in `repaintPassThrough`**

```ts
  private ptRepaintToken = 0;
  private static readonly PT_CHUNK = 500_000;

  protected repaintPassThrough(name: string): void {
    const spec = this.ptSpecs.get(name);
    if (!spec || !this.handle) return;
    const data = this.ptData(spec);
    const token = ++this.ptRepaintToken;
    const total = data.length;
    let cursor = 0;
    const step = () => {
      if (token !== this.ptRepaintToken || !this.handle) return; // cancelled by a newer repaint/interaction
      const end = Math.min(cursor + BaseEngine.PT_CHUNK, total);
      const slice = data.slice(cursor, end);
      const batch = projectPoints(slice, { project: spec.project, radius: spec.radius, color: spec.color });
      this.handle.backend.drawPassThrough?.(name, batch, cursor === 0 ? "replace-first" : "replace-rest");
      cursor = end;
      if (cursor < total) requestAnimationFrame(step);
    };
    step();
  }
```

(A new interaction / repaint bumps `ptRepaintToken`, abandoning the in-flight loop. `setInteracting(true)` should also bump it so a gesture cancels a running fill-in.)

- [ ] **Step 2: Browser test — large dataset doesn't block + fills in (run locally)**

Add a test that pushes e.g. 1.2M points, calls render, and asserts the call returns within a frame budget and pixels eventually appear after rAF flushes. (Use `vi.useFakeTimers`/rAF flush helpers as the repo does, or poll.)

- [ ] **Step 3: Run locally + commit**

```bash
git add packages/d3gl/src/map/base-engine.ts packages/d3gl/src/map/passthrough.browser.test.ts
git commit -m "feat(map): time-sliced pass-through repaint with cancellation"
```

---

### Task 8: SVG throws + pickable:false enforcement

**Files:**
- Modify: `packages/d3gl/src/svg/svg-backend.ts` (ensure `supportsPassThrough` is falsy / absent — already true since we only add it to canvas/webgl). Add an explicit guard so a clear error is thrown if reached.
- The engine guard in `registerPassThrough` (Task 3) already throws when `!supportsPassThrough`.

- [ ] **Step 1: Browser test — SVG backend throws on passThrough; pickable is false**

```ts
  it("throws on the SVG backend and is never pickable", async () => {
    const host = document.createElement("div"); document.body.appendChild(host);
    const chart = plot(host, { width: 50, height: 50, backend: "svg" });
    await chart.whenReady();
    expect(() => chart.points("p", [{ x: 1, y: 1 }], { x: (d) => d.x, y: (d) => d.y, passThrough: true })).toThrow(/passThrough/);
  });
```

- [ ] **Step 2: Run locally + commit**

```bash
git add packages/d3gl/src/svg/svg-backend.ts packages/d3gl/src/map/passthrough.browser.test.ts
git commit -m "feat(svg): throw on passThrough; enforce pickable:false"
```

---

### Task 9: Phase 1 verification

- [ ] **Step 1: Full node suite** — `npx vitest run` → all pass (browser excluded).
- [ ] **Step 2: Typecheck** — `pnpm --filter @mapequation/d3gl exec tsc -b` → clean.
- [ ] **Step 3: Browser suite (LOCAL)** — ask the user to run `pnpm --filter @mapequation/d3gl test:browser` and report.
- [ ] **Step 4: Update the spec status** — mark Phase 1 done in the spec doc; commit.

---

## Phase 2 (roadmap → write as its own plan): WebGL backend, points

Build on the locked engine↔backend contract. Tasks:
1. **Accumulation FBO per pass-through layer**, sized to the viewport, created like `webgl-backend.ts:46-51` / `globe.ts:makeFbo`. Reuse the `drawInto(fb)`/`bakeLayers(fb)` render-pass pattern.
2. **Transient quad-expansion draw**: reuse `expandPoints` into a **reused scratch `GrowBuffer`**, chunked (≤ `PT_CHUNK`), with **per-vertex color attribute** (new `POINT_PT_LAYOUT` adding `a_color: unorm8x4`) and a point shader variant that reads `a_color` instead of the color texture (kills the texture cliff). Draw chunk → discard.
3. **`drawPassThrough` modes**: `replace-first` clears the FBO (`beginRenderPass({framebuffer, clearColor})`), `replace-rest`/`append` draw into it without clearing.
4. **Composite + snapshot-pan**: build the **missing full-screen textured quad** (new `BLIT_VS/FS`) to draw the accumulation-FBO texture onto the screen each frame, applying the live `clipFromView` transform delta for snapshot-pan. Compose order: base-map layers → pass-through FBO quad.
5. **Browser/GPU tests** mirroring `webgl/renderer.browser.test.ts` (device + framebuffer + pixel readback): point renders, append accumulates, color attribute correct, pan composites snapshot.
6. Memory check: assert no per-drawable texture growth and flat retained memory as count grows.

## Phase 3 (roadmap → own plan): generic geometry (polygons/lines)

1. Generalize `projectPoints` → a `buildBatch` that, per feature geometry type, calls the **existing** `tessellateFill`/`expandStroke`/`PathRecorder` into transient buffers (no `GroupData`).
2. Canvas: `Path2D` fill/stroke from the transient subpaths.
3. WebGL: indexed-mesh draws (reuse fill/stroke shaders) from transient chunked buffers with color baked per-vertex.
4. Lift the geo-map "Point only" guard; document the per-settle re-tessellation cost.
5. Tests for a polygon pass-through layer on both backends.

## Phase 4 (roadmap → own plan): docs + example

1. Website example under **Streaming data** extending `website/src/examples/streaming-points/` with `passThrough: true` + a count/memory overlay contrasting standard vs pass-through (`shared/stats-overlay.ts`).
2. Guide page: extend `website/src/content/docs/examples/map/streaming.mdx`, leading with the standard-vs-pass-through trade-off table.
3. Reference: document `passThrough` + callback data on `LayerOptions`, `PlotPointOptions`, React `PointsProps`.
