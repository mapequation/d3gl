# Shared instanced-selection lane — #108-C (plot.points declutter → instanced) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Render `plot.points()` declutter layers via the shared `InstancedLane` (index-compaction) on WebGL, so a decluttered scatter's draw cost is ∝ the *kept* set, not total N — closing #108's done-when ("declutter examples scale further via index compaction"). Everything else (`layer()`, non-declutter points, `clipTo` layers, vector backends, passThrough) stays exactly as today.

**Architecture (safe-auto, decided):** A points layer routes to the instanced lane **iff** `declutter` is set AND the backend is WebGL (`setInstancedLayer`) AND no `clipTo` AND not `passThrough` AND **no `hover` and no `selection`** (those rely on Scene-overlay auto-highlight / Scene restyle, which the instanced lane can't render until N7c). Such a layer registers a lane (declutter `SelectionStrategy` → kept indices; emit gathers an `InstancedCirclesData` from the kept set; `pick` does point-in-circle over the kept set; `resolve(i)` → `{layer, id, datum}`) instead of Scene drawables, so it is **not** double-drawn. All other points layers keep the current Scene path (so `clipTo` GPU-stencil, `toSVG` serialization, plain rendering, hover-highlight, and selection restyle are byte-for-byte unchanged). On vector backends a declutter points layer also stays Scene (flag-discard), so SVG/Canvas export is unchanged. The lane is the BaseEngine-owned registry from #108-B — `setTransform` already drives it and `pick()` already resolves it; C only supplies plot's strategy + emit + resolve.

**Why exclude `hover`/`selection` (not just defer):** `declutter + hover-highlight` is a real, used pattern — e.g. the **Ancestral ranges** example (screen mode) declutters and hover-highlights — though today it's via `chart.layer()` (custom pie draw), which C never touches. To be safe for any `points()` layer that combines `declutter + hover`/`selection`, those layers **stay on the Scene path** (full auto-highlight + selection restyle preserved). The lane serves the pure-scale case: a decluttered scatter with no per-point highlight/selection (e.g. the 1M `declutter-points` example, `pickable:false`). **`tooltip` is allowed on lane layers** (it works via the lane's `resolve` datum — and C adds a test proving it). Instanced hover-highlight + selection for lane layers arrive with N7c (#105), at which point the predicate can widen.

**Tech Stack:** TS ESM (`.js` specifiers). Vitest node (root config) + browser (`packages/d3gl/scripts/run-browser-tests.mjs`). Typecheck `pnpm --filter @mapequation/d3gl exec tsc -b`. Website build `pnpm --filter @d3gl/website build`.

---

## Scope & non-goals
- **In:** a points-SoA circles emitter + a declutter selection strategy (`core` or `map`); `plot.points()` routing (declutter+WebGL+no-clipTo → lane, else Scene); adapt the `points()` declutter test's read mechanism; website declutter-points example confirmed to scale via the lane.
- **Out:** `layer()` (untouched), non-declutter points (untouched), `clipTo`/vector/passThrough points (Scene, untouched), instanced auto-highlight (N7c), declutterScreen returning indices natively (kept as flags + convert; #108-D may revisit), super-points LOD for scatter (#108-D).

## File structure
- **Create** `packages/d3gl/src/map/points-lane.ts` — `plotPointsCircles(...)` (SoA gather → `InstancedCirclesData`) + `declutterPointsStrategy(...)` (`SelectionStrategy`: cull+declutter `select`, point-in-circle `pick`). Pure, no engine state. (Lives in `map/` since it's plot-specific; reuses `core/declutter.ts` + `core/instanced-lane.ts` types.)
- **Create** `packages/d3gl/src/map/__tests__/points-lane.test.ts` — node unit tests for both.
- **Modify** `packages/d3gl/src/map/plot.ts` — `points()` routes to the lane when eligible; supplies emit/strategy/resolve; keeps Scene path otherwise.
- **Modify** `packages/d3gl/src/map/declutter.browser.test.ts` — the `points()` declutter case: read the lane's kept set instead of `scene.buffers().flags` (same brute-force-reference assertion).

---

### Task 1: points-SoA circles emit + declutter strategy (pure, TDD)

**Files:** Create `packages/d3gl/src/map/points-lane.ts` + `packages/d3gl/src/map/__tests__/points-lane.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// packages/d3gl/src/map/__tests__/points-lane.test.ts
import { describe, it, expect } from "vitest";
import { plotPointsCircles, declutterPointsStrategy } from "../points-lane.js";

const X = [0, 10, 20, 100];
const Y = [0, 0, 0, 0];
const R = [4, 4, 4, 4];
const xOf = (_d: number, i: number) => X[i]!;
const yOf = (_d: number, i: number) => Y[i]!;
const rOf = (_d: number, i: number) => R[i]!;
const data = [0, 1, 2, 3];

describe("plotPointsCircles (#108-C)", () => {
  it("gathers x/y/r/color into InstancedCirclesData for the given visible indices", () => {
    const c = plotPointsCircles(data, Uint32Array.from([0, 3]), xOf, yOf, rOf, () => "#ff0000", 2);
    expect(c.count).toBe(2);
    expect(Array.from(c.centers)).toEqual([0, 0, 100, 0]);
    expect(Array.from(c.radii)).toEqual([4, 4]);
    expect(Array.from(c.colors.slice(0, 4))).toEqual([255, 0, 0, 255]);
  });
});

describe("declutterPointsStrategy (#108-C)", () => {
  const strat = declutterPointsStrategy(data, xOf, yOf, () => 5 /*declutterPx*/, undefined, 900, 450);
  it("select drops points overlapping a higher-priority kept point (screen space)", () => {
    // k=1: points at x=0,10,20 are within 5px declutter radius of each other → only the first-priority
    // survives among the cluster; x=100 is far → kept. (priority = input order; lower index wins.)
    const vis = strat.select({ k: 1, x: 0, y: 0 }, 900, 450);
    expect(Array.from(vis)).toContain(0);
    expect(Array.from(vis)).toContain(3);
    expect(Array.from(vis)).not.toContain(1); // within 5px of point 0
  });
  it("select returns more points as zoom separates them", () => {
    const vis = strat.select({ k: 10, x: 0, y: 0 }, 900, 450); // x=0,100,200 px apart → all kept
    expect(Array.from(vis).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
  it("pick resolves the visible point under a screen point, -1 on miss / on a deselected point", () => {
    const t = { k: 10, x: 0, y: 0 };
    const vis = strat.select(t, 900, 450);
    expect(strat.pick(100, 0, t, vis)).toBe(1); // point 1 at screen x=100
    expect(strat.pick(50, 0, t, vis)).toBe(-1); // gap
  });
});
```
(declutter radius semantics: `declutterScreen` excludes when `dist < (rᵢ+rⱼ)·spacing`; the strategy passes the per-point declutter px as the exclusion radius the same way `cullDeclutter` does — match `base-engine.ts` `cullDeclutter`'s call: `radius = declutterPx/2`, `spacing = 1`. Tune the test's expected numbers to that convention while writing.)

- [ ] **Step 2: Run → fail** (`cd <wt> && npx vitest run packages/d3gl/src/map/__tests__/points-lane.test.ts`).

- [ ] **Step 3: Implement `points-lane.ts`.**

```ts
import { declutterScreen, makeDeclutterScratch } from "./declutter.js"; // verify exact exports (scratch factory name) in core/declutter.ts and adjust
import type { SelectionStrategy, LaneTransform } from "../core/instanced-lane.js";
import type { InstancedCirclesData } from "../core/backend.js";
import { rgb } from "d3-color";

/** Gather a points datum array into instanced-circle SoA for the given visible indices (index compaction). */
export function plotPointsCircles<D>(
  data: readonly D[],
  visible: Uint32Array,
  xOf: (d: D, i: number) => number,
  yOf: (d: D, i: number) => number,
  rOf: (d: D, i: number) => number,
  fillOf: (d: D, i: number) => string,
  count: number,
): InstancedCirclesData {
  const centers = new Float32Array(count * 2);
  const radii = new Float32Array(count);
  const colors = new Uint8Array(count * 4);
  for (let j = 0; j < count; j++) {
    const i = visible[j]!;
    centers[j * 2] = xOf(data[i]!, i);
    centers[j * 2 + 1] = yOf(data[i]!, i);
    radii[j] = rOf(data[i]!, i);
    const c = rgb(fillOf(data[i]!, i));
    colors[j * 4] = c.r; colors[j * 4 + 1] = c.g; colors[j * 4 + 2] = c.b; colors[j * 4 + 3] = Math.round((c.opacity ?? 1) * 255);
  }
  return { centers, radii, colors, count };
}

/**
 * Declutter selection strategy for a plot points layer: `select` projects each point to screen, runs
 * the shared screen-space declutter (kept = higher-priority glyphs; overlaps dropped), and returns the
 * KEPT indices (index compaction). `pick` is exact point-in-circle over the kept set (screen space).
 * Reuses `core/declutter.ts` so behaviour matches the existing flag-discard path exactly — only the
 * application differs (compacted draw vs hidden-but-drawn). Importance = input order (priority desc).
 */
export function declutterPointsStrategy<D>(
  data: readonly D[],
  xOf: (d: D, i: number) => number,
  yOf: (d: D, i: number) => number,
  declutterPxOf: (d: D, i: number) => number,
  order: ArrayLike<number> | undefined,
  width: number,
  height: number,
): SelectionStrategy {
  const n = data.length;
  const sx = new Float64Array(n), sy = new Float64Array(n), rad = new Float64Array(n);
  const flags = new Uint8Array(n);
  const scratch = makeDeclutterScratch(); // verify factory name
  const project = (t: LaneTransform) => {
    for (let i = 0; i < n; i++) { sx[i] = xOf(data[i]!, i) * t.k + t.x; sy[i] = yOf(data[i]!, i) * t.k + t.y; rad[i] = declutterPxOf(data[i]!, i) / 2; }
  };
  return {
    select: (t) => {
      project(t);
      declutterScreen(n, sx, sy, rad, order, width, height, 1, flags, scratch);
      let k = 0; for (let i = 0; i < n; i++) if (flags[i]) k++;
      const out = new Uint32Array(k); let w = 0;
      for (let i = 0; i < n; i++) if (flags[i]) out[w++] = i;
      return out;
    },
    pick: (px, py, t, visible) => {
      let found = -1;
      for (const i of visible) {
        const dx = px - (xOf(data[i]!, i) * t.k + t.x), dy = py - (yOf(data[i]!, i) * t.k + t.y);
        const r = declutterPxOf(data[i]!, i) / 2; // hit radius = the drawn (screen) point radius — see note
        if (dx * dx + dy * dy <= r * r) found = i; // last = topmost
      }
      return found;
    },
  };
}
```
NOTE on the pick hit-radius: the DRAWN point radius (`opts.radius`, in screen px under `sizeMode:"screen"`) is the correct hit radius — NOT the declutter exclusion radius. Pass the resolved point radius accessor into the strategy for `pick` (and keep the declutter px for `select`). Adjust the signature to take BOTH a `pointRadiusOf` (for pick + emit) and `declutterPxOf` (for select). Fix the test accordingly.

- [ ] **Step 4: Run → pass.** `pnpm --filter @mapequation/d3gl exec tsc -b` → 0.
- [ ] **Step 5: Commit** (`git -C <wt>`, no Co-Authored-By): `feat(d3gl): plot points-lane circles emit + declutter selection strategy (#108)`.

---

### Task 2: route plot.points() declutter layers to the instanced lane

**Files:** Modify `packages/d3gl/src/map/plot.ts` + `packages/d3gl/src/map/declutter.browser.test.ts`

**Step 0 — Baseline:** `cd <wt>/packages/d3gl && node scripts/run-browser-tests.mjs src/map/declutter.browser.test.ts src/map/plot-interaction.browser.test.ts src/map/plot.browser.test.ts src/map/plot-append.browser.test.ts` (note counts) + `npx vitest run packages/d3gl` + the instanced-lane-registry suite.

- [ ] **Step 1: Eligibility + lane registration in `points()`.** In `plot.ts` `points()`, compute `const useLane = !opts.passThrough && !opts.clipTo && !opts.hover && !opts.selection && opts.declutter != null && !!this.backend()?.setInstancedLayer;` (tooltip is allowed). When `useLane`:
  - Resolve accessors (`xOf`/`yOf`/`pointRadiusOf`/`fillOf`/`idOf`) and `data`/`ids` as the Scene path does.
  - Build `const strategy = declutterPointsStrategy(data, xOf, yOf, pointRadiusOf, declutterPxOf, order, this.width, this.height)`.
  - `this.registerInstancedLane("points:" + name, { lane: new InstancedLane(strategy, (vis) => [{ name: "points:" + name, primitive: "circles", circles: plotPointsCircles(data, vis, xOf, yOf, pointRadiusOf, fillOf, vis.length), sizeMode: opts.sizeMode ?? "world" }]), layerNames: ["points:" + name], dynamic: true, resolve: opts.pickable === false ? () => null : (i) => ({ layer: name, id: ids[i]!, datum: data[i] }) })`.
  - IF `opts.tooltip` is set, ALSO register a minimal `LayerSpec` via `registerLayer` with the SAME `name`, `data`, `ids`, `tooltip: opts.tooltip`, `pickable: false` (no Scene HitIndex — the lane owns pick), and a **no-op `build`** (emits no Scene geometry) — so BaseEngine's tooltip dispatch + datum lookup resolve `hit.layer === name`. (No `hover`/`selection` here — `useLane` already excluded those, so there's no empty-overlay surprise.) If no tooltip, no spec is needed (the lane fully owns draw + pick).
  - Return the `LayerHandle` as usual.
  When NOT `useLane`: the existing Scene/passThrough path, unchanged.

  NB resolve uses `layer: name` (not "points:"+name) so the hit maps to the user's LayerSpec for tooltip/hover; the lane's layer NAME is "points:"+name only to namespace the GPU layer.

- [ ] **Step 2: Adapt the `points()` declutter test.** In `declutter.browser.test.ts`, the test that uses `chart.points(...)` with `declutter` (≈line 131) currently reads `eng.scene.buffers("pts").flags`. On WebGL that layer is now a lane. Change that assertion to read the kept set from the lane and compare to the SAME `referenceVisible(...)`:
  ```ts
  const lane = (chart as any).instancedLanes.get("points:pts").lane;
  const kept = new Set(Array.from(lane.visible as Uint32Array));
  const engineVisible = nodes.map((_, i) => kept.has(i));
  expect(engineVisible).toEqual(ref); // same brute-force reference, same behaviour
  ```
  (The `chart.layer(...)` declutter test is untouched — `layer()` stays Scene/flags.) This preserves the asserted BEHAVIOUR (kept set == reference); only the read path changes because the draw path changed.
  Also ADD a small case: a `points()` layer with `declutter` + `tooltip` (no hover/selection) on WebGL → after a `pointermove` over a kept point, the shared tooltip shows (proves tooltip works through the lane's `resolve` datum + the no-op spec). And a `points()` layer with `declutter` + `hover` → assert it did NOT route to the lane (stayed Scene): e.g. `(chart as any).instancedLanes.has("points:" + name)` is false and the Scene auto-highlight still works on hover. This pins the hover/selection exclusion.

- [ ] **Step 3: Verify ZERO regression** (rerun Step 0 commands; non-declutter points + layer() declutter + interaction + append must match baseline; the adapted points-declutter test passes against the reference). `tsc -b` → 0. Then **website build** (`pnpm --filter @d3gl/website build`) to confirm the declutter-points + scatterplot examples compile + the declutter-points example now renders via the lane.
- [ ] **Step 4: Commit** `refactor(d3gl): plot.points() declutter layers render via the shared instanced lane (#108)`.

---

### Task 3: changeset + PR

- [ ] **Step 1: Changeset** `.changeset/plot-points-instanced-declutter.md` (minor):
```md
---
"@mapequation/d3gl": minor
---

Decluttered `plot.points()` scatters now render through the shared instanced lane on WebGL (#108-C): draw cost is proportional to the *kept* (post-declutter) set rather than total N (index compaction instead of draw-all-then-hide), so dense decluttered scatters scale much further. This applies only to declutter layers that don't need Scene-only features: plain points, `clipTo` layers, `hover`/`selection` layers, vector (SVG/Canvas) backends, and `passThrough` all keep the existing Scene path, so `clipTo` stencil, `toSVG` export, hover-highlight, and selection restyle are unaffected. `tooltip` works on instanced declutter layers. (Instanced hover-highlight + selection — letting those layers also use the lane — come with the instanced-highlight work.)
```
- [ ] **Step 2:** Full verify (node + map browser suites + website build + tsc + tsdown build), open PR. Title `refactor(d3gl): plot.points() declutter via shared instanced lane (#108-C)`. Body: scope; **Performance** (decluttered scatter draw cost ∝ kept set, not N; select runs once per setTransform = O(N) project + O(N) declutter, same as today's flag path, but the GPU draws only kept; pick O(kept); memory O(kept) for the emitted buffer + O(N) reusable scratch in the strategy); **verification** (runnable example: declutter-points scales via the lane; existing suites unchanged + new points-lane unit tests). `Refs #108` (this closes #108's done-when — consider `Closes #108` only if D is folded in; otherwise Refs). Stop for approval.

---

## Roadmap (after C)
- **#108-D:** optionally make `declutterScreen` return indices natively (drop flag→index conversion); LOD super-points for huge scatter; docs. Then #108 closes.
- **N7c** (separate, #105): instanced auto-highlight + multi-select — gives instanced declutter layers their hover-highlight overlay + selection.

## Self-review notes
- **Done-when coverage:** plot.points declutter renders via the lane (index compaction) — T1 (emit+strategy) + T2 (routing). No-regression: only declutter+WebGL+no-clipTo points move; `layer()`, plain points, clipTo, vector, passThrough untouched (asserted by the unchanged suites).
- **Type consistency:** `declutterPointsStrategy` returns `SelectionStrategy` (#108-A); `plotPointsCircles` returns `InstancedCirclesData`; lane registered via BaseEngine `registerInstancedLane` (#108-B) with `resolve → {layer: name, id, datum}`.
- **Verify-while-writing:** exact `core/declutter.ts` exports (`declutterScreen` args + the scratch factory name) — confirm and fix the import/scratch call in Task 1. Confirm `plot.points` accessor-resolution helpers to reuse for xOf/yOf/radius/fill/ids.
- **Flagged touch-points:** (1) the minimal no-op LayerSpec (tooltip-only) for tooltip dispatch on lane layers — verify BaseEngine tooltip path resolves via `hit.layer` + datum without a Scene HitIndex (pickable:false); a test pins it. (2) pick hit-radius = drawn point radius, NOT declutter px. (3) **`hover`/`selection` declutter points() layers stay on the Scene path** (full auto-highlight + selection restyle preserved) — the lane serves pure-scale declutter scatters only; instanced hover-highlight/selection widen the predicate in N7c. `declutter + hover-highlight` is a real pattern (Ancestral ranges, via `layer()` — untouched by C); the exclusion makes it safe for `points()` too.
