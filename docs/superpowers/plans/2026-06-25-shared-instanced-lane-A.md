# Shared instanced-selection lane — #108-A (extract core, network adopts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a core `InstancedLane` (the per-view `select → emit → pick` orchestration) + a `SelectionStrategy` interface, and have `network()` adopt it for its LOD frontier — with **zero behaviour change**, pinned by characterization tests.

**Architecture:** Today `network()` open-codes the orchestration: `setTransform()` calls `computeFrontier()` (cut + declutter) → `lodLayers()` (gather instance buffers) → `emitInstancedLayers()`, and `pick()` calls `pickFrontier()`. This slice factors that *orchestration* into a backend-agnostic `InstancedLane` that holds a `SelectionStrategy` (`select(t)→visibleIndices`, `pick(x,y,t,visible)→index`) and an `emit(visible)→InstancedLayer[]` callback. Network provides a `lodCut` strategy wrapping its existing `cut`/`declutterFrontier`/`pickFrontier` and its existing glyph emit — no glyph code moves, no GPU change. This is the seam #108-B then hoists into `BaseEngine` so plot+network share one lane.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest (Node unit tests via root config; browser tests via `packages/d3gl/scripts/run-browser-tests.mjs`). Per-package typecheck: `pnpm --filter @mapequation/d3gl exec tsc -b`.

---

## Scope & non-goals

- **In:** new `core/instanced-lane.ts` (pure orchestration, no GPU); network's `setTransform`/`pick`/frontier path re-expressed through it; characterization tests proving identical frontier + pick + emitted-layer output.
- **Out (later slices):** BaseEngine ownership of the lane registry (#108-B); `plot.points()` migration (#108-C); declutter index-compaction reframe + super-points + docs (#108-D). Super-edges/halos/borders/cross-fade stay network glyph code — they ride along inside network's `emit`, untouched.

## File structure

- **Create** `packages/d3gl/src/core/instanced-lane.ts` — `LaneTransform`, `SelectionStrategy`, `InstancedLane`. One responsibility: per-view select→emit→pick orchestration over an instanced layer. No imports from `network/` or `webgl/` (stays core-pure; depends only on the `InstancedLayer` type from `core/backend.js`).
- **Create** `packages/d3gl/src/core/__tests__/instanced-lane.test.ts` — unit tests for the orchestration (Node).
- **Modify** `packages/d3gl/src/network/network.ts` — build a lane in `recomputeLODGeometry`/`lod()` adoption; route `setTransform` emit + `pick()` through it. (`computeFrontier`, `lodLayers`, `pickFrontier` usage move *behind* the strategy/emit; their bodies are unchanged.)
- **Create** `packages/d3gl/src/network/__tests__/lane-characterization.browser.test.ts` — golden frontier + pick + circle-count before/after, on a real WebGL device.

---

### Task 1: Define the core lane abstraction

**Files:**
- Create: `packages/d3gl/src/core/instanced-lane.ts`
- Test: `packages/d3gl/src/core/__tests__/instanced-lane.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/d3gl/src/core/__tests__/instanced-lane.test.ts
import { describe, it, expect } from "vitest";
import { InstancedLane, type SelectionStrategy } from "../instanced-lane.js";

// A toy strategy over 4 points on a line at world x = 0,10,20,30 (y=0), radius 5 (world units).
const PX = [0, 10, 20, 30];
function lineStrategy(): SelectionStrategy {
  return {
    select(t, w) {
      // keep points whose projected x is within [0, w]
      const keep: number[] = [];
      for (let i = 0; i < PX.length; i++) {
        const sx = PX[i]! * t.k + t.x;
        if (sx >= 0 && sx <= w) keep.push(i);
      }
      return Uint32Array.from(keep);
    },
    pick(x, _y, t, visible) {
      let found = -1;
      for (const i of visible) {
        const sx = PX[i]! * t.k + t.x;
        if (Math.abs(x - sx) <= 5 * t.k) found = i; // last match = topmost
      }
      return found;
    },
  };
}

describe("InstancedLane (#108-A)", () => {
  it("select() drives emit() and retains the visible set for pick()", () => {
    const emitted: Uint32Array[] = [];
    const lane = new InstancedLane(lineStrategy(), (visible) => {
      emitted.push(visible);
      return [{ name: "pts", primitive: "circles", circles: { centers: new Float32Array(0), radii: new Float32Array(0), colors: new Uint8Array(0), count: visible.length }, sizeMode: "world" }];
    });

    const layers = lane.update({ k: 1, x: 0, y: 0 }, 25, 25); // x in [0,25] ⇒ points 0,1,2
    expect(Array.from(lane.visible)).toEqual([0, 1, 2]);
    expect(layers[0]!.circles!.count).toBe(3);
    expect(emitted).toHaveLength(1);
  });

  it("pick() resolves against the last selected set (topmost wins), -1 on miss", () => {
    const lane = new InstancedLane(lineStrategy(), () => []);
    lane.update({ k: 1, x: 0, y: 0 }, 100, 100); // visible = 0,1,2,3
    expect(lane.pick(10, 0, { k: 1, x: 0, y: 0 })).toBe(1);
    expect(lane.pick(50, 0, { k: 1, x: 0, y: 0 })).toBe(-1);
  });

  it("pick() returns -1 before any update (empty visible set)", () => {
    const lane = new InstancedLane(lineStrategy(), () => []);
    expect(lane.pick(0, 0, { k: 1, x: 0, y: 0 })).toBe(-1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd <worktree> && npx vitest run packages/d3gl/src/core/__tests__/instanced-lane.test.ts`
Expected: FAIL — `Cannot find module '../instanced-lane.js'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// packages/d3gl/src/core/instanced-lane.ts
import type { InstancedLayer } from "./backend.js";

/** Screen transform: `screen = world·k + (x, y)`. Matches `ViewTransform`/`LODTransform`. */
export interface LaneTransform {
  k: number;
  x: number;
  y: number;
}

/**
 * Chooses which of a lane's glyphs are on screen for a view, and resolves a screen point back to one.
 * The returned indices ARE the per-frame "frontier" — the lane's emit gathers a compact instance
 * buffer from them (index compaction), so draw cost ∝ the visible set, not the total. Strategies are
 * composable: viewport cull, screen-space declutter, or an LOD hierarchy cut.
 */
export interface SelectionStrategy {
  /** Indices (into the lane's source) to draw for this view. */
  select(t: LaneTransform, width: number, height: number): Uint32Array;
  /** Hit-test a screen point (CSS px) against `visible`; return a source index or -1 (topmost wins). */
  pick(x: number, y: number, t: LaneTransform, visible: Uint32Array): number;
}

/** Builds the instanced draw layers for a given visible index set (the index-compacted gather). */
export type LaneEmit = (visible: Uint32Array) => InstancedLayer[];

/**
 * Ties a {@link SelectionStrategy} to an emitter: each view, `select` produces the visible set, `emit`
 * gathers a compact instance buffer from it, and `pick` resolves a screen point against that retained
 * set. Backend-agnostic and GPU-free — the engine pushes the returned layers and owns the device.
 * #108-B hoists ownership of a registry of these into `BaseEngine` so plot + network share the seam.
 */
export class InstancedLane {
  /** The visible index set from the last {@link update} — retained for {@link pick}. */
  visible: Uint32Array = new Uint32Array(0);

  constructor(private strategy: SelectionStrategy, private emit: LaneEmit) {}

  /** Re-select for the view, retain the visible set, and return the index-compacted draw layers. */
  update(t: LaneTransform, width: number, height: number): InstancedLayer[] {
    this.visible = this.strategy.select(t, width, height);
    return this.emit(this.visible);
  }

  /** Resolve a screen point against the retained visible set; -1 on a miss. */
  pick(x: number, y: number, t: LaneTransform): number {
    return this.strategy.pick(x, y, t, this.visible);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/d3gl/src/core/__tests__/instanced-lane.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @mapequation/d3gl exec tsc -b` → exit 0.
```bash
git add packages/d3gl/src/core/instanced-lane.ts packages/d3gl/src/core/__tests__/instanced-lane.test.ts
git commit -m "feat(d3gl): core — InstancedLane select→emit→pick orchestration (#108)"
```

---

### Task 2: Characterization test — pin network's current frontier + pick + circle count

Capture current behaviour BEFORE the refactor so Task 3 can prove "zero change". This test must pass against today's network unchanged.

**Files:**
- Create: `packages/d3gl/src/network/__tests__/lane-characterization.browser.test.ts`

- [ ] **Step 1: Write the test (passes today)**

```ts
// packages/d3gl/src/network/__tests__/lane-characterization.browser.test.ts
import { describe, it, expect } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = "320px";
  el.style.height = "200px";
  document.body.appendChild(el);
  return el;
}

// Deterministic two-module graph (the N7a fixture): aggregates 4={0,1}, 5={2,3}; centroids x=50,250.
function makeNet() {
  const net = network(host(), { width: 320, height: 200 });
  return net;
}
function build(net: ReturnType<typeof network>) {
  net
    .data(buildGraph({ nodeCount: 4, source: [0, 2, 1], target: [1, 3, 2], weight: [2, 2, 1] }))
    .lod({ coarsen: { minNodes: 2 }, expandPx: 48, declutter: false })
    .layout({ backend: "positions", positions: new Float32Array([0, 0, 100, 0, 200, 0, 300, 0]) });
}

describe("network LOD frontier — characterization (#108-A guard)", () => {
  it("resolves the same leaves zoomed in and aggregates zoomed out, before and after the lane refactor", async () => {
    const net = makeNet();
    await net.whenReady();
    build(net);

    // k=1: aggregates expand → leaves.
    expect(net.pick(0, 0)).toMatchObject({ id: 0, datum: { aggregate: false, count: 1 } });
    expect(net.pick(100, 0)).toMatchObject({ id: 1, datum: { aggregate: false } });
    expect(net.pick(50, 0)).toBeNull();

    // k=0.4: collapse to aggregates.
    net.setTransform({ k: 0.4, x: 0, y: 0 });
    expect(net.pick(20, 0)).toMatchObject({ id: 4, datum: { aggregate: true, count: 2 } });
    expect(net.pick(100, 0)).toMatchObject({ id: 5, datum: { aggregate: true, count: 2 } });
    net.destroy();
  });

  it("renders the frontier to SVG with the expected circle counts across zoom (emit parity)", async () => {
    const svg = network(host(), { width: 320, height: 200, backend: "svg" });
    await svg.whenReady();
    build(svg);
    const circles = () => (svg.toSVG().match(/<circle/g) ?? []).length;

    svg.setTransform({ k: 0.4, x: 0, y: 0 });
    svg.syncScreenGeometry();
    expect(circles()).toBe(2); // two aggregates

    svg.setTransform({ k: 1, x: 0, y: 0 });
    svg.syncScreenGeometry();
    expect(circles()).toBe(4); // four leaves
    svg.destroy();
  });
});
```

- [ ] **Step 2: Run it to verify it PASSES today (it characterizes current behaviour)**

Run: `cd packages/d3gl && node scripts/run-browser-tests.mjs src/network/__tests__/lane-characterization.browser.test.ts`
Expected: PASS (2 tests) — this is the golden baseline.

- [ ] **Step 3: Commit**

```bash
git add packages/d3gl/src/network/__tests__/lane-characterization.browser.test.ts
git commit -m "test(d3gl): characterize network LOD frontier + pick before lane refactor (#108)"
```

---

### Task 3: Network adopts the lane (behaviour-preserving refactor)

Route network's emit (on `setTransform`) and `pick()` through an `InstancedLane` whose strategy wraps the existing `cut`+`declutterFrontier` (select) and `pickFrontier` (pick), and whose emit is the existing `lodLayers` body. **No glyph code changes.**

**Files:**
- Modify: `packages/d3gl/src/network/network.ts`

- [ ] **Step 1: Build the lane when the LOD tree/geometry is ready**

In `network.ts`, import the lane and add a field:
```ts
import { InstancedLane, type SelectionStrategy } from "../core/instanced-lane.js";
// ...
  /** The shared select→emit→pick lane for the LOD frontier (#108-A); rebuilt when the tree/style changes. */
  private lane: InstancedLane | null = null;
```

Add a private factory that closes over the current `tree`+`style` (call it at the end of `recomputeLODGeometry`, where `this.lodTree`/`this.lodHasGeometry` are set, and whenever style is re-resolved):
```ts
  /** (Re)build the LOD frontier lane: a `lodCut` strategy (cut + declutter, + pickFrontier) feeding the
   *  existing glyph emit. Cheap — captures references, runs no work until update()/pick(). */
  private rebuildLane(): void {
    if (!this.lodTree) { this.lane = null; return; }
    const tree = this.lodTree;
    const strategy: SelectionStrategy = {
      select: () => this.computeFrontier(tree, this.resolvedStyleCached(this.graph!)),
      pick: (x, y, t, visible) =>
        pickFrontier(tree, visible, x, y, t, {
          screenSized: this.resolvedStyleCached(this.graph!).sizeMode === "screen",
          maxAggregateRadius: this.lodOptions!.maxAggregateRadius,
        }),
    };
    this.lane = new InstancedLane(strategy, (visible) =>
      this.frontierLayers(tree, this.resolvedStyleCached(this.graph!), visible),
    );
  }
```

- [ ] **Step 2: Split `lodLayers` so emit takes a precomputed frontier**

Rename the body of `lodLayers` that runs *after* `computeFrontier` into `frontierLayers(tree, style, frontier)` (it already only reads `frontier` after line 605). `lodLayers` keeps building its own frontier for any non-lane caller, but the lane path calls `frontierLayers` directly with the lane's `visible`:
```ts
  private frontierLayers(tree: LODTree, style: ResolvedNetworkStyle, frontier: Uint32Array): InstancedLayer[] {
    const opts = this.lodOptions!;
    const layers: InstancedLayer[] = [];
    // ... existing body verbatim from current lodLayers after `const frontier = ...` ...
    return layers;
  }
```
(Note: `computeFrontier` already sets `this.frontier = frontier`; keep that so `pick`'s current fallback still works during the transition. The lane's `visible` and `this.frontier` are the same array on the LOD path.)

- [ ] **Step 3: Route `setTransform` emit through the lane**

In `setTransform`, replace the direct `this.emitInstancedLayers(backend, this.lodLayers(...))` with the lane:
```ts
    if (backend?.setInstancedLayer && this.lodReady() && this.graph) {
      this.transform = t;
      if (!this.lane) this.rebuildLane();
      this.emitInstancedLayers(backend, this.lane!.update(t, this.width, this.height));
    }
    return super.setTransform(t);
```
Do the same substitution in `rebuild()`'s `lodReady()` branch (`layers = this.lane!.update(this.transform, this.width, this.height)` after ensuring `this.lane`).

- [ ] **Step 4: Route `pick()`'s LOD branch through the lane**

In the `pick()` override, replace the inline `pickFrontier(...)` call with the lane (keeping the leaf/aggregate datum mapping):
```ts
    if (this.lodReady() && this.lodTree && this.lane) {
      const g = this.lane.pick(x, y, this.transform);
      if (g < 0) return null;
      const aggregate = g >= this.lodTree.leafCount;
      return { layer: "nodes", id: g, datum: { aggregate, count: this.lodTree.count[g]! } satisfies NetworkHit };
    }
```

- [ ] **Step 5: Invalidate the lane when the tree/style/graph changes**

Set `this.lane = null` anywhere `this.lodTree`/style/graph is invalidated (in `data()`, `style()`, `lod()`, and the non-LOD branches of `rebuild()` that set `this.frontier = null`). It is lazily rebuilt on the next `setTransform`/`rebuild`.

- [ ] **Step 6: Run the characterization + full network suites to verify ZERO change**

Run:
```
cd packages/d3gl && node scripts/run-browser-tests.mjs src/network/__tests__/lane-characterization.browser.test.ts src/network/__tests__/network.browser.test.ts src/network/__tests__/worker-lod-mainthread.browser.test.ts
```
Expected: all PASS (characterization unchanged ⇒ no behaviour drift). Then node suite + typecheck:
```
cd <worktree> && npx vitest run packages/d3gl && pnpm --filter @mapequation/d3gl exec tsc -b
```
Expected: green; `tsc` exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/d3gl/src/network/network.ts
git commit -m "refactor(d3gl): network LOD frontier adopts the shared InstancedLane (#108)"
```

---

### Task 4: Changeset + PR

- [ ] **Step 1: Changeset**

```md
<!-- .changeset/instanced-lane-core.md -->
---
"@mapequation/d3gl": patch
---

Internal: introduce `core/InstancedLane` (the `select → emit → pick` orchestration) and adopt it in the `network()` LOD frontier. No behaviour change — groundwork for unifying picking/declutter/`plot.points()` onto one shared instanced lane (#108).
```

- [ ] **Step 2: Verify the whole package once more** (node + browser network suite + typecheck + build), open PR.

PR body: scope = "extract lane core, network adopts, zero behaviour change"; **Performance** section: lane adds one indirection (closure call) per `setTransform` and per `pick`; no extra per-frame allocation (the strategy returns the same frontier array network already built); memory O(1) (one retained `visible` reference). Title `refactor(d3gl): core InstancedLane + network adoption (#108)`. Body `Refs #108`. Stop for approval.

---

## Roadmap (later slices — separate plans)

- **#108-B:** `BaseEngine` owns a registry of `InstancedLane`s parallel to Scene `hitIndexes`; `setTransform` drives `lane.update()`, `pick()` resolves lanes uniformly → network's `pick()` override + `setTransform` override dissolve into the shared path. Enables N7c multi-select across engines.
- **#108-C:** `plot.points()` builds a lane with a `cullAll`/`declutter` strategy + a circles emit; instanced on WebGL, Scene retained for SVG/Canvas export + back-compat; preserve `pickable`/HoverHit/datum + the declutter/scatter examples.
- **#108-D:** declutter reframed as a strategy with index-compaction (drop flag-discard for instanced); declutter examples scale further; optional LOD super-points for large scatter; website docs.

## Self-review notes

- **Spec coverage (A):** core lane abstraction (T1), zero-behaviour-change guard (T2/T3), network adoption (T3). #108's plot.points/declutter scope is explicitly deferred to C/D — A only proves the abstraction on the existing consumer per the agreed sequencing.
- **Type consistency:** `LaneTransform` is structurally compatible with `LODTransform`/`ViewTransform` ({k,x,y}); `SelectionStrategy.select/pick` signatures match `cut`+`declutterFrontier` (via `computeFrontier`) and `pickFrontier`. `frontierLayers` is the renamed tail of `lodLayers` (same return type `InstancedLayer[]`).
- **Risk:** the lazy `this.lane = null` invalidation must cover every tree/style/graph mutation, else a stale closure draws old geometry — the characterization test + existing worker-LOD/style-change tests guard this.
