# `backend: "auto"` — progressive canvas-first → WebGL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `backend: "auto"` mode to d3gl that paints with the Canvas backend synchronously for an instant first paint, then creates the WebGL device in the background and swaps to it transparently when ready.

**Architecture:** `"auto"` is not a real backend — it is engine-level orchestration in `BaseEngine`. The constructor installs a `CanvasBackend` synchronously (so `whenReady()` resolves immediately), then upgrades to a `WebGLBackend` in the background, reusing the existing backend-swap machinery. A new `onBackendSwapped()` hook lets `GeoMap` re-evaluate gpuGlobe + re-dispatch interaction on the swap; it fires **only when replacing an existing handle** (never on the first install), which keeps it safe to call during construction before `GeoMap` has set `this.projection`.

**Tech Stack:** TypeScript, luma.gl v9 (WebGL2), d3-geo, Vitest browser mode (Playwright/Chromium).

**Spec:** `docs/superpowers/specs/2026-06-08-auto-backend-progressive-webgl-design.md`

**Important environment note:** The `*.browser.test.ts` suites hang in the Claude Code sandbox. Run them locally with the sandbox disabled. The command used throughout this plan is:

```
pnpm --filter @mapequation/d3gl exec vitest run <test-file>
```

Typecheck (root `pnpm typecheck` is known-broken — use the per-package form):

```
pnpm --filter @mapequation/d3gl exec tsc -b
```

---

## File Structure

- `packages/d3gl/src/map/backend-factory.ts` — add `"auto"` to `BackendType`; add synchronous `createCanvasBackend`.
- `packages/d3gl/src/map/base-engine.ts` — extract `installBackend`; add `onBackendSwapped` hook; add the `"auto"` lifecycle (`enterAutoMode`, `upgradeToWebGL`, `upgradeDone` field); wire constructor + `setBackend`.
- `packages/d3gl/src/map/geo-map.ts` — move gpuGlobe re-eval + interaction re-dispatch from `setBackend` into `onBackendSwapped`.
- `packages/d3gl/src/map/auto-backend.browser.test.ts` — new test suite for the `"auto"` lifecycle.
- `packages/d3gl/src/map/backend-factory.browser.test.ts` — extend for `createCanvasBackend`.
- `.changeset/<name>.md` — release note.

---

## Task 1: Add `"auto"` to `BackendType` and a synchronous canvas factory

**Files:**
- Modify: `packages/d3gl/src/map/backend-factory.ts`
- Test: `packages/d3gl/src/map/backend-factory.browser.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `packages/d3gl/src/map/backend-factory.browser.test.ts` (keep the existing `createBackend` test; add the import and the new `it`):

```ts
import { describe, it, expect } from "vitest";
import { createBackend, createCanvasBackend } from "./backend-factory.js";

describe("createCanvasBackend", () => {
  it("creates a canvas backend + element synchronously (no await)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { backend, element } = createCanvasBackend(host, 64, 64);
    expect(backend).toBeTruthy();
    expect(element).toBeTruthy();
    expect((element as HTMLElement).tagName).toBe("CANVAS");
    expect(host.querySelector("canvas")).toBe(element);
    backend.destroy();
    host.remove();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mapequation/d3gl exec vitest run src/map/backend-factory.browser.test.ts`
Expected: FAIL — `createCanvasBackend is not exported` / not a function.

- [ ] **Step 3: Implement**

In `packages/d3gl/src/map/backend-factory.ts`:

Change the `BackendType` union to include `"auto"`:

```ts
export type BackendType = "webgl" | "canvas" | "svg" | "auto";
```

Add the synchronous factory below `makeCanvas` (the `CanvasBackend` constructor is already synchronous; this skips the `Promise` wrapper). Place it after the `createBackend` function:

```ts
/**
 * Synchronously create a Canvas backend + its <canvas> element. Used by the engine's
 * "auto" mode for an instant (non-async) first paint before the WebGL device is ready.
 */
export function createCanvasBackend(host: HTMLElement, width: number, height: number): BackendHandle {
  const canvas = makeCanvas(host, width, height);
  return { backend: new CanvasBackend(canvas, width, height), element: canvas };
}
```

Note: `createBackend`'s existing `else` branch (WebGL) already covers any unexpected `"auto"` argument by creating WebGL, but the engine never calls `createBackend("auto")` — `"auto"` is handled in `BaseEngine`. Leave `createBackend` otherwise unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @mapequation/d3gl exec vitest run src/map/backend-factory.browser.test.ts`
Expected: PASS (both the existing `createBackend` test and the new one).

- [ ] **Step 5: Export it from the map barrel**

In `packages/d3gl/src/map/index.ts`, the line `export { createBackend } from "./backend-factory.js";` already re-exports the factory module's named export. Add `createCanvasBackend`:

```ts
export { createBackend, createCanvasBackend } from "./backend-factory.js";
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @mapequation/d3gl exec tsc -b`
Expected: no errors. (Adding `"auto"` to the union is non-breaking; `createBackend`'s `if/if/else` still type-checks because the `else` handles the remaining `"webgl" | "auto"`.)

- [ ] **Step 7: Commit**

```bash
git add packages/d3gl/src/map/backend-factory.ts packages/d3gl/src/map/index.ts packages/d3gl/src/map/backend-factory.browser.test.ts
git commit -m "feat(map): add \"auto\" BackendType and synchronous createCanvasBackend"
```

---

## Task 2: Extract `installBackend` + add `onBackendSwapped` hook (pure refactor)

This refactor introduces no new behavior — it factors the swap tail out of `swapBackend` so the upcoming auto-upgrade can share it, and adds an overridable post-swap hook that fires **only when replacing an existing handle**.

**Files:**
- Modify: `packages/d3gl/src/map/base-engine.ts`

- [ ] **Step 1: Add the `onBackendSwapped` hook and `installBackend`**

In `packages/d3gl/src/map/base-engine.ts`, find `swapBackend` (currently the last method, around lines 339–353):

```ts
  private async swapBackend(type: BackendType): Promise<void> {
    this.currentBackend = type;
    const token = ++this.swapToken;
    const old = this.handle;
    const next = await createBackend(type, this.host, this.width, this.height);
    // A newer swap superseded this one, or the engine was destroyed mid-flight:
    // tear down the freshly created backend so it never orphans an element.
    if (token !== this.swapToken || this.destroyed) { next.backend.destroy(); if (next.element !== this.host) next.element.remove(); return; }
    old?.backend.destroy();
    if (old && old.element !== this.host) old.element.remove();
    this.handle = next;
    next.backend.setLayers(this.renderSpecs().map((s) => this.renderLayer(s)));
    next.backend.setTransform(this.transform);
    next.backend.render();
  }
```

Replace that whole method with the following three members (keep them adjacent, in this order):

```ts
  /**
   * Post-swap hook: called after a backend SWAP completes (an existing handle was
   * replaced) — NOT on the first install. Subclasses override to react to a change of
   * the live backend (e.g. re-evaluate GPU-globe eligibility and re-dispatch interaction).
   * Default: no-op.
   */
  protected onBackendSwapped(): void {}

  /**
   * Install `next` as the live backend (shared by swapBackend and the "auto" upgrade).
   * Honors the swap-supersede / destroyed guards. Destroys + detaches the previous
   * handle, pushes the current specs + transform, renders, and — only if it REPLACED an
   * existing handle — fires onBackendSwapped(). The first install (old === null) does NOT
   * notify, so it is safe to call synchronously during construction (before a subclass has
   * finished initializing its own fields, e.g. GeoMap's projection).
   */
  private installBackend(next: BackendHandle, token: number, type: BackendType): void {
    if (token !== this.swapToken || this.destroyed) {
      next.backend.destroy();
      if (next.element !== this.host) next.element.remove();
      return;
    }
    const old = this.handle;
    old?.backend.destroy();
    if (old && old.element !== this.host) old.element.remove();
    this.handle = next;
    this.currentBackend = type;
    next.backend.setLayers(this.renderSpecs().map((s) => this.renderLayer(s)));
    next.backend.setTransform(this.transform);
    next.backend.render();
    if (old) this.onBackendSwapped();
  }

  private async swapBackend(type: BackendType): Promise<void> {
    this.currentBackend = type;
    const token = ++this.swapToken;
    const next = await createBackend(type, this.host, this.width, this.height);
    this.installBackend(next, token, type);
  }
```

Notes for the implementer:
- `swapBackend` still sets `this.currentBackend = type` up-front (preserves existing `backendType()` semantics during the pending window); `installBackend` sets it again at install — harmless and keeps the live value honest for the auto path.
- `BackendHandle` is already imported at the top of the file (`import { createBackend, type BackendType, type BackendHandle } from "./backend-factory.js";`). Verify that import line; if `BackendHandle` is not yet in it, add it.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @mapequation/d3gl exec tsc -b`
Expected: no errors.

- [ ] **Step 3: Run the existing map + react browser suites to confirm no behavior change**

Run: `pnpm --filter @mapequation/d3gl exec vitest run src/map/geo-map.browser.test.ts src/map/backend-factory.browser.test.ts src/map/plot.browser.test.ts src/react/controller.browser.test.ts`
Expected: PASS. (The first-install no-notify rule matches current behavior — there was no hook before, and subclasses set their own initial state in their constructors.)

- [ ] **Step 4: Commit**

```bash
git add packages/d3gl/src/map/base-engine.ts
git commit -m "refactor(map): extract installBackend + onBackendSwapped hook from swapBackend"
```

---

## Task 3: Move GeoMap's gpuGlobe re-eval + interaction re-dispatch into `onBackendSwapped`

**Files:**
- Modify: `packages/d3gl/src/map/geo-map.ts`

- [ ] **Step 1: Replace the `setBackend` override with a slimmer one + the hook**

In `packages/d3gl/src/map/geo-map.ts`, find the current override (around lines 106–113):

```ts
  override setBackend(type: BackendType): this {
    this.disableInteraction();
    super.setBackend(type);
    this.evalGpuGlobe();
    const req = this.interactionRequest;
    if (req) this.enableZoom(req.extent, req.onTransform); // re-dispatch for the new projection
    return this;
  }
```

Replace it with:

```ts
  override setBackend(type: BackendType): this {
    this.disableInteraction();
    super.setBackend(type);
    // gpuGlobe re-eval + interaction re-dispatch now happen in onBackendSwapped(), once the
    // new backend is actually live — which also covers the transparent "auto" canvas→WebGL
    // upgrade (a swap the caller never explicitly requested).
    return this;
  }

  /** After any backend SWAP (explicit setBackend, or the "auto" canvas→WebGL upgrade): the
   *  live backend changed, so re-evaluate GPU-globe eligibility and re-dispatch the stored
   *  interaction (an orthographic globe switches from CPU rotation to the GPU globe on the
   *  swap to WebGL). */
  protected override onBackendSwapped(): void {
    this.evalGpuGlobe();
    const req = this.interactionRequest;
    if (req) this.enableZoom(req.extent, req.onTransform);
  }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @mapequation/d3gl exec tsc -b`
Expected: no errors.

- [ ] **Step 3: Run the geo-map + globe suites**

Run: `pnpm --filter @mapequation/d3gl exec vitest run src/map/geo-map.browser.test.ts src/map/geo-map-globe.browser.test.ts`
Expected: PASS. The existing test switches `setBackend("svg")` → `setBackend("webgl")` and awaits `whenReady()`; with the hook, the re-eval/re-dispatch now runs after the swap completes (inside the `this.ready` promise), so it has happened by the time `await whenReady()` returns.

- [ ] **Step 4: Commit**

```bash
git add packages/d3gl/src/map/geo-map.ts
git commit -m "refactor(map): re-eval gpuGlobe + re-dispatch interaction in onBackendSwapped"
```

---

## Task 4: The `"auto"` lifecycle in `BaseEngine`

**Files:**
- Modify: `packages/d3gl/src/map/base-engine.ts`
- Test: `packages/d3gl/src/map/auto-backend.browser.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `packages/d3gl/src/map/auto-backend.browser.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { geoMap } from "./geo-map.js";
import * as factory from "./backend-factory.js";

const proj = () => geoEquirectangular().scale(50).translate([100, 100]);
const sqPoly = (x: number, y: number, s: number): GeoJSON.Feature => ({
  type: "Feature", properties: {},
  geometry: { type: "Polygon", coordinates: [[[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]]] },
});

// The engine stores the in-flight upgrade as a private `upgradeDone` promise; tests await it.
const upgradeOf = (map: unknown): Promise<void> | null => (map as { upgradeDone: Promise<void> | null }).upgradeDone;
const liveBackend = (map: unknown): string => (map as { currentBackend: string }).currentBackend;
// A WebGL-backed canvas yields a webgl2 context; a Canvas2D one does not.
const isWebGLCanvas = (host: HTMLElement): boolean => {
  const c = host.querySelector("canvas");
  if (!c) return false;
  try { return !!(c as HTMLCanvasElement).getContext("webgl2"); } catch { return false; }
};

describe("backend: \"auto\"", () => {
  it("paints canvas synchronously and resolves whenReady early, then upgrades to WebGL", async () => {
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);

    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "auto" });
    map.layer("cells", [sqPoly(0, 0, 20)], { fill: "rgb(255,0,0)", id: () => "c0" });

    // Early: whenReady resolves at the canvas first paint; the live backend is canvas.
    await map.whenReady();
    expect(liveBackend(map)).toBe("canvas");
    expect(host.querySelector("canvas")).toBeTruthy();
    // hit-test works on the canvas backend immediately (proj([10,10]) ≈ [108.7, 91.3]).
    expect(map.pick(108, 91)?.layer).toBe("cells");

    // Background upgrade: await the internal upgrade promise; the live backend is now WebGL.
    await upgradeOf(map);
    expect(liveBackend(map)).toBe("webgl");
    expect(isWebGLCanvas(host)).toBe(true);

    map.destroy();
    host.remove();
  });

  it("preserves layers, colors and transform across the upgrade", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "auto" });
    await map.whenReady();
    map.layer("cells", [sqPoly(0, 0, 20)], { fill: "rgb(0,200,0)", id: () => "c0" });
    map.setTransform({ k: 1, x: 5, y: 5 });

    await upgradeOf(map);
    expect(liveBackend(map)).toBe("webgl");
    // The layer + its color survive the swap (the spec is the source of truth, re-pushed on swap).
    const hit = map.pick(108 + 5, 91 + 5);
    expect(hit?.layer).toBe("cells");

    map.destroy();
    host.remove();
  });

  it("stays on canvas (and still renders) if the WebGL upgrade fails", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi.spyOn(factory, "createBackend").mockRejectedValue(new Error("no webgl2"));

    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "auto" });
    map.layer("cells", [sqPoly(0, 0, 20)], { fill: "rgb(255,0,0)", id: () => "c0" });
    await map.whenReady();
    await upgradeOf(map);

    expect(liveBackend(map)).toBe("canvas");
    expect(isWebGLCanvas(host)).toBe(false);
    expect(map.pick(108, 91)?.layer).toBe("cells"); // canvas still works
    expect(warn).toHaveBeenCalled();

    spy.mockRestore();
    warn.mockRestore();
    map.destroy();
    host.remove();
  });

  it("destroy during the upgrade leaves no orphan canvas", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "auto" });
    await map.whenReady();
    const up = upgradeOf(map);
    map.destroy();           // destroy before the WebGL device resolves
    await up;                // let the in-flight upgrade settle
    expect(host.querySelector("canvas")).toBeNull(); // no orphaned element left behind

    host.remove();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mapequation/d3gl exec vitest run src/map/auto-backend.browser.test.ts`
Expected: FAIL — `backend: "auto"` currently falls through `swapBackend("auto")` → `createBackend`'s WebGL `else`, so `whenReady()` waits for WebGL and `liveBackend` is never `"canvas"`; `upgradeDone` is `undefined`.

- [ ] **Step 3: Implement the auto lifecycle**

In `packages/d3gl/src/map/base-engine.ts`:

(a) Add the import for the synchronous canvas factory. Update the existing factory import line to:

```ts
import { createBackend, createCanvasBackend, type BackendType, type BackendHandle } from "./backend-factory.js";
```

(b) Add a field next to the other private fields (near `private swapToken = 0;`):

```ts
  /** The in-flight (or settled) WebGL upgrade for "auto" mode; null when not in auto mode. */
  private upgradeDone: Promise<void> | null = null;
```

(c) Change the constructor. Current:

```ts
  constructor(protected host: HTMLElement, protected width: number, protected height: number, backend: BackendType) {
    this.currentBackend = backend;
    this.ready = this.swapBackend(backend);
  }
```

Replace with:

```ts
  constructor(protected host: HTMLElement, protected width: number, protected height: number, backend: BackendType) {
    this.currentBackend = backend;
    if (backend === "auto") {
      // Instant canvas first paint; whenReady() resolves now. WebGL is built in the background.
      this.ready = Promise.resolve();
      this.enterAutoMode();
    } else {
      this.ready = this.swapBackend(backend);
    }
  }
```

(d) Change `setBackend` to route `"auto"`. Current:

```ts
  setBackend(type: BackendType): this { this.ready = this.swapBackend(type); return this; }
```

Replace with:

```ts
  setBackend(type: BackendType): this {
    if (type === "auto") { this.ready = Promise.resolve(); this.enterAutoMode(); }
    else this.ready = this.swapBackend(type);
    return this;
  }
```

(e) Add the two private methods next to `installBackend` / `swapBackend`:

```ts
  /** Enter "auto" mode: install a Canvas backend synchronously (instant first paint, no
   *  await, no onBackendSwapped — it is the first install / a fresh canvas), then start the
   *  background WebGL upgrade. Bumping swapToken invalidates any in-flight prior swap. */
  private enterAutoMode(): void {
    const handle = createCanvasBackend(this.host, this.width, this.height);
    this.installBackend(handle, ++this.swapToken, "canvas");
    this.upgradeDone = this.upgradeToWebGL();
  }

  /** Background upgrade: create the WebGL device, then swap it in via installBackend (which
   *  destroys the canvas handle and fires onBackendSwapped, since it replaces a live handle).
   *  On failure, keep the canvas and warn — the map keeps working. */
  private async upgradeToWebGL(): Promise<void> {
    const token = ++this.swapToken;
    let next: BackendHandle;
    try {
      next = await createBackend("webgl", this.host, this.width, this.height);
    } catch (err) {
      if (!this.destroyed) console.warn("d3gl: WebGL upgrade failed, staying on canvas", err);
      return;
    }
    this.installBackend(next, token, "webgl");
  }
```

Implementer notes:
- `installBackend` already handles the destroy/supersede race: if `destroy()` ran during the await, `this.destroyed` is true and `this.swapToken` was bumped (`destroy()` does `this.swapToken++`), so `installBackend` tears down `next` and returns without installing. The canvas handle was already destroyed and detached by `destroy()`, so no orphan remains — satisfying the destroy-during-upgrade test.
- Because `enterAutoMode` runs in the `BaseEngine` constructor (synchronously, before the `GeoMap` subclass constructor body sets `this.projection`), the canvas `installBackend` must NOT call `onBackendSwapped` — guaranteed by the `if (old)` guard (first install has `old === null`). The WebGL upgrade resolves later (after a microtask/await), by which point `GeoMap`'s constructor has finished and `this.projection` is set, so its `onBackendSwapped` → `evalGpuGlobe` is safe.

- [ ] **Step 4: Run the auto tests**

Run: `pnpm --filter @mapequation/d3gl exec vitest run src/map/auto-backend.browser.test.ts`
Expected: PASS (all four cases).

Note on the mock-based failure test: it relies on `vi.spyOn(factory, "createBackend")`. The engine imports `createBackend` from the same module namespace, so the spy intercepts it. If module-namespace spying does not intercept (ESM live-binding edge case in the browser provider), fall back to constructing the engine with a host whose canvas cannot get a WebGL2 context is not reliable — instead, if the spy fails to intercept, change `upgradeToWebGL` to call a thin `protected createWebGLBackend()` indirection and spy on the instance method. Only do this if the namespace spy proves unreliable; prefer the namespace spy first.

- [ ] **Step 5: Typecheck + run the full map suite for regressions**

Run: `pnpm --filter @mapequation/d3gl exec tsc -b`
Run: `pnpm --filter @mapequation/d3gl exec vitest run src/map/`
Expected: no type errors; all map suites PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/d3gl/src/map/base-engine.ts packages/d3gl/src/map/auto-backend.browser.test.ts
git commit -m "feat(map): backend \"auto\" — canvas-first paint, background WebGL upgrade"
```

---

## Task 5: Orthographic rotation works across the `"auto"` upgrade

Confirms the interaction re-dispatch through `onBackendSwapped`: rotation is the CPU path while canvas is live, and the GPU globe activates after the swap to WebGL.

**Files:**
- Test: `packages/d3gl/src/map/auto-backend.browser.test.ts` (extend)

- [ ] **Step 1: Add the failing test**

Append to the `describe("backend: \"auto\"", …)` block in `packages/d3gl/src/map/auto-backend.browser.test.ts`:

```ts
  it("orthographic + enableZoom: CPU rotation on canvas, GPU globe after the WebGL upgrade", async () => {
    const { geoOrthographic } = await import("d3-geo");
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);

    const map = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().scale(90).translate([100, 100]), backend: "auto" });
    map.layer("land", [sqPoly(0, 0, 30)], { fill: "rgb(0,120,0)", id: () => "L" });
    map.enableZoom([1, 8]); // orthographic ⇒ rotation; dispatched against canvas first
    await map.whenReady();
    expect(liveBackend(map)).toBe("canvas");
    // gpuGlobe must be OFF while canvas is live (CPU rotation path).
    expect((map as unknown as { gpuGlobe: boolean }).gpuGlobe).toBe(false);

    await upgradeOf(map);
    expect(liveBackend(map)).toBe("webgl");
    // After the swap to WebGL, the GPU globe is active for the orthographic projection.
    expect((map as unknown as { gpuGlobe: boolean }).gpuGlobe).toBe(true);

    map.destroy();
    host.remove();
  });
```

- [ ] **Step 2: Run to verify (it should already pass once Tasks 3–4 are in)**

Run: `pnpm --filter @mapequation/d3gl exec vitest run src/map/auto-backend.browser.test.ts`
Expected: PASS. If it FAILS at the post-upgrade `gpuGlobe === true` assertion, the `onBackendSwapped` re-eval is not running on the upgrade — re-check Task 3 (the hook is overridden in `GeoMap`) and Task 2 (`installBackend` fires `onBackendSwapped` when `old` is present).

- [ ] **Step 3: Commit**

```bash
git add packages/d3gl/src/map/auto-backend.browser.test.ts
git commit -m "test(map): orthographic rotation survives the auto canvas→WebGL upgrade"
```

---

## Task 6: Release note (changeset)

**Files:**
- Create: `.changeset/auto-backend-progressive-webgl.md`

- [ ] **Step 1: Write the changeset**

Create `.changeset/auto-backend-progressive-webgl.md`:

```md
---
"@mapequation/d3gl": minor
---

Add an opt-in `backend: "auto"` mode that paints with the Canvas backend
synchronously for an instant first paint, then creates the WebGL device in the
background and swaps to it transparently when ready. `whenReady()` (and the React
`onReady`) resolve at the canvas first paint, so consumers see a working map
immediately without paying the WebGL device-creation startup cost up front. If
WebGL is unavailable the map stays on Canvas (with a `console.warn`). Existing
`"webgl"` / `"canvas"` / `"svg"` behavior is unchanged.
```

- [ ] **Step 2: Commit**

```bash
git add .changeset/auto-backend-progressive-webgl.md
git commit -m "chore: changeset for backend \"auto\" progressive WebGL"
```

---

## Final verification

- [ ] **Run the full d3gl browser + node suites**

Run: `pnpm --filter @mapequation/d3gl exec vitest run`
Expected: all suites PASS (sandbox disabled).

- [ ] **Typecheck**

Run: `pnpm --filter @mapequation/d3gl exec tsc -b`
Expected: no errors.

- [ ] **Spot-check the perceived-speed win (optional, manual)**

In the website's world-map example, pass `backend="auto"` and confirm the map paints immediately (canvas) and then visibly sharpens/recomposites to WebGL a beat later, with pan/zoom working throughout.
