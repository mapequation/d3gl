# Incremental Layer Append Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an incremental `LayerHandle.append(items)` so streamed batches (e.g. live species occurrences) project/build only the new items and re-push only the affected layer, instead of re-projecting and re-registering the whole layer.

**Architecture:** `layer()`/`points()` return a `LayerHandle` (was `this`). The handle closes over an engine-specific append closure. A new generic `BaseEngine.appendToLayer` does the plumbing: append drawables to the existing `Scene` group, extend the layer's `data`/`ids`, color only the new range, grow the `HitIndex`, and re-push just that layer (preferring an optional `Backend.appendToLayer` GPU seam, else `updateLayer`). For `GeoMap`, `spec.data` is the single source of truth that `rebuildLayers` re-projects on `setProjection`/rotation, so appended features survive projection changes.

**Tech Stack:** TypeScript, d3-geo, vitest (node + `@vitest/browser-playwright` for browser suites), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-06-07-incremental-layer-append-design.md`

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `packages/d3gl/src/core/scene.ts` | Retained scene + GPU buffer packing | Add `appendToGroup`, `drawableCount`; dup-id guard; extract shared `builderFor` |
| `packages/d3gl/src/core/hit-test.ts` | CPU hit-testing | Add `append(drawables)`; store `tolerance` on instance |
| `packages/d3gl/src/core/backend.ts` | Backend interface | Add optional `appendToLayer?(name, layer, addedFrom)` seam |
| `packages/d3gl/src/map/base-engine.ts` | Engine base | Add protected `appendToLayer`; refactor `applyAccessors(spec, start)` |
| `packages/d3gl/src/map/layer-handle.ts` (new) | Per-layer handle | `append` / `recolor` / `setClip` |
| `packages/d3gl/src/map/geo-map.ts` | Projected map engine | `layer()` returns handle; `appendFeatures`; `rebuildLayers` reads `spec.data` |
| `packages/d3gl/src/map/plot.ts` | Scatter/plot engine | `layer()`/`points()` return handle; `appendDrawables`/`appendPoints`; DRY build helpers |
| `packages/d3gl/src/map/index.ts` | Public exports | Export `LayerHandle` |
| `.changeset/incremental-layer-append.md` (new) | Release note | minor bump |

## Commands reference

- **Node unit tests (single file):** `pnpm exec vitest run <path>` (root config, node env, excludes `*.browser.test.ts`)
- **Full node suite:** `pnpm test`
- **Browser test (single file):** `pnpm --filter @mapequation/d3gl test:browser <path-relative-to-package>`
- **Typecheck:** `pnpm typecheck`

---

## Task 1: Scene — appendToGroup, drawableCount, dup-id guard

**Files:**
- Modify: `packages/d3gl/src/core/scene.ts`
- Test: `packages/d3gl/src/core/__tests__/scene-append.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/d3gl/src/core/__tests__/scene-append.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";

describe("Scene.appendToGroup", () => {
  it("appends drawables to an existing group, continuing ids and ranges", () => {
    const s = new Scene();
    s.group("g", (b) => b.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10)));
    expect(s.drawableCount("g")).toBe(1);

    s.appendToGroup("g", (b) => b.drawable("b", (ctx) => ctx.rect(20, 0, 10, 10)));
    expect(s.drawableCount("g")).toBe(2);

    const r0 = s.range("g", "a");
    const r1 = s.range("g", "b");
    expect(r0.fill.vertexOffset).toBe(0);
    expect(r1.fill.vertexOffset).toBe(4); // continues after "a"
    expect(r1.fill.indexOffset).toBe(6);

    const ds = s.drawables("g");
    expect(ds.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("produces the same buffers as an equivalent single group() build", () => {
    const built = new Scene();
    built.group("g", (b) => {
      b.point("a", 10, 20, 3);
      b.point("b", 30, 40, 2);
    });
    const appended = new Scene();
    appended.group("g", (b) => b.point("a", 10, 20, 3));
    appended.appendToGroup("g", (b) => b.point("b", 30, 40, 2));

    const x = built.buffers("g");
    const y = appended.buffers("g");
    expect(y.pointCount).toBe(x.pointCount);
    expect(y.drawableCount).toBe(x.drawableCount);
    expect(Array.from(y.pointCenters)).toEqual(Array.from(x.pointCenters));
  });

  it("throws on a duplicate drawable id (append and initial build)", () => {
    const s = new Scene();
    s.group("g", (b) => b.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10)));
    expect(() => s.appendToGroup("g", (b) => b.drawable("a", (ctx) => ctx.rect(0, 0, 5, 5)))).toThrow(/duplicate drawable id/);
    expect(() => s.group("h", (b) => { b.point("p", 0, 0, 1); b.point("p", 1, 1, 1); })).toThrow(/duplicate drawable id/);
  });

  it("throws when appending to an unknown group", () => {
    const s = new Scene();
    expect(() => s.appendToGroup("nope", () => {})).toThrow(/unknown group/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/d3gl/src/core/__tests__/scene-append.test.ts`
Expected: FAIL — `s.appendToGroup is not a function` / `s.drawableCount is not a function`.

- [ ] **Step 3: Implement in `scene.ts`**

Replace the `group` method (currently around lines 113–122) with a shared builder helper plus `group` + `appendToGroup`:

```ts
  /** Build (or rebuild) a named group. The callback registers drawables. */
  group(name: string, build: (g: GroupBuilder) => void): void {
    const data = new GroupData(this.tolerance);
    build(this.builderFor(data));
    this.groups.set(name, data);
  }

  /** Append more drawables to an existing group (vs group(), which replaces it).
   *  Drawable ids continue after the current ones; a duplicate id throws. */
  appendToGroup(name: string, build: (g: GroupBuilder) => void): void {
    build(this.builderFor(this.get(name)));
  }

  /** Number of drawables currently registered in a group. */
  drawableCount(name: string): number {
    return this.get(name).ranges.length;
  }

  private builderFor(data: GroupData): GroupBuilder {
    return {
      drawable: (id, draw, opts) => this.addDrawable(data, id, draw, opts),
      point: (id, x, y, radius) => this.addCircleDrawable(data, id, [[x, y]], radius),
      points: (id, centers, radius) => this.addCircleDrawable(data, id, centers, radius),
    };
  }
```

Add the dup-id guard as the first line inside `addDrawable` (after the signature, before `const recorder = ...`):

```ts
    if (data.idToDrawable.has(String(id))) throw new Error(`duplicate drawable id: ${String(id)}`);
```

Add the same guard as the first line inside `addCircleDrawable` (before `const drawableId = data.ranges.length;`):

```ts
    if (data.idToDrawable.has(String(id))) throw new Error(`duplicate drawable id: ${String(id)}`);
```

(`get(name)` already throws `unknown group: <name>`.)

- [ ] **Step 4: Run the new test**

Run: `pnpm exec vitest run packages/d3gl/src/core/__tests__/scene-append.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the FULL node suite (guard against the new dup-id throw regressing existing tests)**

Run: `pnpm test`
Expected: PASS. If any existing test now fails with `duplicate drawable id`, it relied on duplicate ids in one group — inspect that test; duplicates were always silently corrupting and should be fixed in the test, not by removing the guard.

- [ ] **Step 6: Commit**

```bash
git add packages/d3gl/src/core/scene.ts packages/d3gl/src/core/__tests__/scene-append.test.ts
git commit -m "feat(core): Scene.appendToGroup + drawableCount + dup-id guard"
```

---

## Task 2: HitIndex — incremental append

**Files:**
- Modify: `packages/d3gl/src/core/hit-test.ts`
- Test: `packages/d3gl/src/core/__tests__/hit-test.test.ts` (add a case)

- [ ] **Step 1: Add the failing test**

Append this `it` block inside the existing `describe("HitIndex", …)` in `packages/d3gl/src/core/__tests__/hit-test.test.ts`:

```ts
  it("append() makes new drawables pickable without disturbing existing ones", () => {
    const scene = new Scene();
    scene.group("g", (b) => b.point("a", 50, 50, 5));
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(50, 50)).toBe("a");

    scene.appendToGroup("g", (b) => b.point("b", 150, 150, 5));
    idx.append(scene.drawables("g").slice(1)); // only the appended drawable
    expect(idx.pick(150, 150)).toBe("b"); // new one hits
    expect(idx.pick(50, 50)).toBe("a");    // old one still hits
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/d3gl/src/core/__tests__/hit-test.test.ts`
Expected: FAIL — `idx.append is not a function`.

- [ ] **Step 3: Implement in `hit-test.ts`**

Change the class so the constructor stores `tolerance` and delegates entry-building to `append`. Replace the constructor (currently `constructor(drawables, tolerance = 1) { for (const d of drawables) { … this.entries.push(…) } }`) with:

```ts
export class HitIndex {
  private entries: Entry[] = [];

  constructor(drawables: readonly DrawableVector[], private readonly tolerance = 1) {
    this.append(drawables);
  }

  /** Add more drawables to the index (used by incremental layer append). */
  append(drawables: readonly DrawableVector[]): void {
    for (const d of drawables) {
      if ((d.flags & 1) === 0) continue; // hidden never hits
      const closed = d.subpaths.filter((s) => s.closed && s.points.length >= 6);
      const circles = d.circles;

      let [minX, minY, maxX, maxY] = bounds(d.subpaths);
      for (const c of circles) {
        if (c.x - c.r < minX) minX = c.x - c.r;
        if (c.x + c.r > maxX) maxX = c.x + c.r;
        if (c.y - c.r < minY) minY = c.y - c.r;
        if (c.y + c.r > maxY) maxY = c.y + c.r;
      }

      this.entries.push({
        id: d.id, minX, minY, maxX, maxY,
        filled: closed.length > 0,
        rings: closed.length > 0 ? groupRings(closed) : [],
        strokes: d.lineWidth > 0 ? d.subpaths : [],
        halfWidth: d.lineWidth / 2 + this.tolerance,
        circles,
        tolerance: this.tolerance,
      });
    }
  }
```

Leave the `pick(...)` method and everything below it unchanged.

- [ ] **Step 4: Run the test**

Run: `pnpm exec vitest run packages/d3gl/src/core/__tests__/hit-test.test.ts`
Expected: PASS (all cases, including the new one).

- [ ] **Step 5: Commit**

```bash
git add packages/d3gl/src/core/hit-test.ts packages/d3gl/src/core/__tests__/hit-test.test.ts
git commit -m "feat(core): HitIndex.append for incremental drawables"
```

---

## Task 3: Backend seam + BaseEngine.appendToLayer plumbing

This task is engine plumbing on an abstract base; it has no standalone unit (the base engine is only instantiable as `GeoMap`/`Plot`). Its behavior is exercised end-to-end by Tasks 5 and 6. Verification here is typecheck + the full node suite staying green (no behavior change to existing paths).

**Files:**
- Modify: `packages/d3gl/src/core/backend.ts`
- Modify: `packages/d3gl/src/map/base-engine.ts`

- [ ] **Step 1: Add the optional backend seam in `backend.ts`**

Inside the `Backend` interface, directly after the `updateLayer(name: string, layer: RenderLayer): void;` line, add:

```ts
  /**
   * Append-only fast path (optional). Same observable result as
   * `updateLayer(name, layer)`, but a backend MAY upload only the tail of each
   * buffer — the drawables/vertices added at or after `addedFrom` (the drawable
   * index where the appended range begins). Backends that don't implement this are
   * driven via `updateLayer` (full re-upload). No backend implements it yet.
   */
  appendToLayer?(name: string, layer: RenderLayer, addedFrom: number): void;
```

- [ ] **Step 2: Refactor `applyAccessors` in `base-engine.ts` to color a sub-range**

Replace the existing `private applyAccessors(spec: LayerSpec): void { … spec.data.forEach(…) }` with an indexed loop that starts at `start`:

```ts
  private applyAccessors(spec: LayerSpec, start = 0): void {
    // A spec has one id per datum, but the built group may have fewer drawables —
    // e.g. geoLayer culls back-hemisphere points on a globe, so those ids have no
    // drawable. Only color the ids actually present (setFill/Stroke throw on
    // unknown ids), which keeps the typo guard for genuinely-missing drawables.
    const present = new Set(this.scene.drawables(spec.name).map((dr) => dr.id));
    for (let i = start; i < spec.data.length; i++) {
      const d = spec.data[i]!;
      const id = spec.ids[i]!;
      if (!present.has(id)) continue;
      const fill = this.resolve(spec.fill, d, i);
      if (fill) this.scene.setFill(spec.name, id, fill);
      const stroke = this.resolve(spec.stroke, d, i);
      if (stroke) this.scene.setStroke(spec.name, id, stroke);
    }
  }
```

- [ ] **Step 3: Add the protected `appendToLayer` plumbing in `base-engine.ts`**

Add this method to `BaseEngine` (e.g. directly after `registerLayer`). `GroupBuilder` is already imported at the top of the file.

```ts
  /**
   * Append items to an already-registered layer: build only the new drawables,
   * extend the spec's data/ids, color the new range, grow the hit index, and
   * re-push just this layer. `ids` are caller-resolved (continuing the index or
   * honoring the layer's id accessor); a duplicate id throws via Scene.
   */
  protected appendToLayer(name: string, items: readonly any[], ids: (string | number)[], build: (g: GroupBuilder) => void): void {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) throw new Error(`unknown layer: ${name}`);
    if (items.length === 0) return;
    const drawOffset = this.scene.drawableCount(name); // drawables, not data (culling may differ)
    this.scene.appendToGroup(name, build);
    spec.data.push(...items);
    spec.ids.push(...ids);
    this.applyAccessors(spec, spec.data.length - items.length);
    this.hitIndexes.get(name)?.append(this.scene.drawables(name).slice(drawOffset));
    // Skip the GPU push for a layer hidden mid-interaction (mirrors recolor): the
    // gesture-end rebuild re-projects + re-pushes the full extended list.
    if (this.interacting && spec.hideOnInteraction) return;
    const rl = this.renderLayer(spec);
    const backend = this.handle?.backend;
    if (backend?.appendToLayer) backend.appendToLayer(name, rl, drawOffset);
    else backend?.updateLayer(name, rl);
    this.render();
  }
```

- [ ] **Step 4: Typecheck and full suite**

Run: `pnpm typecheck`
Expected: PASS (no type errors).

Run: `pnpm test`
Expected: PASS (unchanged count; this task does not alter existing behavior).

- [ ] **Step 5: Commit**

```bash
git add packages/d3gl/src/core/backend.ts packages/d3gl/src/map/base-engine.ts
git commit -m "feat(map): BaseEngine.appendToLayer plumbing + backend append seam"
```

---

## Task 4: LayerHandle

**Files:**
- Create: `packages/d3gl/src/map/layer-handle.ts`
- Modify: `packages/d3gl/src/map/index.ts`
- Test: `packages/d3gl/src/map/__tests__/layer-handle.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/d3gl/src/map/__tests__/layer-handle.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { LayerHandle } from "../layer-handle.js";
import type { BaseEngine } from "../base-engine.js";

function fakeEngine() {
  return { recolor: vi.fn(), setClip: vi.fn() } as unknown as BaseEngine;
}

describe("LayerHandle", () => {
  it("wraps a single item into an array and forwards a batch as-is", () => {
    const appendImpl = vi.fn();
    const h = new LayerHandle(fakeEngine(), "occ", appendImpl);
    h.append({ id: 1 });
    h.append([{ id: 2 }, { id: 3 }]);
    expect(appendImpl).toHaveBeenNthCalledWith(1, [{ id: 1 }]);
    expect(appendImpl).toHaveBeenNthCalledWith(2, [{ id: 2 }, { id: 3 }]);
  });

  it("append returns the handle (chainable) and forwards an empty batch", () => {
    const appendImpl = vi.fn();
    const h = new LayerHandle(fakeEngine(), "occ", appendImpl);
    expect(h.append([])).toBe(h);
    expect(appendImpl).toHaveBeenCalledWith([]);
  });

  it("delegates recolor and setClip to the engine by name", () => {
    const engine = fakeEngine();
    const h = new LayerHandle(engine, "occ", vi.fn());
    h.recolor();
    h.setClip("land");
    expect(engine.recolor).toHaveBeenCalledWith("occ");
    expect(engine.setClip).toHaveBeenCalledWith("occ", "land");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/d3gl/src/map/__tests__/layer-handle.test.ts`
Expected: FAIL — cannot find module `../layer-handle.js`.

- [ ] **Step 3: Create `packages/d3gl/src/map/layer-handle.ts`**

```ts
import type { BaseEngine } from "./base-engine.js";

/**
 * A handle to one registered layer, returned by `GeoMap.layer`, `Plot.layer`, and
 * `Plot.points`. Lets you stream more data into the layer via {@link append} without
 * re-projecting or re-building the features already in it.
 */
export class LayerHandle<D = any> {
  constructor(
    private readonly engine: BaseEngine,
    /** The layer's name. */
    readonly name: string,
    private readonly appendImpl: (items: readonly D[]) => void,
  ) {}

  /**
   * Append one item or a batch to this layer. Only the new items are built/projected;
   * existing geometry is untouched. An empty batch is a no-op downstream.
   */
  append(items: D | readonly D[]): this {
    this.appendImpl(Array.isArray(items) ? (items as readonly D[]) : [items as D]);
    return this;
  }

  /** Re-apply this layer's fill/stroke accessors (e.g. after mutating bound data). */
  recolor(): this {
    this.engine.recolor(this.name);
    return this;
  }

  /** Set or clear the clip mask for this layer. */
  setClip(clipTo?: string): this {
    this.engine.setClip(this.name, clipTo);
    return this;
  }
}
```

- [ ] **Step 4: Export it from `packages/d3gl/src/map/index.ts`**

Add (matching the file's existing export style):

```ts
export { LayerHandle } from "./layer-handle.js";
```

- [ ] **Step 5: Run the test**

Run: `pnpm exec vitest run packages/d3gl/src/map/__tests__/layer-handle.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/d3gl/src/map/layer-handle.ts packages/d3gl/src/map/index.ts packages/d3gl/src/map/__tests__/layer-handle.test.ts
git commit -m "feat(map): LayerHandle (append/recolor/setClip)"
```

---

## Task 5: GeoMap — return handle, appendFeatures, rebuild from spec.data

**Files:**
- Modify: `packages/d3gl/src/map/geo-map.ts`
- Test: `packages/d3gl/src/map/geo-map-append.browser.test.ts` (create)

- [ ] **Step 1: Write the failing browser test**

Create `packages/d3gl/src/map/geo-map-append.browser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { geoEquirectangular, geoOrthographic } from "d3-geo";
import { geoMap } from "./geo-map.js";

const proj = () => geoEquirectangular().scale(50).translate([100, 100]);
const pt = (lon: number, lat: number): GeoJSON.Feature => ({
  type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lon, lat] },
});

function mount() {
  const host = document.createElement("div");
  host.style.width = "200px"; host.style.height = "200px";
  document.body.appendChild(host);
  return host;
}

describe("GeoMap incremental append", () => {
  it("appends points that become pickable while existing ones are kept", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    await map.whenReady();

    const occ = map.layer("occ", [pt(0, 0)], { pointRadius: 4, fill: "rgb(255,0,0)", id: (f) => `o${(f.geometry as any).coordinates[0]}` });
    map.render();
    expect(map.pick(100, 100)?.id).toBe("o0"); // proj([0,0]) = [100,100]

    occ.append(pt(20, 0)); // proj([20,0]) = [110,100]
    map.render();
    expect(map.pick(110, 100)?.id).toBe("o20"); // appended point hits
    expect(map.pick(100, 100)?.id).toBe("o0");  // original still hits

    map.destroy();
  });

  it("keeps appended features after setProjection", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    await map.whenReady();
    const occ = map.layer("occ", [pt(0, 0)], { pointRadius: 4, fill: "rgb(255,0,0)", id: (f) => `o${(f.geometry as any).coordinates[0]}` });
    occ.append(pt(20, 0));

    // Switch projection; appended feature must survive the rebuild.
    map.setProjection(geoOrthographic().scale(50).translate([100, 100]));
    map.render();
    // Orthographic with default rotation [0,0]: lon/lat 0 and 20 are on the front
    // hemisphere, so both project. Pick near projected [20,0].
    const p = geoOrthographic().scale(50).translate([100, 100])([20, 0])!;
    expect(map.pick(Math.round(p[0]), Math.round(p[1]))?.id).toBe("o20");
    map.destroy();
  });

  it("throws on duplicate id append", async () => {
    const host = mount();
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
    await map.whenReady();
    const occ = map.layer("occ", [pt(0, 0)], { id: () => "dup" });
    expect(() => occ.append(pt(20, 0))).toThrow(/duplicate drawable id/);
    map.destroy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @mapequation/d3gl test:browser src/map/geo-map-append.browser.test.ts`
Expected: FAIL — `occ.append is not a function` (today `layer()` returns the engine).

- [ ] **Step 3: Edit `geo-map.ts`**

Add the import at the top:

```ts
import { LayerHandle } from "./layer-handle.js";
```

Change `LayerDef` to drop the stored list (single source of truth becomes `spec.data`):

```ts
interface LayerDef { name: string; opts: LayerOptions; }
```

Replace the `layer` method with one that records only `{ name, opts }`, registers, and returns a handle:

```ts
  layer<F>(name: string, features: F | readonly F[], opts: LayerOptions<F> = {}): LayerHandle<F> {
    const list = Array.isArray(features) ? (features as F[]) : [features as F];
    this.defs = this.defs.filter((d) => d.name !== name).concat({ name, opts });
    this.registerLayer(this.buildSpec(name, list, opts));
    return new LayerHandle<F>(this, name, (items) => this.appendFeatures(name, items, opts));
  }

  /** Project only the new features against the current projection and append them.
   *  spec.data (extended by appendToLayer) is the rebuild source, so appended
   *  features survive setProjection / rotation. */
  private appendFeatures<F>(name: string, items: readonly F[], opts: LayerOptions<F>): void {
    if (items.length === 0) return;
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) throw new Error(`unknown layer: ${name}`);
    const offset = spec.data.length;
    const ids = items.map((f, j) => (opts.id ? opts.id(f, offset + j) : offset + j));
    const build = geoLayer(items, this.projection, {
      id: (_f, j) => ids[j]!, lineWidth: opts.lineWidth, pointRadius: opts.pointRadius, sizeMode: opts.sizeMode,
    });
    this.appendToLayer(name, items, ids, build);
  }
```

Replace `rebuildLayers` so it re-projects the layer's current accumulated data (`spec.data`) rather than a separately-stored list:

```ts
  /** Re-register layers against the current projection (re-project once). During a
   *  rotation drag, skipHidden avoids re-projecting hideOnInteraction layers. */
  private rebuildLayers(o: { skipHidden?: boolean } = {}): void {
    for (const def of this.defs) {
      if (o.skipHidden && def.opts.hideOnInteraction) continue;
      const spec = this.specs.find((s) => s.name === def.name);
      if (!spec) continue;
      this.registerLayer(this.buildSpec(def.name, spec.data, def.opts));
    }
  }
```

Leave `buildSpec`, `setProjection`, and `enableRotation` unchanged. (`buildSpec` recomputes `ids` as `opts.id ? opts.id(f, i) : i` over the full data, which matches the `offset + j` ids assigned at append time — so identity is stable across rebuilds.)

- [ ] **Step 4: Run the browser test**

Run: `pnpm --filter @mapequation/d3gl test:browser src/map/geo-map-append.browser.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the existing GeoMap/globe browser tests (rotation + setProjection still work after the rebuild refactor)**

Run: `pnpm --filter @mapequation/d3gl test:browser src/map/geo-map.browser.test.ts src/map/geo-map-globe.browser.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/d3gl/src/map/geo-map.ts packages/d3gl/src/map/geo-map-append.browser.test.ts
git commit -m "feat(map): GeoMap.layer returns LayerHandle with incremental append"
```

---

## Task 6: Plot — return handle, append points + drawables (DRY)

**Files:**
- Modify: `packages/d3gl/src/map/plot.ts`
- Test: `packages/d3gl/src/map/plot-append.browser.test.ts` (create)

- [ ] **Step 1: Write the failing browser test**

Create `packages/d3gl/src/map/plot-append.browser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { PathContext } from "../core/index.js";
import { plot } from "./plot.js";

function mount() {
  const host = document.createElement("div");
  host.style.width = "200px"; host.style.height = "200px";
  document.body.appendChild(host);
  return host;
}

describe("Plot incremental append", () => {
  it("points().append adds pickable points, keeps existing ones", async () => {
    const host = mount();
    const chart = plot(host, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    const pts = chart.points("p", [{ x: 40, y: 40 }], { radius: 5, fill: "rgb(255,0,0)", id: (d) => `p${d.x}` });
    chart.render();
    expect(chart.pick(40, 40)?.id).toBe("p40");

    pts.append({ x: 140, y: 140 });
    chart.render();
    expect(chart.pick(140, 140)?.id).toBe("p140"); // appended
    expect(chart.pick(40, 40)?.id).toBe("p40");     // original kept
    chart.destroy();
  });

  it("layer().append adds pickable drawables", async () => {
    const host = mount();
    const chart = plot(host, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    const boxes = chart.layer("b", [{ x: 20, y: 20 }], {
      draw: (ctx: PathContext, d) => ctx.rect(d.x, d.y, 40, 40),
      fill: "rgb(0,0,255)", id: (d) => `b${d.x}`,
    });
    boxes.append({ x: 120, y: 120 });
    chart.render();
    expect(chart.pick(40, 40)?.id).toBe("b20");
    expect(chart.pick(140, 140)?.id).toBe("b120");
    chart.destroy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @mapequation/d3gl test:browser src/map/plot-append.browser.test.ts`
Expected: FAIL — `pts.append is not a function`.

- [ ] **Step 3: Rewrite `plot.ts` to return handles and DRY the build closures**

Add the import at the top:

```ts
import { LayerHandle } from "./layer-handle.js";
```

Replace the `Plot` class body (`layer` and `points`) with handle-returning versions plus shared build helpers:

```ts
export class Plot extends BaseEngine {
  constructor(host: HTMLElement, opts: PlotOptions) { super(host, opts.width, opts.height, opts.backend ?? "webgl"); }

  layer<D>(name: string, data: readonly D[], opts: PlotLayerOptions<D>): LayerHandle<D> {
    const list = data as D[];
    const ids = list.map((d, i) => (opts.id ? opts.id(d, i) : i));
    this.registerLayer({ name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo, sizeMode: opts.sizeMode, declutter: opts.declutter, build: this.buildDrawables(list, ids, 0, opts) });
    return new LayerHandle<D>(this, name, (items) => this.appendDrawables(name, items, opts));
  }

  points<D>(name: string, data: readonly D[], opts: PlotPointOptions<D>): LayerHandle<D> {
    const list = data as D[];
    const ids = list.map((d, i) => (opts.id ? opts.id(d, i) : i));
    this.registerLayer({ name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo, sizeMode: opts.sizeMode, build: this.buildPoints(list, ids, 0, opts) });
    return new LayerHandle<D>(this, name, (items) => this.appendPoints(name, items, opts));
  }

  private appendDrawables<D>(name: string, items: readonly D[], opts: PlotLayerOptions<D>): void {
    if (items.length === 0) return;
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) throw new Error(`unknown layer: ${name}`);
    const base = spec.data.length;
    const ids = items.map((d, j) => (opts.id ? opts.id(d, base + j) : base + j));
    this.appendToLayer(name, items, ids, this.buildDrawables(items, ids, base, opts));
  }

  private appendPoints<D>(name: string, items: readonly D[], opts: PlotPointOptions<D>): void {
    if (items.length === 0) return;
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) throw new Error(`unknown layer: ${name}`);
    const base = spec.data.length;
    const ids = items.map((d, j) => (opts.id ? opts.id(d, base + j) : base + j));
    this.appendToLayer(name, items, ids, this.buildPoints(items, ids, base, opts));
  }

  /** Build a chunk of context-draw drawables. `base` is the global index of items[0]
   *  (0 for the initial layer, current length for an append) so user accessors see a
   *  stable index. */
  private buildDrawables<D>(items: readonly D[], ids: (string | number)[], base: number, opts: PlotLayerOptions<D>): (g: GroupBuilder) => void {
    const lw = opts.lineWidth;
    const widthOf = typeof lw === "function" ? lw : (_d: D, _i: number) => lw as number;
    const anchorOf = opts.anchor;
    // d3gl's PathContext implements the path-building subset d3 generators use; present
    // it as CanvasRenderingContext2D so user draw code needs no cast. Single cast here.
    return (g) =>
      items.forEach((d, j) =>
        g.drawable(
          ids[j]!,
          (ctx: PathContext) => opts.draw(ctx as unknown as CanvasRenderingContext2D, d, base + j),
          lw != null || anchorOf ? { lineWidth: lw != null ? widthOf(d, base + j) : 0, anchor: anchorOf?.(d, base + j) } : undefined,
        ),
      );
  }

  /** Build a chunk of point drawables (see buildDrawables for `base`). */
  private buildPoints<D>(items: readonly D[], ids: (string | number)[], base: number, opts: PlotPointOptions<D>): (g: GroupBuilder) => void {
    const resolveRadius = typeof opts.radius === "function" ? opts.radius : (_d: D, _i: number) => (opts.radius as number | undefined) ?? 3;
    return (g) => items.forEach((d, j) => g.point(ids[j]!, opts.x(d, base + j), opts.y(d, base + j), resolveRadius(d, base + j)));
  }
}
export function plot(host: HTMLElement, opts: PlotOptions): Plot { return new Plot(host, opts); }
```

Add `GroupBuilder` to the existing core import at the top of `plot.ts`. The current line is:

```ts
import type { GroupBuilder, PathContext } from "../core/index.js";
```

(It already imports `GroupBuilder` and `PathContext` — no change needed; verify it is present.)

- [ ] **Step 4: Run the browser test**

Run: `pnpm --filter @mapequation/d3gl test:browser src/map/plot-append.browser.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run existing Plot browser tests (no regression)**

Run: `pnpm --filter @mapequation/d3gl test:browser src/map/plot.browser.test.ts src/map/__tests__/plot.browser.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck (React wrappers ignore the now-handle return value — confirm no type break)**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/d3gl/src/map/plot.ts packages/d3gl/src/map/plot-append.browser.test.ts
git commit -m "feat(map): Plot.layer/points return LayerHandle with incremental append"
```

---

## Task 7: Changeset + full verification

**Files:**
- Create: `.changeset/incremental-layer-append.md`

- [ ] **Step 1: Write the changeset**

Create `.changeset/incremental-layer-append.md`:

```md
---
"@mapequation/d3gl": minor
---

Add incremental layer append for live-streaming data:

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
```

- [ ] **Step 2: Full node suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Full browser suite**

Run: `pnpm --filter @mapequation/d3gl test:browser`
Expected: PASS.

- [ ] **Step 4: Typecheck + build the library**

Run: `pnpm typecheck && pnpm build:lib`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add .changeset/incremental-layer-append.md
git commit -m "chore: changeset for incremental layer append"
```

---

## Self-review notes

- **Spec coverage:** Scene.appendToGroup (T1), HitIndex.append (T2), Backend seam + BaseEngine.appendToLayer + applyAccessors range (T3), LayerHandle (T4), GeoMap append + def.list/spec.data invariant (T5), Plot append (T6), changeset + dup-id behavior note + tests (T1–T7). hideOnInteraction guard is implemented in T3's `appendToLayer` and exercised by the existing globe suite re-run in T5; an explicit mid-rotation deferral test is optional and can be added if T5 leaves it uncovered.
- **Type consistency:** `appendToLayer(name, items, ids, build)` signature is identical across BaseEngine (T3), GeoMap (T5), and Plot (T6). `LayerHandle<D>` constructor `(engine, name, appendImpl)` matches all three call sites.
- **Identity stability:** appended ids use `offset + j` / `opts.id(f, offset + j)`, which equals the global index a full `buildSpec` rebuild assigns (`i` / `opts.id(f, i)`) — so ids are stable across `setProjection`/rotation rebuilds.
