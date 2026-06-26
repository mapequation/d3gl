# Shared instanced-selection lane — #108-B (BaseEngine owns the lane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Move ownership of the instanced `InstancedLane` from `network()` into `BaseEngine`, so `setTransform` drives every registered lane's re-select+re-emit and `pick()` resolves lanes uniformly — dissolving network's `setTransform`/`pick` overrides and `emitInstancedLayers`. Zero behaviour change.

**Architecture:** `BaseEngine` gains a `Map<string, InstancedLaneEntry>` registry parallel to its Scene `specs`/`hitIndexes`. Each entry = `{ lane, layerNames, dynamic, resolve(index) }`. `setTransform`, after pushing the (matrix) transform, re-emits every **dynamic** lane (clear its layer names, push `lane.update(...)`); static lanes emit once at register time and ride the matrix. `pick` resolves registered lanes (topmost-first) before walking Scene hit-indexes, mapping the picked index to a `HoverHit` via the entry's `resolve`. `network()` registers two lanes — an **LOD lane** (dynamic; the existing `lodCut` strategy) and a **non-LOD full-graph lane** (static; `pickNodes` + `networkLayers`) — and deletes its overrides. Transforms are matrix-based (the backend applies one clip-matrix uniform to all instanced layers), so this adds no per-frame cost beyond the re-select the lane already did.

**Tech Stack:** TypeScript ESM (`.js` specifiers). Vitest: node via root config (`npx vitest run packages/d3gl`); browser via `packages/d3gl/scripts/run-browser-tests.mjs`. Typecheck `pnpm --filter @mapequation/d3gl exec tsc -b`.

---

## Scope & non-goals
- **In:** `BaseEngine` lane registry + `setTransform` drive + `pick` resolution + register/unregister/emit helpers; `network()` migrates onto it and removes its overrides + `emitInstancedLayers` + the `lane` field.
- **Out:** `plot.points()` migration (#108-C — it will simply call `registerInstancedLane`); declutter index-compaction reframe + super-points (#108-D). Glyph/cut/declutter/pick math unchanged. `highlight`/`select` multi-select (N7c) — untouched here, but B's unified `pick` is what it builds on.

## File structure
- **Modify** `packages/d3gl/src/map/base-engine.ts` — add `InstancedLaneEntry` interface, `instancedLanes` registry, `registerInstancedLane`/`unregisterInstancedLane`/`emitInstancedLane`, drive in `setTransform`, resolve in `pick`. Import `InstancedLane` from `../core/instanced-lane.js`.
- **Modify** `packages/d3gl/src/network/network.ts` — register LOD + non-LOD lanes; remove `setTransform`/`pick` overrides, `emitInstancedLayers`, and the `lane` field; route the existing build/invalidation sites to register/unregister.
- **Create** `packages/d3gl/src/map/__tests__/instanced-lane-registry.browser.test.ts` — BaseEngine-level test with a fake lane (engine-agnostic) proving setTransform-drive + pick-resolution + static-vs-dynamic + unregister.

---

### Task 1: BaseEngine owns the instanced-lane registry

**Files:**
- Modify: `packages/d3gl/src/map/base-engine.ts`
- Test: `packages/d3gl/src/map/__tests__/instanced-lane-registry.browser.test.ts`

- [ ] **Step 1: Write the failing test** (browser — needs a real backend that implements `setInstancedLayer`).

```ts
// packages/d3gl/src/map/__tests__/instanced-lane-registry.browser.test.ts
import { describe, it, expect } from "vitest";
import { plot } from "../plot.js";
import { InstancedLane, type SelectionStrategy } from "../../core/instanced-lane.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "200px"; el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

// A fake lane over 3 points at world x=0,50,150 (y=0), radius 10; select = those with screen x in [0,w].
const PX = [0, 50, 150];
function fakeStrategy(): SelectionStrategy {
  return {
    select: (t, w) => Uint32Array.from(PX.map((x, i) => [x, i] as const).filter(([x]) => x * t.k + t.x >= 0 && x * t.k + t.x <= w).map(([, i]) => i)),
    pick: (x, _y, t, visible) => { let f = -1; for (const i of visible) if (Math.abs(x - (PX[i]! * t.k + t.x)) <= 10 * t.k) f = i; return f; },
  };
}

describe("BaseEngine instanced-lane registry (#108-B)", () => {
  it("drives a dynamic lane's emit on setTransform and resolves it via pick", async () => {
    const eng = plot(host(), { width: 200, height: 200 }); // webgl by default
    await eng.whenReady();
    let emitCount = 0;
    const lane = new InstancedLane(fakeStrategy(), (visible) => { emitCount++; return [{ name: "fake", primitive: "circles", circles: { centers: new Float32Array(0), radii: new Float32Array(0), colors: new Uint8Array(0), count: visible.length }, sizeMode: "world" }]; });
    // expose the protected registry through a tiny test subclass-free path: cast to any to call the protected API.
    (eng as unknown as { registerInstancedLane: Function }).registerInstancedLane("fake", {
      lane, layerNames: ["fake"], dynamic: true,
      resolve: (i: number) => ({ layer: "fake", id: i, datum: { i } }),
    });
    const emitsAfterRegister = emitCount; // emitted once at register

    eng.setTransform({ k: 1, x: 0, y: 0 });
    expect(emitCount).toBeGreaterThan(emitsAfterRegister); // dynamic ⇒ re-emitted on transform
    expect(Array.from(lane.visible)).toEqual([0, 1]); // x=0,50 in [0,200]; 150 also in... adjust:
    // at k=1,x=0,w=200 → all of 0,50,150 are <=200, so visible = [0,1,2]
    expect(Array.from(lane.visible)).toEqual([0, 1, 2]);

    expect(eng.pick(50, 0)).toMatchObject({ layer: "fake", id: 1, datum: { i: 1 } });
    expect(eng.pick(100, 0)).toBeNull(); // between points (dist 50 > radius 10)
    eng.destroy();
  });

  it("emits a static lane once (not on every setTransform) and still resolves pick", async () => {
    const eng = plot(host(), { width: 200, height: 200 });
    await eng.whenReady();
    let emitCount = 0;
    const lane = new InstancedLane(fakeStrategy(), (visible) => { emitCount++; return [{ name: "fake", primitive: "circles", circles: { centers: new Float32Array(0), radii: new Float32Array(0), colors: new Uint8Array(0), count: visible.length }, sizeMode: "world" }]; });
    (eng as unknown as { registerInstancedLane: Function }).registerInstancedLane("fake", {
      lane, layerNames: ["fake"], dynamic: false,
      resolve: (i: number) => ({ layer: "fake", id: i, datum: null }),
    });
    const after = emitCount;
    eng.setTransform({ k: 2, x: -10, y: 0 });
    expect(emitCount).toBe(after); // static ⇒ NOT re-emitted (matrix handles the zoom)
    expect(eng.pick(0 * 2 - 10, 0)).toMatchObject({ id: 0 }); // still pickable; pick uses live transform
    eng.destroy();
  });

  it("unregister stops driving the lane and removes its pick", async () => {
    const eng = plot(host(), { width: 200, height: 200 });
    await eng.whenReady();
    const lane = new InstancedLane(fakeStrategy(), (v) => [{ name: "fake", primitive: "circles", circles: { centers: new Float32Array(0), radii: new Float32Array(0), colors: new Uint8Array(0), count: v.length }, sizeMode: "world" }]);
    const api = eng as unknown as { registerInstancedLane: Function; unregisterInstancedLane: Function };
    api.registerInstancedLane("fake", { lane, layerNames: ["fake"], dynamic: true, resolve: (i: number) => ({ layer: "fake", id: i, datum: null }) });
    eng.setTransform({ k: 1, x: 0, y: 0 });
    expect(eng.pick(50, 0)).toMatchObject({ id: 1 });
    api.unregisterInstancedLane("fake");
    expect(eng.pick(50, 0)).toBeNull(); // lane gone ⇒ no instanced hit
    eng.destroy();
  });
});
```
(Note: the cast-to-call-protected pattern keeps the test engine-agnostic. If `plot` isn't a clean host for a fake lane, use `geoMap`; pick whichever instantiates a WebGL backend with the fewest required layers. Adjust the first test's `visible` expectation to the correct value as commented.)

- [ ] **Step 2: Run it to verify it fails** — `cd <wt> && cd packages/d3gl && node scripts/run-browser-tests.mjs src/map/__tests__/instanced-lane-registry.browser.test.ts` → FAIL (`registerInstancedLane is not a function`).

- [ ] **Step 3: Implement the registry in `base-engine.ts`.**

Add the import (top of file): `import { InstancedLane } from "../core/instanced-lane.js";`

Add the entry type (near `LayerSpec`/`HoverHit`):
```ts
/** A registered instanced selection lane (#108-B). BaseEngine drives its re-emit + resolves its picks. */
export interface InstancedLaneEntry {
  lane: InstancedLane;
  /** The instanced layer names this lane emits — cleared then re-added in this order each emit (draw order). */
  layerNames: readonly string[];
  /** Re-select + re-emit on every setTransform (zoom-dependent: LOD cut / declutter). Static lanes emit once at register. */
  dynamic: boolean;
  /** Map a picked source index (from `lane.pick`) to a HoverHit for hover/click dispatch; null = treat as a miss. */
  resolve(index: number): HoverHit | null;
}
```

Add the field (with the other registries, ~line 112): `protected instancedLanes = new Map<string, InstancedLaneEntry>();`

Add the helpers (near `registerLayer`):
```ts
/** Register (or replace) an instanced selection lane and emit it once if a backend is ready. */
protected registerInstancedLane(name: string, entry: InstancedLaneEntry): void {
  this.instancedLanes.set(name, entry);
  if (this.handle?.backend.setInstancedLayer) this.emitInstancedLane(name);
}

/** Drop a lane and remove its instanced layers from the backend. */
protected unregisterInstancedLane(name: string): void {
  const entry = this.instancedLanes.get(name);
  const backend = this.handle?.backend;
  if (entry && backend?.removeInstancedLayer) for (const n of entry.layerNames) backend.removeInstancedLayer(n);
  this.instancedLanes.delete(name);
}

/** Re-select the lane at the live transform and push its layers (clear its names, then re-add in order). */
protected emitInstancedLane(name: string): void {
  const entry = this.instancedLanes.get(name);
  const backend = this.handle?.backend;
  if (!entry || !backend?.setInstancedLayer) return;
  for (const n of entry.layerNames) backend.removeInstancedLayer?.(n);
  for (const layer of entry.lane.update(this.transform, this.width, this.height)) backend.setInstancedLayer(layer);
}
```

In `setTransform(t)` (currently lines 748–760), after `this.handle?.backend.setTransform(t);` and before the Scene declutter loop, drive dynamic lanes:
```ts
this.transform = t;
this.handle?.backend.setTransform(t);
for (const [name, entry] of this.instancedLanes) if (entry.dynamic) this.emitInstancedLane(name);
for (const spec of this.specs) if (spec.declutter) this.declutterLayer(spec, t);
this.render();
...
```

In `pick(x, y)` (currently lines 870–889), resolve lanes BEFORE the Scene specs loop (last-registered = topmost):
```ts
pick(x: number, y: number): HoverHit | null {
  const t = this.transform;
  const lanes = [...this.instancedLanes.values()];
  for (let i = lanes.length - 1; i >= 0; i--) {
    const idx = lanes[i]!.lane.pick(x, y, t);
    if (idx >= 0) { const hit = lanes[i]!.resolve(idx); if (hit) return hit; }
  }
  // ... existing Scene specs reverse-walk, unchanged ...
}
```

- [ ] **Step 4: Run the new test + the geoMap/plot suites (must be unaffected — they register no lanes).**
```
cd packages/d3gl && node scripts/run-browser-tests.mjs src/map/__tests__/instanced-lane-registry.browser.test.ts src/map/plot-interaction.browser.test.ts src/map/interaction.browser.test.ts src/map/declutter.browser.test.ts
```
Expected: new test PASS; existing map tests unchanged (no lanes registered ⇒ both new loops are no-ops). Then `pnpm --filter @mapequation/d3gl exec tsc -b` → 0.

- [ ] **Step 5: Commit** (`git -C <wt>`, no Co-Authored-By/"claude"):
```
git -C <wt> add packages/d3gl/src/map/base-engine.ts packages/d3gl/src/map/__tests__/instanced-lane-registry.browser.test.ts
git -C <wt> commit -m "feat(d3gl): BaseEngine owns an instanced-lane registry (setTransform drive + pick) (#108)"
```

---

### Task 2: Network adopts the registry; remove its overrides

**Files:**
- Modify: `packages/d3gl/src/network/network.ts`

**Step 0 — Baseline guard** (must be green before touching anything):
`npx vitest run packages/d3gl` (358/6) and `cd packages/d3gl && node scripts/run-browser-tests.mjs src/network/__tests__/network.browser.test.ts src/network/__tests__/worker-lod-mainthread.browser.test.ts` (30).

- [ ] **Step 1: Replace the `lane` field with registry-based registration.** The engine registers exactly one lane at a time on the WebGL backend (LOD lane when LOD is ready, else a non-LOD full-graph lane), and registers none on vector backends (Scene path handles draw + pick via `super.pick`).

Add a private helper that (re)registers the right lane (or unregisters, on vector backends):
```ts
private readonly NET_LANE = "network";
/** Register the active instanced lane for the current backend/LOD state (LOD=dynamic, no-LOD=static),
 *  or unregister on a vector backend. Replaces the old `this.lane` field + `setTransform`/`pick` overrides. */
private syncLane(): void {
  const backend = this.backend();
  if (!backend?.setInstancedLayer || !this.graph) { this.unregisterInstancedLane(this.NET_LANE); return; }
  const style = this.resolvedStyleCached(this.graph);
  if (this.lodReady() && this.lodTree) {
    const tree = this.lodTree;
    const strategy: SelectionStrategy = {
      select: () => this.computeFrontier(tree, this.resolvedStyleCached(this.graph!)),
      pick: (x, y, t, visible) => pickFrontier(tree, visible, x, y, t, { screenSized: this.resolvedStyleCached(this.graph!).sizeMode === "screen", maxAggregateRadius: this.lodOptions!.maxAggregateRadius }),
    };
    this.registerInstancedLane(this.NET_LANE, {
      lane: new InstancedLane(strategy, (visible) => this.frontierLayers(tree, this.resolvedStyleCached(this.graph!), visible)),
      layerNames: LAYER_NAMES, dynamic: true,
      resolve: (g) => ({ layer: "nodes", id: g, datum: { aggregate: g >= tree.leafCount, count: tree.count[g]! } satisfies NetworkHit }),
    });
  } else if (!this.lodOptions) {
    const graph = this.graph;
    const strategy: SelectionStrategy = {
      select: () => Uint32Array.from({ length: graph.nodeCount }, (_, i) => i),
      pick: (x, y, t) => pickNodes(graph.positions, this.resolvedStyleCached(graph).nodeRadii, graph.nodeCount, x, y, t, this.resolvedStyleCached(graph).sizeMode === "screen"),
    };
    this.registerInstancedLane(this.NET_LANE, {
      lane: new InstancedLane(strategy, () => networkLayers(graph, this.resolvedStyleCached(graph))),
      layerNames: LAYER_NAMES, dynamic: false,
      resolve: (i) => ({ layer: "nodes", id: i, datum: { aggregate: false, count: 1 } satisfies NetworkHit }),
    });
  } else {
    // LOD on but no tree yet (worker streaming) ⇒ draw nothing, no pickable lane.
    this.unregisterInstancedLane(this.NET_LANE);
  }
}
```

- [ ] **Step 2: Drive it from `rebuild()`.** In `rebuild()`'s WebGL branch, replace the `if (this.lodReady()) layers = this.lane!.update(...)` / `networkLayers(...)` / empty branches and the `emitInstancedLayers(...)` call with a single `this.syncLane();` (registration emits the lane immediately via `registerInstancedLane`). Keep the vector branch (`registerNetworkScene` + `sceneActive`) as-is, but call `this.unregisterInstancedLane(this.NET_LANE)` when switching to it. (The static lane re-emits on `data()`/`style()` because those re-run `rebuild()` → `syncLane()`.)

- [ ] **Step 3: Remove the overrides.** Delete the entire `override setTransform(...)` (lines ~780–788) and `override pick(...)` (lines ~801–820) — BaseEngine now drives the dynamic lane on `setTransform` and resolves lanes in `pick`. Delete `emitInstancedLayers` (lines ~558–561) and the `lane` field; replace any remaining `this.lane`/`rebuildLane` references with `syncLane`. (`computeFrontier`/`frontierLayers`/`pickFrontier`/`pickNodes` stay — they're now invoked through the lane's strategy/emit.) Keep `syncScreenGeometry`/`setInteracting` (vector re-bake) unchanged.

- [ ] **Step 4: Lane invalidation → re-sync.** Everywhere the old code set `this.lane = null` (data/style/lod/worker-onTree/spatial-reset/recomputeLODGeometry tree swap), call `this.syncLane()` instead (after the tree/style change) so the registry holds a fresh lane bound to the new tree/style. On the vector path or `lod(false)` + non-WebGL, `syncLane` unregisters. Search the file for the former `this.lane = null` sites (now compile errors after Step 3) and convert each.

- [ ] **Step 5: Verify ZERO behaviour change** — rerun the Step 0 commands; counts must match exactly (358/6 node, 30 browser). Plus `pnpm --filter @mapequation/d3gl exec tsc -b` → 0. If a test regresses, the likely culprit is a missing `syncLane()` at an invalidation/backend-switch site, or the static lane re-emitting per frame (it must be `dynamic: false`). Do not edit tests.

- [ ] **Step 6: Commit** (`git -C <wt>`, no Co-Authored-By):
```
git -C <wt> add packages/d3gl/src/network/network.ts
git -C <wt> commit -m "refactor(d3gl): network registers its lanes with BaseEngine; drop setTransform/pick overrides (#108)"
```

---

### Task 3: Changeset + PR

- [ ] **Step 1: Changeset** `.changeset/instanced-lane-baseengine.md`:
```md
---
"@mapequation/d3gl": patch
---

Internal: `BaseEngine` now owns the instanced-selection lane registry (#108-B). `setTransform` drives every registered dynamic lane's re-select+re-emit and `pick()` resolves lanes uniformly (topmost-first) before Scene hit-indexes. `network()` registers its LOD (dynamic) and no-LOD (static) lanes and drops its `setTransform`/`pick` overrides + `emitInstancedLayers`. No behaviour change; this is the seam `plot.points()` will register onto (#108-C).
```

- [ ] **Step 2: Verify** (node + the network + map browser suites + tsc + `tsdown` build), open PR. Title `refactor(d3gl): BaseEngine-owned instanced-lane registry (#108-B)`. Body: scope, **Performance** section (no per-frame cost change — `setTransform` adds an O(#lanes) registry iteration over 1 dynamic lane; static lane emits once; pick adds an O(#lanes) loop before Scene; memory O(#lanes)), verification (existing suite unchanged + 3 new registry tests; no new example — internal refactor, behaviour identical). `Refs #108`. Stop for approval.

---

## Roadmap (later)
- **#108-C:** `plot.points()` calls `registerInstancedLane` with a `cullAll`/`declutter` strategy + a circles emit (instanced on WebGL); Scene retained on vector backends for export + `clipTo` + as pick fallback; preserve `pickable`/HoverHit/datum + declutter/scatter examples.
- **#108-D:** declutter as an index-compaction strategy; scale; optional LOD super-points; docs.

## Self-review notes
- **Coverage:** registry + setTransform drive + pick resolution (T1); network full dissolution incl. non-LOD static lane (T2). Matches the "Full" decision (#108-B as specified).
- **Type consistency:** `InstancedLaneEntry.resolve` returns `HoverHit | null`; `lane.pick` returns `number`; `registerInstancedLane`/`unregisterInstancedLane`/`emitInstancedLane` names used consistently across BaseEngine + network. `LAYER_NAMES` reused for both network lanes' `layerNames`.
- **Risks:** (1) the register/unregister lifecycle across backend switches + LOD on/off + worker streaming — guarded by the existing network browser suite (which exercises all three) + the requirement that Step 5 counts match exactly. (2) static lane must be `dynamic: false` or it re-emits the full graph O(N) per frame — explicitly asserted by Task 1's static-lane test. (3) `pick` lane-loop ordering (topmost = last registered) — network only ever has one lane registered at a time, so ordering is moot for it, but the loop is correct for C's multi-lane future.
