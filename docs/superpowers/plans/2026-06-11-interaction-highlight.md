# Interaction: hover highlight, click selection, tooltips — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add efficient interactive styling to d3gl — `click` event, per-drawable style overrides with a styles-only render path, stateful `select()` with complement dimming, engine-managed hover highlight (style or custom draw), core tooltips, clip-aware picking — and rework two website examples on top of it.

**Architecture:** All engine logic lives on `BaseEngine`/`GeoMap` (`packages/d3gl/src/map/`). Overrides compose CSS colors over accessor base colors into the Scene's existing per-drawable RGBA tables; a new `Backend.updateLayerStyles` uploads only those tables (WebGL: existing `GroupRenderer.updateColors` texture rewrite). Hover highlight copies the hovered drawable's already-projected subpaths into a tiny per-source overlay group — O(one feature) per hover change, base layer untouched. Spec: `docs/superpowers/specs/2026-06-11-interaction-highlight-design.md`.

**Tech Stack:** TypeScript ESM monorepo (pnpm), vitest (node unit tests at repo root; `*.browser.test.ts` via Playwright through `pnpm --filter @mapequation/d3gl test:browser`), luma.gl WebGL2 backend, Astro/Starlight website.

---

## Working environment (read first)

- **Worktree:** all work happens in `/Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction` on branch `feat/interaction-highlight`. `cd` there at session start. It needs `pnpm install` once (Task 0).
- **Git:** ALWAYS use `git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction …` — never bare `git` commands (the shell cwd can silently reset to the primary repo, and a bare `git add -A` would then commit to `main`). Never add a co-author line to commits.
- **Commands** (run from the worktree root):
  - Unit tests: `pnpm vitest run <path>` (root config covers `packages/*/src/**/*.test.ts` and `website/src/**/*.test.ts`; `*.browser.test.ts` excluded).
  - Browser tests: `pnpm --filter @mapequation/d3gl test:browser <src-relative-path>` (watchdog runner; extra args are forwarded to vitest, so a file path filters the run). Full suite: no args, ~25 s.
  - Typecheck: `pnpm --filter @mapequation/d3gl exec tsc -b` (root `pnpm typecheck` is known-broken; don't use it).
  - Website build: `pnpm --filter @d3gl/website build` (from the worktree, NOT the main repo).
- **Code style:** the codebase uses dense explanatory comments stating constraints/why (see `base-engine.ts`). Match that; don't narrate what the next line does.

### File map

| File | Change |
| --- | --- |
| `packages/d3gl/src/core/scene.ts` | Add `StyleTables`, `Scene.styleTables()`, `Scene.drawableOf()` (refactor `drawables()` body into `vectorAt`) |
| `packages/d3gl/src/core/backend.ts` | Add optional `Backend.updateLayerStyles` |
| `packages/d3gl/src/core/index.ts` | Export `StyleTables` |
| `packages/d3gl/src/webgl/renderer.ts` | `updateColors` parameter type `GroupBuffers` → `StyleTables` |
| `packages/d3gl/src/webgl/webgl-backend.ts` | Implement `updateLayerStyles` |
| `packages/d3gl/src/canvas/canvas-backend.ts` | Implement `updateLayerStyles` |
| `packages/d3gl/src/svg/svg-backend.ts` | Implement `updateLayerStyles` |
| `packages/d3gl/src/map/style-overrides.ts` | NEW: `StyleOverride`, `SelectionOption`, `composeColor` |
| `packages/d3gl/src/map/highlight.ts` | NEW: `HighlightStyle`, `HoverOption`, `HighlightDraw`, `HighlightBuilder`, `resolveHighlight`, `HIGHLIGHT_SUFFIX` |
| `packages/d3gl/src/map/tooltip.ts` | NEW: `Tooltip` class |
| `packages/d3gl/src/map/base-engine.ts` | id→index map, `setStyle`/`clearStyle`/`select`/`highlight`/`on("click")`, unified pointer pipeline, clip-aware `pick`, overlay push, tooltip wiring |
| `packages/d3gl/src/map/geo-map.ts` | `LayerOptions` += `hover`/`tooltip`/`selection`; `GeoMapOptions` += `tooltipClass`; drop-state + passThrough guard |
| `packages/d3gl/src/map/plot.ts` | Drop-state call in retained layer registration |
| `packages/d3gl/src/map/index.ts` | New exports |
| `packages/d3gl/src/core/style-tables.test.ts` | NEW unit tests |
| `packages/d3gl/src/map/style-overrides.test.ts` | NEW unit tests |
| `packages/d3gl/src/map/highlight-builder.test.ts` | NEW unit tests |
| `packages/d3gl/src/webgl/webgl-backend.browser.test.ts` | Add `updateLayerStyles` test |
| `packages/d3gl/src/map/interaction.browser.test.ts` | NEW: engine-level browser tests (grows across tasks) |
| `website/src/examples/shared/geo-data.ts` | Named rivers; `centreCells()` moved here |
| `website/src/examples/map-projections/draw.ts` | Import `centreCells` from shared |
| `website/src/examples/geojson-features/draw.ts` | Cells layer + tooltips |
| `website/src/examples/highlight/*` (renamed from `heatmap/`) | Remade example |
| `website/src/content/docs/examples/map/highlight.mdx` (renamed) | New page |
| `website/src/content/docs/interaction.mdx` | NEW docs page |
| `website/astro.config.mjs` | Sidebar entries |
| `.changeset/interaction-highlight.md` | NEW: minor bump |

---

### Task 0: Worktree setup

- [ ] **Step 1: Install dependencies in the worktree**

```bash
cd /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction
pnpm install
```

Expected: completes without errors (shared pnpm store; fast).

- [ ] **Step 2: Sanity-run the existing suites**

```bash
pnpm vitest run packages/d3gl/src/core
pnpm --filter @mapequation/d3gl test:browser src/map/geo-map.browser.test.ts
```

Expected: PASS (baseline green before any change).

---

### Task 1: `Scene.styleTables()` + `Scene.drawableOf()`

**Files:**
- Modify: `packages/d3gl/src/core/scene.ts`
- Modify: `packages/d3gl/src/core/index.ts`
- Test: `packages/d3gl/src/core/style-tables.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// packages/d3gl/src/core/style-tables.test.ts
import { describe, it, expect } from "vitest";
import { Scene } from "./scene.js";

describe("Scene.styleTables / Scene.drawableOf", () => {
  const build = (): Scene => {
    const scene = new Scene();
    scene.group("g", (g) => {
      g.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10));
      g.point("b", 20, 20, 3);
    });
    scene.setFill("g", "a", "rgb(255,0,0)");
    return scene;
  };

  it("returns just the per-drawable tables, detached from the scene", () => {
    const scene = build();
    const t = scene.styleTables("g");
    expect(t.fillColors).toBeInstanceOf(Uint8Array);
    expect(t.fillColors.length).toBe(2 * 4);
    expect([...t.fillColors.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(t.flags.length).toBe(2);
    // Detached snapshot: later scene writes don't mutate it.
    scene.setFill("g", "a", "rgb(0,255,0)");
    expect(t.fillColors[1]).toBe(0);
  });

  it("looks up one drawable by id in O(1), null when absent", () => {
    const scene = build();
    const d = scene.drawableOf("g", "a");
    expect(d?.id).toBe("a");
    expect(d?.fill).toEqual([255, 0, 0, 255]);
    expect(d?.subpaths.length).toBeGreaterThan(0);
    const p = scene.drawableOf("g", "b");
    expect(p?.circles).toEqual([{ x: 20, y: 20, r: 3 }]);
    expect(scene.drawableOf("g", "missing")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm vitest run packages/d3gl/src/core/style-tables.test.ts
```

Expected: FAIL — `styleTables is not a function`.

- [ ] **Step 3: Implement in `scene.ts`**

Add after the `GroupBufferDelta` interface (near line 77):

```ts
/** Just the per-drawable style tables (colors + flags) as detached typed arrays —
 *  O(drawableCount), for styles-only backend updates. Never the O(total-vertices)
 *  {@link Scene.buffers} rebuild: geometry hasn't changed, only how it's painted. */
export interface StyleTables {
  fillColors: Uint8Array;
  strokeColors: Uint8Array;
  flags: Uint8Array;
}
```

In `class Scene`, refactor `drawables()` so its loop body becomes a private `vectorAt`, and add the two methods:

```ts
  /** Build the vector view of one drawable at index `i` (shared by drawables()/drawableOf()). */
  private vectorAt(data: GroupData, i: number): DrawableVector {
    return {
      id: data.ids[i]!,
      subpaths: data.subpaths[i]!,
      fill: [data.fillColors[i * 4]!, data.fillColors[i * 4 + 1]!, data.fillColors[i * 4 + 2]!, data.fillColors[i * 4 + 3]!],
      stroke: [data.strokeColors[i * 4]!, data.strokeColors[i * 4 + 1]!, data.strokeColors[i * 4 + 2]!, data.strokeColors[i * 4 + 3]!],
      lineWidth: data.lineWidths[i]!,
      lineJoin: data.joins[i]!,
      miterLimit: data.miterLimits[i]!,
      lineCap: data.caps[i]!,
      flags: data.flags[i]!,
      circles: data.circles[i]!,
      anchor: data.anchors[i]!,
    };
  }

  /** The vector view of ONE drawable by domain id, or null when the id has no
   *  drawable (unknown, or culled at build time). O(1) lookup. */
  drawableOf(name: string, id: string | number): DrawableVector | null {
    const data = this.get(name);
    const i = data.idToDrawable.get(id);
    return i === undefined ? null : this.vectorAt(data, i);
  }

  /** Snapshot the per-drawable color/flag tables (see {@link StyleTables}). */
  styleTables(name: string): StyleTables {
    const data = this.get(name);
    return {
      fillColors: new Uint8Array(data.fillColors),
      strokeColors: new Uint8Array(data.strokeColors),
      flags: new Uint8Array(data.flags),
    };
  }
```

`drawables()` becomes:

```ts
  drawables(name: string, from = 0): DrawableVector[] {
    const data = this.get(name);
    const out: DrawableVector[] = [];
    for (let i = Math.max(0, from); i < data.ids.length; i++) out.push(this.vectorAt(data, i));
    return out;
  }
```

In `packages/d3gl/src/core/index.ts` line 28, add `StyleTables` to the scene type exports:

```ts
export type { GroupBuffers, GroupBufferDelta, GroupBuilder, DrawableRange, DrawableOpts, DrawableVector, StyleTables } from "./scene.js";
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run packages/d3gl/src/core
```

Expected: PASS (new file + all existing core tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add packages/d3gl/src/core
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(core): Scene.styleTables + drawableOf for styles-only updates"
```

---

### Task 2: `style-overrides.ts` — types + `composeColor`

**Files:**
- Create: `packages/d3gl/src/map/style-overrides.ts`
- Test: `packages/d3gl/src/map/style-overrides.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// packages/d3gl/src/map/style-overrides.test.ts
import { describe, it, expect } from "vitest";
import { composeColor } from "./style-overrides.js";

describe("composeColor", () => {
  it("passes the base through untouched when there is no override", () => {
    expect(composeColor("#ff0000", undefined, undefined)).toBe("#ff0000");
  });
  it("override color replaces the base", () => {
    expect(composeColor("#ff0000", "#00ff00", undefined)).toBe("#00ff00");
  });
  it("opacity multiplies the base alpha, keeping the hue", () => {
    expect(composeColor("rgba(255, 0, 0, 0.5)", undefined, 0.5)).toBe("rgba(255, 0, 0, 0.25)");
    expect(composeColor("#ff0000", undefined, 0.3)).toBe("rgba(255, 0, 0, 0.3)");
  });
  it("opacity applies to the override color when both are set", () => {
    expect(composeColor("#ff0000", "#0000ff", 0.5)).toBe("rgba(0, 0, 255, 0.5)");
  });
  it("returns null when there is nothing to paint", () => {
    expect(composeColor(undefined, undefined, 0.3)).toBeNull();
    expect(composeColor(undefined, undefined, undefined)).toBeNull();
  });
  it("clamps opacity products into [0, 1] and rejects invalid colors", () => {
    expect(composeColor("#ff0000", undefined, 4)).toBe("rgb(255, 0, 0)");
    expect(() => composeColor("not-a-color", undefined, 0.5)).toThrow(/invalid color/);
  });
});
```

Note: d3-color's `rgb(...).toString()` formats opaque colors as `rgb(r, g, b)` and translucent as `rgba(r, g, b, a)`; the test for clamping above relies on that. Verify the exact strings when the test runs and adjust expectations to d3-color's actual output if they differ — the BEHAVIOR (clamp, multiply) is what matters.

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm vitest run packages/d3gl/src/map/style-overrides.test.ts
```

Expected: FAIL — cannot resolve `./style-overrides.js`.

- [ ] **Step 3: Implement**

```ts
// packages/d3gl/src/map/style-overrides.ts
import { rgb } from "d3-color";

/** Bulk per-drawable style override, composed over the base colors the layer's
 *  fill/stroke accessors produce. Colors only — stroke geometry has its width baked
 *  in at tessellation time, so a bulk width change would be O(n) re-tessellation
 *  (widths are available in the single-item highlight overlay instead). */
export interface StyleOverride {
  /** Replaces the base fill (any CSS color). */
  fill?: string;
  /** Replaces the base stroke. */
  stroke?: string;
  /** Multiplies the base alpha (0..1) — dimming keeps each drawable's own hue. */
  opacity?: number;
}

/** Styles for {@link BaseEngine.select}: the selected set and its complement.
 *  Defaults: `selected` keeps the base style (items stand out because the others
 *  dim); `others` is `{ opacity: 0.3 }`. */
export interface SelectionOption {
  selected?: StyleOverride;
  others?: StyleOverride;
}

/**
 * Compose one channel: the override color (if any) replaces the base, then `opacity`
 * multiplies the result's alpha. Returns the CSS color to write, or null when there
 * is nothing to paint (no base and no override color — opacity alone can't conjure
 * a color). The no-opacity path returns the source string untouched (no parse cost).
 */
export function composeColor(
  base: string | undefined,
  overrideColor: string | undefined,
  opacity: number | undefined,
): string | null {
  const src = overrideColor ?? base;
  if (src === undefined) return null;
  if (opacity === undefined) return src;
  const c = rgb(src);
  if (Number.isNaN(c.r)) throw new Error(`invalid color: ${src}`);
  const a = Number.isNaN(c.opacity) ? 1 : c.opacity;
  c.opacity = Math.max(0, Math.min(1, a * opacity));
  return c.toString();
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run packages/d3gl/src/map/style-overrides.test.ts
```

Expected: PASS (adjust string expectations to d3-color's real formatting if needed — behavior must hold).

- [ ] **Step 5: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add packages/d3gl/src/map/style-overrides.ts packages/d3gl/src/map/style-overrides.test.ts
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(map): StyleOverride/SelectionOption types + composeColor"
```

---

### Task 3: `layerIds` Set → id→index Map (O(1) datum lookup)

**Files:**
- Modify: `packages/d3gl/src/map/base-engine.ts:51,121,219-232,436`

This is a pure refactor verified by the existing suite; `restyle` (Task 4) and `pick` need O(1) id→index.

- [ ] **Step 1: Change the field (line 49-51)**

```ts
  /** Per-layer id → datum index, maintained incrementally so an append's duplicate-id
   *  check stays O(new) (not O(total)/batch) AND so pick()/restyle resolve a datum
   *  index in O(1) instead of spec.ids.indexOf (O(n) per pointer move). */
  private layerIds = new Map<string, Map<string | number, number>>();
```

- [ ] **Step 2: Update `registerLayer` (line 121)**

```ts
    this.layerIds.set(spec.name, new Map(spec.ids.map((id, i) => [id, i])));
```

- [ ] **Step 3: Update `appendToLayer` (lines 219, 232-233)**

Line 219 seeding fallback:

```ts
    const existing = this.layerIds.get(name) ?? new Map(spec.ids.map((id, i) => [id, i]));
```

Replace the commit loop (`for (const key of seen) existing.add(key);`) with:

```ts
    ids.forEach((id, j) => existing.set(id, dataStart + j)); // commit ids to the persistent map
```

(The `seen` Set stays for duplicate validation.)

- [ ] **Step 4: Update `pick` (line 435-436)** — replace `const di = spec.ids.indexOf(id);` with:

```ts
        const di = this.layerIds.get(spec.name)?.get(id) ?? -1;
```

- [ ] **Step 5: Run the affected suites**

```bash
pnpm --filter @mapequation/d3gl test:browser src/map/geo-map.browser.test.ts src/map/geo-map-append.browser.test.ts src/map/plot-append.browser.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add packages/d3gl/src/map/base-engine.ts
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "refactor(map): layerIds as id->index map (O(1) datum lookup in pick)"
```

---

### Task 4: `Backend.updateLayerStyles` on all three backends

**Files:**
- Modify: `packages/d3gl/src/core/backend.ts`
- Modify: `packages/d3gl/src/webgl/renderer.ts:660`, `packages/d3gl/src/webgl/webgl-backend.ts`
- Modify: `packages/d3gl/src/canvas/canvas-backend.ts`, `packages/d3gl/src/svg/svg-backend.ts`
- Test: `packages/d3gl/src/webgl/webgl-backend.browser.test.ts` (add a test)

- [ ] **Step 1: Write the failing browser test**

First read the top of `packages/d3gl/src/webgl/webgl-backend.browser.test.ts` and reuse its backend/Scene setup helpers. Add a test of this shape (adapt helper names to the file's existing ones):

```ts
it("updateLayerStyles recolors without geometry re-upload", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 100; canvas.height = 100;
  const backend = await WebGLBackend.create(canvas, { width: 100, height: 100 });
  const scene = new Scene();
  scene.group("g", (g) => g.drawable("a", (ctx) => ctx.rect(10, 10, 40, 40)));
  scene.setFill("g", "a", "rgb(255,0,0)");
  backend.setLayers([{ name: "g", buffers: scene.buffers("g"), drawables: scene.drawables("g") }]);
  expect(backend.readPixel(30, 30).slice(0, 3)).toEqual([255, 0, 0]);

  scene.setFill("g", "a", "rgba(0, 0, 255, 0.5)");
  backend.updateLayerStyles!("g", scene.styleTables("g"), scene.drawables("g"));
  const px = backend.readPixel(30, 30);
  expect(px[2]).toBeGreaterThan(100); // blue, alpha-blended
  expect(px[0]).toBe(0);
  // toSVG reads the stored drawables — they must be refreshed too.
  expect(backend.toSVG()).toContain("0, 0, 255");
  backend.destroy();
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @mapequation/d3gl test:browser src/webgl/webgl-backend.browser.test.ts
```

Expected: the new test FAILS (`updateLayerStyles` undefined); existing tests pass.

- [ ] **Step 3: Add the interface method** in `packages/d3gl/src/core/backend.ts` — import `StyleTables` in the type import on line 1, then inside `interface Backend` after `updateLayer`:

```ts
  /**
   * Styles-only fast path (optional): the per-drawable color/flag tables changed but
   * geometry did not (recolor / dim / show-hide). `drawables` is the refreshed vector
   * view (same drawables, same order) so vector-reading consumers (Canvas redraw, SVG
   * serialize, toSVG export) stay in sync with the raster output. Backends without it
   * are driven through `updateLayer` (full re-upload).
   */
  updateLayerStyles?(name: string, tables: StyleTables, drawables: DrawableVector[]): void;
```

- [ ] **Step 4: Loosen `GroupRenderer.updateColors`** in `packages/d3gl/src/webgl/renderer.ts` (line ~660): change the parameter type from `GroupBuffers` to `StyleTables` (add `StyleTables` to the type imports from `../core/index.js`). The body already reads only `fillColors`/`strokeColors`/`flags`; `GroupBuffers` remains structurally assignable, so the existing `updateLayer` call site compiles unchanged. Update `writePointTables`'s caller accordingly (it already takes the two arrays — no change needed there).

- [ ] **Step 5: Implement in `webgl-backend.ts`** (after `updateLayer`; import `StyleTables`, `DrawableVector` types):

```ts
  /** Styles-only update: rewrite the palette/flags textures, refresh the stored vector
   *  view (toSVG reads it), leave geometry buffers untouched. */
  updateLayerStyles(name: string, tables: StyleTables, drawables: DrawableVector[]): void {
    const renderer = this.renderers.get(name);
    if (!renderer) return;
    renderer.updateColors(tables);
    const prev = this.layers.get(name);
    if (prev) this.layers.set(name, { ...prev, drawables });
    this.bakeDirty = true;
  }
```

- [ ] **Step 6: Implement in `canvas-backend.ts`** (after `updateLayer`; import `StyleTables`):

```ts
  /** Styles-only update: swap the stored vector view (the next render() repaints from
   *  it). Visibility flags feed the clip silhouette, so drop this layer's cached clip. */
  updateLayerStyles(name: string, _tables: StyleTables, drawables: DrawableVector[]): void {
    const layer = this.layers.find((l) => l.name === name);
    if (!layer) return;
    layer.drawables = drawables;
    this.clipCache.delete(name);
  }
```

- [ ] **Step 7: Implement in `svg-backend.ts`** (after `updateLayer`; import `StyleTables`, `DrawableVector`):

```ts
  /** Styles-only update: swap the stored vector view and re-serialize on next render(). */
  updateLayerStyles(name: string, _tables: StyleTables, drawables: DrawableVector[]): void {
    const i = this.layers.findIndex((l) => l.name === name);
    if (i < 0) return;
    this.layers[i] = { ...this.layers[i]!, drawables };
    this.dirty = true;
  }
```

- [ ] **Step 8: Run the test + typecheck**

```bash
pnpm --filter @mapequation/d3gl exec tsc -b
pnpm --filter @mapequation/d3gl test:browser src/webgl/webgl-backend.browser.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add packages/d3gl/src/core/backend.ts packages/d3gl/src/webgl packages/d3gl/src/canvas/canvas-backend.ts packages/d3gl/src/svg/svg-backend.ts
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(backends): updateLayerStyles styles-only fast path"
```

---

### Task 5: Engine `setStyle`/`clearStyle`, override persistence, fast `recolor`

**Files:**
- Modify: `packages/d3gl/src/map/base-engine.ts`
- Modify: `packages/d3gl/src/map/geo-map.ts` (drop-state in `layer()`)
- Modify: `packages/d3gl/src/map/plot.ts` (drop-state in retained registration)
- Test: `packages/d3gl/src/map/interaction.browser.test.ts` (new)

- [ ] **Step 1: Write the failing browser tests**

```ts
// packages/d3gl/src/map/interaction.browser.test.ts
import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { geoMap, type GeoMap } from "./geo-map.js";

const proj = () => geoEquirectangular().scale(50).translate([100, 100]);
const sqPoly = (x: number, y: number, s: number): GeoJSON.Feature => ({
  type: "Feature", properties: {},
  geometry: { type: "Polygon", coordinates: [[[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]]] },
});

/** Read one pixel from the canvas backend's surface (dpr is 1 in the test browser). */
function pixelAt(host: HTMLElement, x: number, y: number): Uint8ClampedArray {
  const canvas = host.querySelector("canvas")!;
  return canvas.getContext("2d")!.getImageData(x, y, 1, 1).data;
}

async function makeMap(): Promise<{ map: GeoMap; host: HTMLDivElement }> {
  const host = document.createElement("div");
  host.style.width = "200px"; host.style.height = "200px";
  document.body.appendChild(host);
  const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas" });
  await map.whenReady();
  return { map, host };
}

// Two squares: c0 over proj([-20,-20])..proj([0,0]) ≈ x 82..100, y 100..117;
// c1 over proj([0,0])..proj([20,20]) ≈ x 100..117, y 82..100.
// Probe centers: c0 ≈ (91, 109), c1 ≈ (108, 91).
function addCells(map: GeoMap): void {
  map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], {
    fill: (_f, i) => (i === 0 ? "rgb(255,0,0)" : "rgb(0,0,255)"),
    id: (_f, i) => `c${i}`,
  });
  map.render();
}

describe("setStyle / clearStyle", () => {
  it("applies fill/opacity overrides per drawable and restores on clear", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 0, 255]);

    map.setStyle("cells", "c1", { fill: "rgb(0,255,0)" });
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);
    expect([...pixelAt(host, 91, 109)].slice(0, 3)).toEqual([255, 0, 0]); // c0 untouched

    map.setStyle("cells", ["c0", "c1"], { opacity: 0.3 });
    const dim = pixelAt(host, 91, 109);
    expect(dim[0]).toBe(255);                 // hue kept
    expect(dim[3]).toBeGreaterThan(50);       // ~0.3 alpha
    expect(dim[3]).toBeLessThan(110);

    map.clearStyle("cells");
    expect(pixelAt(host, 91, 109)[3]).toBe(255);
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 0, 255]);
    map.destroy();
  });

  it("overrides survive setProjection, and recolor() reapplies them over fresh accessors", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    map.setStyle("cells", "c0", { opacity: 0.3 });
    map.setProjection(proj()); // re-projects + re-runs accessors
    expect(pixelAt(host, 91, 109)[3]).toBeLessThan(110);
    map.recolor("cells");
    expect(pixelAt(host, 91, 109)[3]).toBeLessThan(110);
    map.destroy();
  });

  it("re-declaring the layer drops its overrides", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    map.setStyle("cells", "c0", { opacity: 0.3 });
    addCells(map); // map.layer(...) again
    expect(pixelAt(host, 91, 109)[3]).toBe(255);
    map.destroy();
  });
});
```

Note on probe coordinates: equirectangular scale 50 ⇒ 20° ≈ 17.45 px. If a probe lands on a cell edge, nudge it toward the cell center — verify against `map.pick(x, y)` returning the expected id before asserting pixels.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @mapequation/d3gl test:browser src/map/interaction.browser.test.ts
```

Expected: FAIL — `map.setStyle is not a function`.

- [ ] **Step 3: Implement in `base-engine.ts`**

Imports at top:

```ts
import { composeColor, type StyleOverride, type SelectionOption } from "./style-overrides.js";
```

Field next to `layerIds`:

```ts
  /** Per-layer style overrides (id → override), composed over the base accessor colors.
   *  Survive rebuilds (reapplied after applyAccessors); dropped when the layer is
   *  re-declared via layer() (its ids may change). */
  private styleOverrides = new Map<string, Map<string | number, StyleOverride>>();
```

Public + private methods (place after `recolor`):

```ts
  /** Override the style of one drawable or a set (replaces any previous override for
   *  those ids — last write wins). O(ids) compose + one styles-only push. */
  setStyle(name: string, ids: string | number | readonly (string | number)[], override: StyleOverride): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    const list: readonly (string | number)[] = Array.isArray(ids) ? ids : [ids as string | number];
    let map = this.styleOverrides.get(name);
    if (!map) { map = new Map(); this.styleOverrides.set(name, map); }
    for (const id of list) map.set(id, override);
    this.restyle(spec, list);
    this.pushStyles(spec);
    return this;
  }

  /** Remove overrides (all of the layer's when `ids` is omitted) and restore base styles. */
  clearStyle(name: string, ids?: string | number | readonly (string | number)[]): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    const map = this.styleOverrides.get(name);
    if (!map || map.size === 0) return this;
    const list: readonly (string | number)[] =
      ids === undefined ? [...map.keys()] : Array.isArray(ids) ? ids : [ids as string | number];
    for (const id of list) map.delete(id);
    this.restyle(spec, list);
    this.pushStyles(spec);
    return this;
  }

  /** Recompose + write the effective colors for `ids`: base accessor value with the
   *  current override (if any) applied. Ids without a drawable (culled) are skipped. */
  private restyle(spec: LayerSpec, ids: readonly (string | number)[]): void {
    const map = this.styleOverrides.get(spec.name);
    const index = this.layerIds.get(spec.name);
    for (const id of ids) {
      const i = index?.get(id);
      if (i === undefined || this.scene.drawableOf(spec.name, id) === null) continue;
      const o = map?.get(id) ?? {};
      const d = spec.data[i]!;
      const fill = composeColor(this.resolve(spec.fill, d, i), o.fill, o.opacity);
      this.scene.setFill(spec.name, id, fill ?? "rgba(0,0,0,0)");
      const stroke = composeColor(this.resolve(spec.stroke, d, i), o.stroke, o.opacity);
      this.scene.setStroke(spec.name, id, stroke ?? "rgba(0,0,0,0)");
    }
  }

  /** Re-write all of a layer's overrides (after applyAccessors reset the tables). */
  private reapplyOverrides(spec: LayerSpec): void {
    const map = this.styleOverrides.get(spec.name);
    if (map && map.size > 0) this.restyle(spec, [...map.keys()]);
  }

  /** Styles-only backend push (tables + refreshed vector views); falls back to a full
   *  updateLayer for backends without the fast path. Skips hidden-mid-gesture layers
   *  (the gesture-end rebuild re-pushes them). */
  private pushStyles(spec: LayerSpec): void {
    if (this.interacting && spec.hideOnInteraction) return;
    const backend = this.handle?.backend;
    if (!backend) return;
    if (backend.updateLayerStyles) {
      backend.updateLayerStyles(spec.name, this.scene.styleTables(spec.name), this.scene.drawables(spec.name));
    } else {
      backend.updateLayer(spec.name, this.renderLayer(spec));
    }
    this.render();
  }

  /** Forget per-layer interaction state (overrides; later: highlights). Called when a
   *  layer is RE-DECLARED (its ids may change) — not on a rebuild of the same data. */
  protected dropInteractionState(name: string): void {
    this.styleOverrides.delete(name);
  }
```

In `registerLayer` (line ~110), after `this.applyAccessors(spec);` add:

```ts
    this.reapplyOverrides(spec); // rebuilds (rotation/projection) keep overrides
```

Rewrite `recolor` to use the fast path (replacing the `updateLayer` + `render` block):

```ts
  recolor(name: string): this {
    // Pass-through layers aren't in `specs` (no retained Scene geometry); their color comes
    // from the data callback each repaint, so a repaint IS the recolor.
    if (this.ptSpecs.has(name)) { this.repaintPassThrough(name); return this; }
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    this.applyAccessors(spec);
    this.reapplyOverrides(spec);
    this.pushStyles(spec); // styles-only: geometry can't have changed under a recolor
    return this;
  }
```

- [ ] **Step 4: Drop state on re-declare** — in `geo-map.ts` `layer()` retained path (line ~134, just before `this.defs = this.defs.filter(...)`):

```ts
    this.dropInteractionState(name); // a re-declared layer starts with base styles
```

In `plot.ts`, find every retained registration path (`registerLayer(` call sites in `layer()` and `points()`; check with `grep -n "registerLayer" packages/d3gl/src/map/plot.ts`) and add the same `this.dropInteractionState(name);` line at the start of each (skip the passThrough branch).

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @mapequation/d3gl test:browser src/map/interaction.browser.test.ts src/map/geo-map.browser.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add packages/d3gl/src/map
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(map): setStyle/clearStyle per-drawable overrides + fast recolor"
```

---

### Task 6: `on("click")` with drag suppression

**Files:**
- Modify: `packages/d3gl/src/map/base-engine.ts:420-427,444-459`
- Test: `packages/d3gl/src/map/interaction.browser.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to interaction.browser.test.ts)

```ts
function pointer(host: HTMLElement, type: string, x: number, y: number): void {
  const r = host.getBoundingClientRect();
  host.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
}

describe("on(click)", () => {
  it("fires with the picked hit on a stationary click; a drag does not fire", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    const clicks: ({ layer: string; id: string | number } | null)[] = [];
    map.on("click", (hit) => clicks.push(hit ? { layer: hit.layer, id: hit.id } : null));

    pointer(host, "pointerdown", 108, 91);
    pointer(host, "pointerup", 108, 91);
    expect(clicks).toEqual([{ layer: "cells", id: "c1" }]);

    pointer(host, "pointerdown", 108, 91);
    pointer(host, "pointerup", 130, 110); // > 4px travel: a drag, not a click
    expect(clicks.length).toBe(1);

    pointer(host, "pointerdown", 10, 10); // empty space
    pointer(host, "pointerup", 10, 10);
    expect(clicks[1]).toBeNull();
    map.destroy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @mapequation/d3gl test:browser src/map/interaction.browser.test.ts`. Expected: FAIL (on("click") not handled — typed only for "hover").

- [ ] **Step 3: Implement.** Fields near `hoverCb` (line 56):

```ts
  private clickCb: ((hit: HoverHit | null, ev: PointerEvent) => void) | null = null;
  /** pointerdown position; a pointerup within CLICK_SLOP px of it is a click. */
  private downAt: [number, number] | null = null;
  /** Max pointer travel (px) between down and up for a click — suppresses pan/rotate drags. */
  private static CLICK_SLOP = 4;
```

Replace `on(...)` (line 420):

```ts
  on(event: "hover" | "click", cb: (hit: HoverHit | null, ev: PointerEvent) => void): this {
    if (event === "hover") {
      this.hoverCb = cb;
      this.host.addEventListener("pointermove", this.onPointerMove);
      this.host.addEventListener("pointerleave", this.onPointerLeave);
    } else if (event === "click") {
      this.clickCb = cb;
      this.host.addEventListener("pointerdown", this.onPointerDown);
      this.host.addEventListener("pointerup", this.onPointerUp);
    }
    return this;
  }
```

Handlers next to `onPointerMove`:

```ts
  private onPointerDown = (e: PointerEvent): void => { this.downAt = [e.clientX, e.clientY]; };
  private onPointerUp = (e: PointerEvent): void => {
    const d = this.downAt;
    this.downAt = null;
    if (!d || !this.clickCb) return;
    if (Math.hypot(e.clientX - d[0], e.clientY - d[1]) > BaseEngine.CLICK_SLOP) return;
    const r = this.host.getBoundingClientRect();
    this.clickCb(this.pick(e.clientX - r.left, e.clientY - r.top), e);
  };
```

In `destroy()` (line 454), alongside the existing removals:

```ts
    this.host.removeEventListener("pointerdown", this.onPointerDown);
    this.host.removeEventListener("pointerup", this.onPointerUp);
```

- [ ] **Step 4: Run tests** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add packages/d3gl/src/map/base-engine.ts packages/d3gl/src/map/interaction.browser.test.ts
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(map): on(click) event with drag suppression"
```

---

### Task 7: Clip-aware picking

**Files:**
- Modify: `packages/d3gl/src/map/base-engine.ts:428-440`
- Test: `packages/d3gl/src/map/interaction.browser.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```ts
describe("clip-aware pick", () => {
  it("a clipped layer only hits where its clip source is also hit", async () => {
    const { map } = await makeMap();
    // "land" mask covers only the c1 square's area; cells cover both squares.
    map.layer("land", [sqPoly(0, 0, 20)], { fill: "#eee" });
    map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], {
      fill: "rgb(0,0,255)", id: (_f, i) => `c${i}`, clipTo: "land",
    });
    map.render();
    expect(map.pick(108, 91)?.id).toBe("c1");        // on the mask: cell hit
    expect(map.pick(91, 109)?.layer).toBe(undefined); // c0 is clipped away entirely → no hit at all
    map.destroy();
  });
});
```

(`map.pick(91, 109)` returns null there — nothing under it once the cell is excluded — so assert `expect(map.pick(91, 109)).toBeNull()` instead if `?.layer` reads awkwardly. Use `toBeNull()`.)

- [ ] **Step 2: Run to verify failure** — currently `pick(91,109)` returns the clipped cell `c0`. Expected: FAIL.

- [ ] **Step 3: Implement** — in `pick()` replace the loop body:

```ts
  pick(x: number, y: number): HoverHit | null {
    const px = (x - this.transform.x) / this.transform.k;
    const py = (y - this.transform.y) / this.transform.k;
    for (let i = this.specs.length - 1; i >= 0; i--) {
      const spec = this.specs[i]!;
      const id = this.hitIndexes.get(spec.name)?.pick(px, py);
      if (id == null) continue;
      // Visually clipped away ⇒ not a hit: with clipTo, the point must also fall on the
      // clip source's geometry. Skipped when the source has no hit index (pickable:false).
      if (spec.clipTo) {
        const clip = this.hitIndexes.get(spec.clipTo);
        if (clip && clip.pick(px, py) == null) continue;
      }
      const di = this.layerIds.get(spec.name)?.get(id) ?? -1;
      return { layer: spec.name, id, datum: di >= 0 ? spec.data[di] : null };
    }
    return null;
  }
```

- [ ] **Step 4: Run tests** — interaction + geo-map suites. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add packages/d3gl/src/map/base-engine.ts packages/d3gl/src/map/interaction.browser.test.ts
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "fix(map): pick respects clipTo (no hits on visually clipped geometry)"
```

---

### Task 8: `select()` + `selection` layer option

**Files:**
- Modify: `packages/d3gl/src/map/base-engine.ts` (LayerSpec + select)
- Modify: `packages/d3gl/src/map/geo-map.ts` (LayerOptions + buildSpec)
- Test: `packages/d3gl/src/map/interaction.browser.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```ts
describe("select", () => {
  it("dims the complement, keeps the selected set, clears on null", async () => {
    const { map, host } = await makeMap();
    map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], {
      fill: "rgb(0,0,255)", id: (_f, i) => `c${i}`,
      selection: { others: { opacity: 0.3 } },
    });
    map.render();

    map.select("cells", ["c1"]);
    expect(pixelAt(host, 108, 91)[3]).toBe(255);          // selected: base style
    expect(pixelAt(host, 91, 109)[3]).toBeLessThan(110);  // other: dimmed

    map.select("cells", null);
    expect(pixelAt(host, 91, 109)[3]).toBe(255);

    // Predicate form + selected style.
    map.layer("cells2", [sqPoly(40, -20, 20)], {
      fill: "rgb(0,0,255)", id: () => "x0",
      selection: { selected: { fill: "rgb(255,0,0)" }, others: { opacity: 0.3 } },
    });
    map.render();
    map.select("cells2", () => true);
    // proj([50,-10]) ≈ [143.6, 108.7]
    expect([...pixelAt(host, 143, 108)].slice(0, 3)).toEqual([255, 0, 0]);
    map.destroy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `map.select is not a function`.

- [ ] **Step 3: Implement.** In `base-engine.ts`, add to `LayerSpec` (after `pickable`):

```ts
  /** Styles applied by {@link BaseEngine.select} to the selected set / its complement. */
  selection?: SelectionOption;
```

Add the method after `clearStyle`:

```ts
  /**
   * Select a set of drawables: style members with the layer's `selection.selected`
   * (default: keep base style) and the complement with `selection.others` (default
   * `{ opacity: 0.3 }`). One O(n) compose + one styles-only push — click-time cost
   * only, nothing per frame. `null` clears. NOTE: selection rewrites the layer's
   * whole override map, so it replaces earlier setStyle overrides (one table, last
   * write wins) — and select(null) restores plain base styles.
   */
  select(name: string, set: readonly (string | number)[] | ((d: any, i: number) => boolean) | null): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    this.styleOverrides.delete(name);
    if (set !== null) {
      const members = typeof set === "function"
        ? new Set(spec.ids.filter((_, i) => set(spec.data[i], i)))
        : new Set(set);
      const selected = spec.selection?.selected;
      const others = spec.selection?.others ?? { opacity: 0.3 };
      const map = new Map<string | number, StyleOverride>();
      for (const id of spec.ids) {
        const o = members.has(id) ? selected : others;
        if (o) map.set(id, o);
      }
      this.styleOverrides.set(name, map);
    }
    this.restyle(spec, spec.ids);
    this.pushStyles(spec);
    return this;
  }
```

In `geo-map.ts`: add to `LayerOptions` (after `passThrough`):

```ts
  /** Styles for {@link GeoMap.select}: the selected set and its complement.
   *  Defaults: selected keeps the base style; others `{ opacity: 0.3 }`. */
  selection?: SelectionOption;
```

with `import type { SelectionOption } from "./style-overrides.js";` — and pass it through in `buildSpec`'s returned object: `selection: opts.selection,`.

- [ ] **Step 4: Run tests** — interaction suite. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add packages/d3gl/src/map
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(map): select() with selected/others styles from the selection layer option"
```

---

### Task 9: `HighlightBuilder` (unit-testable, no DOM)

**Files:**
- Create: `packages/d3gl/src/map/highlight.ts`
- Test: `packages/d3gl/src/map/highlight-builder.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// packages/d3gl/src/map/highlight-builder.test.ts
import { describe, it, expect } from "vitest";
import { Scene } from "../core/index.js";
import { HighlightBuilder, resolveHighlight, type PendingColor } from "./highlight.js";

function sourceScene(): Scene {
  const scene = new Scene();
  scene.group("src", (g) => {
    g.drawable("sq", (ctx) => ctx.rect(0, 0, 10, 10));
    g.point("pt", 30, 30, 4);
  });
  scene.setFill("src", "sq", "rgb(10,20,30)");
  return scene;
}

describe("HighlightBuilder", () => {
  it("replay copies the source geometry with style overrides; base fill is kept by default", () => {
    const scene = sourceScene();
    const colors: PendingColor[] = [];
    scene.group("hl", (g) => {
      const b = new HighlightBuilder(g, scene.drawableOf("src", "sq")!, colors);
      b.replay({ stroke: "#fff", lineWidth: 2 });
    });
    expect(scene.drawableCount("hl")).toBe(1);
    const d = scene.drawables("hl")[0]!;
    expect(d.subpaths.length).toBeGreaterThan(0);
    expect(d.lineWidth).toBe(2);
    expect(colors[0]!.fill).toBe("rgba(10,20,30,1)"); // kept base fill
    expect(colors[0]!.stroke).toBe("#fff");
  });

  it("replay scales circle drawables; anchor exposes the point center", () => {
    const scene = sourceScene();
    const colors: PendingColor[] = [];
    scene.group("hl", (g) => {
      const b = new HighlightBuilder(g, scene.drawableOf("src", "pt")!, colors);
      expect(b.anchor).toEqual([30, 30]);
      b.replay({ fill: "#fff", radiusScale: 1.5 });
    });
    expect(scene.drawables("hl")[0]!.circles[0]!.r).toBe(6);
  });

  it("path/point record arbitrary geometry; defaultHighlight outlines paths and rings circles", () => {
    const scene = sourceScene();
    const colors: PendingColor[] = [];
    scene.group("hl", (g) => {
      const sq = new HighlightBuilder(g, scene.drawableOf("src", "sq")!, colors);
      sq.path((ctx) => { ctx.arc(5, 5, 8, 0, 2 * Math.PI); ctx.closePath(); }, { stroke: "#f00", lineWidth: 1 });
      sq.point(5, 5, 2);
      sq.defaultHighlight();
      const pt = new HighlightBuilder(g, scene.drawableOf("src", "pt")!, colors);
      pt.defaultHighlight(); // ring just outside the dot
    });
    expect(scene.drawableCount("hl")).toBe(4);
    expect(colors.some((c) => c.stroke === "#fff")).toBe(true);
  });

  it("resolveHighlight maps option forms to draw fns", () => {
    const fn = (): void => {};
    expect(resolveHighlight(fn as any)).toBe(fn);
    expect(typeof resolveHighlight({ stroke: "#fff" })).toBe("function");
    expect(typeof resolveHighlight(true)).toBe("function");
    expect(typeof resolveHighlight(undefined)).toBe("function");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run packages/d3gl/src/map/highlight-builder.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// packages/d3gl/src/map/highlight.ts
import type { GroupBuilder, PathContext, DrawableVector } from "../core/index.js";

/** Layer-name suffix reserved for internal highlight overlay groups. */
export const HIGHLIGHT_SUFFIX = ":highlight";

/** Style for highlight-overlay geometry. Unlike bulk {@link StyleOverride}s,
 *  `lineWidth` IS allowed: only one item is re-tessellated per hover change. */
export interface HighlightStyle {
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  /** Circle drawables only: multiply the point radius (default 1). */
  radiusScale?: number;
}

export type HighlightDraw<F = any> = (datum: F, g: HighlightBuilder) => void;
/** The `hover` layer option: `true` = default style, a style = replay with it,
 *  a function = full custom draw of the hovered item. */
export type HoverOption<F = any> = true | HighlightStyle | HighlightDraw<F>;

/** A color write deferred until the overlay group build commits (Scene.setFill
 *  rejects a group that is still being built). */
export interface PendingColor { id: string; fill?: string; stroke?: string }

const css = (c: readonly [number, number, number, number]): string =>
  `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;

function replaySubpaths(ctx: PathContext, d: DrawableVector): void {
  for (const s of d.subpaths) {
    const p = s.points;
    if (p.length < 2) continue;
    ctx.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
    if (s.closed) ctx.closePath();
  }
}

/**
 * Builder handed to custom hover/highlight draw fns, scoped to ONE source drawable.
 * Everything recorded lands in the overlay group (drawn on top, inheriting the source
 * layer's clipTo/sizeMode). World coordinates throughout. Geometry comes from the
 * Scene's already-projected subpaths/circles — no re-projection, no datum re-processing.
 */
export class HighlightBuilder {
  /** The drawable's glyph anchor, or a point feature's projected center; null for plain paths. */
  readonly anchor: [number, number] | null;
  private n = 0;
  constructor(
    private readonly g: GroupBuilder,
    private readonly d: DrawableVector,
    private readonly colors: PendingColor[],
  ) {
    this.anchor = this.d.anchor ?? (this.d.circles[0] ? [this.d.circles[0].x, this.d.circles[0].y] : null);
  }
  /** Overlay ids: source id + NUL + tag — collision-proof against sibling ids. */
  private nextId(tag: string): string { return `${String(this.d.id)}\u0000${tag}${this.n++}`; }

  /** Re-emit the source drawable's geometry with new styling. Omitted fill/stroke keep
   *  the source's current colors (note: a translucent base fill re-drawn on top of
   *  itself compounds — pass an explicit fill to avoid that). */
  replay(style: HighlightStyle = {}): void {
    const d = this.d;
    const id = this.nextId("r");
    if (d.circles.length > 0) {
      const scale = style.radiusScale ?? 1;
      this.g.points(id, d.circles.map((c) => [c.x, c.y] as [number, number]), (d.circles[0]?.r ?? 0) * scale);
      this.colors.push({ id, fill: style.fill ?? css(d.fill) });
      return;
    }
    this.g.drawable(id, (ctx) => replaySubpaths(ctx, d), {
      lineWidth: style.lineWidth ?? d.lineWidth,
      lineJoin: d.lineJoin,
      miterLimit: d.miterLimit,
      lineCap: d.lineCap,
      anchor: d.anchor ?? undefined,
    });
    this.colors.push({ id, fill: style.fill ?? css(d.fill), stroke: style.stroke ?? css(d.stroke) });
  }

  /** Record an arbitrary path (standard PathContext: moveTo/lineTo/arc/rect/…). */
  path(draw: (ctx: PathContext) => void, style: HighlightStyle = {}): void {
    const id = this.nextId("p");
    this.g.drawable(id, draw, { lineWidth: style.lineWidth ?? 0 });
    this.colors.push({ id, fill: style.fill, stroke: style.stroke });
  }

  /** A filled circle at world (x, y). */
  point(x: number, y: number, radius: number, style: { fill?: string } = {}): void {
    const id = this.nextId("c");
    this.g.point(id, x, y, radius);
    this.colors.push({ id, fill: style.fill ?? "#fff" });
  }

  /** The `hover: true` default: a white outline for paths (fill stays transparent so
   *  translucent bases don't compound); a stroked ring just outside circle drawables
   *  (circles themselves are fill-only). */
  defaultHighlight(): void {
    const d = this.d;
    if (d.circles.length > 0) {
      for (const c of d.circles)
        this.path((ctx) => { ctx.arc(c.x, c.y, c.r * 1.3, 0, 2 * Math.PI); ctx.closePath(); },
          { stroke: "#fff", lineWidth: 1.5 });
      return;
    }
    this.replay({ fill: "rgba(0,0,0,0)", stroke: "#fff", lineWidth: 1.5 });
  }
}

/** Normalize a HoverOption (or nothing) to a draw fn. */
export function resolveHighlight(opt: HoverOption | undefined): HighlightDraw {
  if (typeof opt === "function") return opt;
  if (opt !== undefined && opt !== true) return (_d, g) => g.replay(opt);
  return (_d, g) => g.defaultHighlight();
}
```

- [ ] **Step 4: Run tests** — `pnpm vitest run packages/d3gl/src/map/highlight-builder.test.ts`. Expected: PASS (adjust the `rgba(...)` string expectation to the `css()` helper's exact output).

- [ ] **Step 5: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add packages/d3gl/src/map/highlight.ts packages/d3gl/src/map/highlight-builder.test.ts
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(map): HighlightBuilder + HoverOption resolution"
```

---

### Task 10: `engine.highlight()` + overlay layer plumbing

**Files:**
- Modify: `packages/d3gl/src/map/base-engine.ts`
- Test: `packages/d3gl/src/map/interaction.browser.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

```ts
describe("highlight", () => {
  it("draws the highlighted item on top without touching the base layer; null clears", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    map.highlight("cells", "c1", { fill: "rgb(0,255,0)" });
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);
    expect([...pixelAt(host, 91, 109)].slice(0, 3)).toEqual([255, 0, 0]); // base untouched

    map.highlight("cells", null);
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 0, 255]);
    map.destroy();
  });

  it("array of ids; overlay inherits clipTo; survives a transform re-push", async () => {
    const { map, host } = await makeMap();
    map.layer("land", [sqPoly(0, 0, 20)], { fill: "#eee" });
    map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], {
      fill: "rgb(0,0,255)", id: (_f, i) => `c${i}`, clipTo: "land",
    });
    map.render();
    map.highlight("cells", ["c0", "c1"], { fill: "rgb(0,255,0)" });
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);
    // c0's area is outside the land mask: the overlay is clipped there too.
    expect(pixelAt(host, 91, 109)[3]).toBe(0);
    // A setClip→pushLayers full re-push must keep the overlay (overlays ride along).
    map.setClip("cells", "land");
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);
    map.destroy();
  });

  it("re-resolves against rebuilt geometry on setProjection, drops vanished ids", async () => {
    const { map, host } = await makeMap();
    addCells(map);
    map.highlight("cells", "c1", { fill: "rgb(0,255,0)" });
    map.setProjection(proj());
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);
    map.destroy();
  });

  it("rejects user layer names ending in :highlight", async () => {
    const { map } = await makeMap();
    expect(() => map.layer("bad:highlight", [sqPoly(0, 0, 10)], {})).toThrow(/reserved/);
    map.destroy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `map.highlight is not a function`.

- [ ] **Step 3: Implement in `base-engine.ts`.** Imports:

```ts
import { HighlightBuilder, resolveHighlight, HIGHLIGHT_SUFFIX, type HighlightStyle, type HighlightDraw, type HoverOption, type PendingColor } from "./highlight.js";
```

Add to `LayerSpec` (after `selection`):

```ts
  /** Hover-highlight for this layer: true = default style, a HighlightStyle = replay
   *  with it, a function = custom draw of the hovered item (see HighlightBuilder). */
  hover?: HoverOption;
```

Field next to `styleOverrides`:

```ts
  /** Active highlight per source layer; re-resolved after a rebuild re-projects geometry. */
  private highlights = new Map<string, { ids: (string | number)[]; styleOrDraw?: HighlightStyle | HighlightDraw }>();
```

Name guard at the top of `registerLayer`:

```ts
    if (spec.name.endsWith(HIGHLIGHT_SUFFIX)) throw new Error(`layer name suffix "${HIGHLIGHT_SUFFIX}" is reserved`);
```

…and in `registerLayer`, right after the `this.layerIds.set(...)` line (before `pushLayers()`):

```ts
    // A rebuild (rotation/projection) re-projected the source geometry: rebuild the
    // overlay from the stored ids so the highlight tracks it. (A re-DECLARED layer had
    // its highlight dropped by dropInteractionState first.)
    const active = this.highlights.get(spec.name);
    if (active) this.buildHighlight(spec, active.ids, active.styleOrDraw);
```

Public method + helpers (after `select`):

```ts
  /**
   * Highlight one drawable / a set of drawables of `name` by drawing them into a tiny
   * internal overlay layer on top (inheriting the source's clipTo/sizeMode) — the base
   * layer's buffers are untouched, so the per-change cost is tessellating the
   * highlighted items only. `styleOrDraw` falls back to the layer's `hover` option,
   * then to the default white outline. `null` clears.
   */
  highlight(
    name: string,
    idOrIds: string | number | readonly (string | number)[] | null,
    styleOrDraw?: HighlightStyle | HighlightDraw,
  ): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    if (idOrIds == null) {
      if (!this.highlights.delete(name)) return this; // nothing shown: keep it a no-op
      this.buildHighlight(spec, []);
      this.pushHighlight(spec);
      return this;
    }
    const ids = Array.isArray(idOrIds) ? [...idOrIds] : [idOrIds as string | number];
    this.highlights.set(name, { ids, styleOrDraw });
    this.buildHighlight(spec, ids, styleOrDraw);
    this.pushHighlight(spec);
    return this;
  }

  /** (Re)build the overlay group for `spec` from already-projected Scene geometry. */
  private buildHighlight(spec: LayerSpec, ids: readonly (string | number)[], styleOrDraw?: HighlightStyle | HighlightDraw): void {
    const hlName = spec.name + HIGHLIGHT_SUFFIX;
    const colors: PendingColor[] = [];
    const index = this.layerIds.get(spec.name);
    this.scene.group(hlName, (g) => {
      for (const id of ids) {
        const d = this.scene.drawableOf(spec.name, id);
        if (!d) continue; // unknown or culled id: nothing to highlight
        const b = new HighlightBuilder(g, d, colors);
        const draw = resolveHighlight(styleOrDraw ?? spec.hover);
        const i = index?.get(id) ?? -1;
        draw(i >= 0 ? spec.data[i] : null, b);
      }
    });
    // Colors must wait for the group build to commit (Scene.setFill resolves the group).
    for (const c of colors) {
      if (c.fill) this.scene.setFill(hlName, c.id, c.fill);
      if (c.stroke) this.scene.setStroke(hlName, c.id, c.stroke);
    }
  }

  /** Push one overlay layer (tiny buffers — O(highlighted items), not O(layer)). */
  private pushHighlight(spec: LayerSpec): void {
    const backend = this.handle?.backend;
    if (!backend) return; // pre-install: installBackend pushes overlays with setLayers
    backend.updateLayer(spec.name + HIGHLIGHT_SUFFIX, this.overlayRenderLayer(spec));
    this.render();
  }

  private overlayRenderLayer(spec: LayerSpec): RenderLayer {
    const hlName = spec.name + HIGHLIGHT_SUFFIX;
    return { name: hlName, buffers: this.scene.buffers(hlName), drawables: this.scene.drawables(hlName), clipTo: spec.clipTo, sizeMode: spec.sizeMode };
  }

  /** Overlay layers to render after all user layers (skipping hidden-mid-gesture sources). */
  private overlayRenderLayers(): RenderLayer[] {
    const out: RenderLayer[] = [];
    for (const name of this.highlights.keys()) {
      const spec = this.specs.find((s) => s.name === name);
      if (!spec || (this.interacting && spec.hideOnInteraction)) continue;
      out.push(this.overlayRenderLayer(spec));
    }
    return out;
  }
```

Make every full backend push include overlays. Add:

```ts
  /** Everything the backend should draw: user layers in declaration order, then
   *  highlight overlays on top. */
  private allRenderLayers(): RenderLayer[] {
    return [...this.renderSpecs().map((s) => this.renderLayer(s)), ...this.overlayRenderLayers()];
  }
```

— and use it in BOTH `pushLayers()` (line ~496: `this.handle?.backend.setLayers(this.allRenderLayers());`) and `installBackend` (line ~550: `next.backend.setLayers(this.allRenderLayers());`).

Extend `dropInteractionState`:

```ts
  protected dropInteractionState(name: string): void {
    this.styleOverrides.delete(name);
    this.highlights.delete(name);
  }
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @mapequation/d3gl test:browser src/map/interaction.browser.test.ts
```

Expected: PASS. **If the clear-highlight path throws inside the WebGL backend** (a `GroupRenderer` built from all-empty buffers), the supported fix is in `GroupRenderer`: guard pass creation on zero counts (it already models "all passes null" for empty layers — see `webgl-backend.ts:126-134` comments). Don't special-case the engine.

- [ ] **Step 5: Run the equivalence + full map suites** (overlay layers must flow through globe bake, SVG serialize, canvas clip):

```bash
pnpm --filter @mapequation/d3gl test:browser src/map
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add packages/d3gl/src/map
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(map): highlight() overlay — per-item redraw on top, base layer untouched"
```

---

### Task 11: Unified pointer pipeline + `hover` layer option

**Files:**
- Modify: `packages/d3gl/src/map/base-engine.ts:420-427,461-466` (pointer pipeline), `setInteracting`
- Modify: `packages/d3gl/src/map/geo-map.ts` (LayerOptions.hover + buildSpec)
- Test: `packages/d3gl/src/map/interaction.browser.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

```ts
describe("hover option", () => {
  it("auto-highlights the hovered drawable, no-ops within it, clears on leave", async () => {
    const { map, host } = await makeMap();
    map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], {
      fill: (_f, i) => (i === 0 ? "rgb(255,0,0)" : "rgb(0,0,255)"),
      id: (_f, i) => `c${i}`,
      hover: { fill: "rgb(0,255,0)" },
    });
    map.render();

    pointer(host, "pointermove", 108, 91);
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);

    pointer(host, "pointermove", 110, 92); // same cell: still highlighted
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);

    pointer(host, "pointermove", 91, 109); // crossed into c0
    expect([...pixelAt(host, 91, 109)].slice(0, 3)).toEqual([0, 255, 0]);
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 0, 255]); // c1 restored

    pointer(host, "pointermove", 10, 10);  // empty space clears
    expect([...pixelAt(host, 91, 109)].slice(0, 3)).toEqual([255, 0, 0]);

    pointer(host, "pointermove", 108, 91);
    host.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 0, 255]);
    map.destroy();
  });

  it("hover works without any on(hover) callback registered", async () => {
    const { map, host } = await makeMap();
    map.layer("cells", [sqPoly(0, 0, 20)], { fill: "rgb(0,0,255)", id: () => "c1", hover: { fill: "rgb(0,255,0)" } });
    map.render();
    pointer(host, "pointermove", 108, 91);
    expect([...pixelAt(host, 108, 91)].slice(0, 3)).toEqual([0, 255, 0]);
    map.destroy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — hover option ignored (no listener attached). Expected: FAIL.

- [ ] **Step 3: Implement.** Fields:

```ts
  /** Last hover pick, for cheap same-target exits while the pointer stays inside one drawable. */
  private lastHover: HoverHit | null = null;
  /** Source layer whose hover-option highlight is currently shown (auto, not manual). */
  private autoHover: string | null = null;
```

Attach helper + registerLayer hook (after the highlight-rebuild block in `registerLayer`):

```ts
    if (spec.hover || spec.tooltip) this.attachPointer(); // tooltip lands in the next task
```

```ts
  /** Idempotent: addEventListener dedupes on the same handler reference. */
  private attachPointer(): void {
    this.host.addEventListener("pointermove", this.onPointerMove);
    this.host.addEventListener("pointerleave", this.onPointerLeave);
  }
```

(`spec.tooltip` doesn't exist until Task 12 — write the hook as `if (spec.hover) this.attachPointer();` now and extend it in Task 12.) Replace the `on("hover")` branch's two addEventListener lines with `this.attachPointer();`.

Replace `onPointerMove`/`onPointerLeave`:

```ts
  private onPointerMove = (e: PointerEvent): void => {
    if (this.interacting) return; // gesture frames skip picking entirely
    if (!this.hoverCb && !this.specs.some((s) => s.hover)) return;
    const r = this.host.getBoundingClientRect();
    const hit = this.pick(e.clientX - r.left, e.clientY - r.top);
    this.hoverCb?.(hit, e);
    if (hit?.layer !== this.lastHover?.layer || hit?.id !== this.lastHover?.id) {
      this.lastHover = hit;
      this.applyAutoHover(hit);
    }
  };

  /** Show the hover-option highlight for the picked drawable; clear the previous one. */
  private applyAutoHover(hit: HoverHit | null): void {
    const spec = hit ? this.specs.find((s) => s.name === hit.layer) : undefined;
    const target = spec?.hover ? spec.name : null;
    if (this.autoHover && this.autoHover !== target) this.highlight(this.autoHover, null);
    if (target && hit) this.highlight(target, hit.id);
    else if (target) this.highlight(target, null);
    this.autoHover = target;
  }

  private onPointerLeave = (e: PointerEvent): void => {
    this.hoverCb?.(null, e);
    this.clearHoverState();
  };

  /** Drop transient hover artifacts (highlight; tooltip in the next task). */
  private clearHoverState(): void {
    this.lastHover = null;
    if (this.autoHover) { this.highlight(this.autoHover, null); this.autoHover = null; }
  }
```

(The `if (target && hit) … else if (target)` branch handles same-layer `hover` with a vanished pick — keep it even though `target` is only non-null when `hit` exists; it guards future multi-consumer edits. If lint flags it as unreachable, simplify to `if (target && hit) this.highlight(target, hit.id);`.)

In `setInteracting` (line ~315), right after `this.interacting = v;`:

```ts
    if (v) this.clearHoverState(); // a drag/zoom hides hover artifacts immediately
```

In `geo-map.ts`: `LayerOptions` gains (with `import type { HoverOption } from "./highlight.js";`):

```ts
  /** Hover-highlight: true = default white outline, a HighlightStyle = redraw the
   *  hovered item with it, or a custom (datum, HighlightBuilder) draw fn. Rendered in
   *  a tiny overlay layer — O(hovered item) per change, the base layer is untouched. */
  hover?: HoverOption<F>;
```

…and `buildSpec` passes `hover: opts.hover,`.

- [ ] **Step 4: Run tests** — interaction suite. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add packages/d3gl/src/map
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(map): hover layer option — engine-managed auto-highlight"
```

---

### Task 12: Tooltips (`tooltip` option + `tooltipClass`)

**Files:**
- Create: `packages/d3gl/src/map/tooltip.ts`
- Modify: `packages/d3gl/src/map/base-engine.ts`, `packages/d3gl/src/map/geo-map.ts`
- Test: `packages/d3gl/src/map/interaction.browser.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

```ts
describe("tooltip option", () => {
  it("shows accessor content on hover, follows the pointer, hides off-target", async () => {
    const { map, host } = await makeMap();
    map.layer("cells", [sqPoly(-20, -20, 20), sqPoly(0, 0, 20)], {
      fill: "rgb(0,0,255)", id: (_f, i) => `c${i}`,
      tooltip: (_f, id) => `cell ${id}`,
    });
    map.render();

    pointer(host, "pointermove", 108, 91);
    const tip = host.querySelector(".d3gl-tooltip") as HTMLDivElement;
    expect(tip).toBeTruthy();
    expect(tip.textContent).toBe("cell c1");
    expect(tip.style.display).not.toBe("none");
    const left0 = tip.style.left;

    pointer(host, "pointermove", 110, 93); // same cell: content stays, position tracks
    expect(tip.textContent).toBe("cell c1");
    expect(tip.style.left).not.toBe(left0);

    pointer(host, "pointermove", 10, 10); // off the layer
    expect(tip.style.display).toBe("none");

    map.destroy();
    expect(host.querySelector(".d3gl-tooltip")).toBeNull();
  });

  it("tooltipClass replaces the default look; null content hides", async () => {
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);
    const map = geoMap(host, { width: 200, height: 200, projection: proj(), backend: "canvas", tooltipClass: "my-tip" });
    await map.whenReady();
    map.layer("cells", [sqPoly(0, 0, 20)], {
      fill: "#00f", id: () => "c1",
      tooltip: () => null,
    });
    map.render();
    pointer(host, "pointermove", 108, 91);
    const tip = host.querySelector(".d3gl-tooltip") as HTMLDivElement | null;
    // null content: tooltip never shown (element may not even exist yet).
    expect(tip?.style.display ?? "none").toBe("none");
    map.destroy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — tooltip option unknown. Expected: FAIL.

- [ ] **Step 3: Implement `tooltip.ts`**

```ts
// packages/d3gl/src/map/tooltip.ts

/** A single shared, absolutely-positioned, pointer-events-none tooltip div in the
 *  host. Created lazily on first show; default inline look unless a className is
 *  given (then styling is entirely the caller's). Always carries `d3gl-tooltip`. */
export class Tooltip {
  private el: HTMLDivElement | null = null;
  constructor(private readonly host: HTMLElement, private readonly className?: string) {}

  private ensure(): HTMLDivElement {
    if (this.el) return this.el;
    const el = document.createElement("div");
    el.className = this.className ? `d3gl-tooltip ${this.className}` : "d3gl-tooltip";
    el.style.position = "absolute";
    el.style.pointerEvents = "none";
    el.style.display = "none";
    el.style.zIndex = "10";
    if (!this.className) {
      el.style.background = "rgba(255, 255, 255, 0.95)";
      el.style.border = "1px solid #ccc";
      el.style.borderRadius = "3px";
      el.style.padding = "2px 6px";
      el.style.font = "12px system-ui, sans-serif";
      el.style.color = "#222";
    }
    this.host.appendChild(el);
    this.el = el;
    return el;
  }

  show(content: string | HTMLElement): void {
    const el = this.ensure();
    if (typeof content === "string") el.textContent = content;
    else el.replaceChildren(content);
    el.style.display = "block";
  }

  /** Position near host-relative (x, y) with a 12px offset, clamped into the host. */
  move(x: number, y: number, hostW: number, hostH: number): void {
    if (!this.el || this.el.style.display === "none") return;
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    this.el.style.left = `${Math.max(0, Math.min(x + 12, hostW - w))}px`;
    this.el.style.top = `${Math.max(0, Math.min(y + 12, hostH - h))}px`;
  }

  hide(): void { if (this.el) this.el.style.display = "none"; }
  destroy(): void { this.el?.remove(); this.el = null; }
}
```

- [ ] **Step 4: Wire into `base-engine.ts`.** Import `Tooltip`. Add to `LayerSpec` (after `hover`):

```ts
  /** Tooltip content for the hovered drawable (string / element / null = hide). */
  tooltip?: (d: any, id: string | number) => string | HTMLElement | null;
```

Fields:

```ts
  private tooltipEl: Tooltip | null = null;
  /** Replaces the tooltip's default inline look when set (e.g. utility classes). */
  protected tooltipClass?: string;
```

Extend the `registerLayer` hook to `if (spec.hover || spec.tooltip) this.attachPointer();`, and the `onPointerMove` early-exit to `if (!this.hoverCb && !this.specs.some((s) => s.hover || s.tooltip)) return;`. In `onPointerMove`, after the changed-target block, add tooltip handling:

```ts
    if (hit?.layer !== this.lastHover?.layer || hit?.id !== this.lastHover?.id) {
      this.lastHover = hit;
      this.applyAutoHover(hit);
      this.updateTooltip(hit);
    }
    this.tooltipEl?.move(e.clientX - r.left, e.clientY - r.top, this.width, this.height);
```

…with:

```ts
  /** Fill/show or hide the tooltip for the (changed) hover target. */
  private updateTooltip(hit: HoverHit | null): void {
    const spec = hit ? this.specs.find((s) => s.name === hit.layer) : undefined;
    const content = spec?.tooltip ? spec.tooltip(hit!.datum, hit!.id) : null;
    if (content == null) { this.tooltipEl?.hide(); return; }
    (this.tooltipEl ??= new Tooltip(this.host, this.tooltipClass)).show(content);
  }
```

Extend `clearHoverState` with `this.tooltipEl?.hide();` and `destroy()` with `this.tooltipEl?.destroy(); this.tooltipEl = null;`.

- [ ] **Step 5: Wire into `geo-map.ts`.** `GeoMapOptions` gains:

```ts
  /** Class(es) for the hover tooltip box, replacing its default inline look. */
  tooltipClass?: string;
```

Constructor: `this.tooltipClass = opts.tooltipClass;` (after `super(...)`). `LayerOptions` gains:

```ts
  /** Hover tooltip content for this layer (null hides). Shown in a shared
   *  engine-managed div — see GeoMapOptions.tooltipClass for styling. */
  tooltip?: (f: F, id: string | number) => string | HTMLElement | null;
```

`buildSpec` passes `tooltip: opts.tooltip,`.

- [ ] **Step 6: Run tests** — interaction suite. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add packages/d3gl/src/map
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(map): core tooltip option + tooltipClass"
```

---

### Task 13: Exports, passThrough guard, full-suite green

**Files:**
- Modify: `packages/d3gl/src/map/index.ts`, `packages/d3gl/src/map/geo-map.ts`
- Test: full suites

- [ ] **Step 1: passThrough guard** — in `geo-map.ts` `layer()` passThrough branch (top, line ~81):

```ts
      if (opts.hover || opts.tooltip || opts.selection)
        throw new Error("hover/tooltip/selection require a retained layer (passThrough layers are not pickable)");
```

Add a test to interaction.browser.test.ts:

```ts
it("rejects hover/tooltip/selection on passThrough layers", async () => {
  const { map } = await makeMap();
  expect(() =>
    map.layer("pt", [sqPoly(0, 0, 5)], { passThrough: true, hover: true }),
  ).toThrow(/passThrough/);
  map.destroy();
});
```

- [ ] **Step 2: Exports** — `packages/d3gl/src/map/index.ts`:

```ts
export type { StyleOverride, SelectionOption } from "./style-overrides.js";
export { HighlightBuilder } from "./highlight.js";
export type { HighlightStyle, HighlightDraw, HoverOption } from "./highlight.js";
export { Tooltip } from "./tooltip.js";
```

- [ ] **Step 3: Typecheck + full test run**

```bash
pnpm --filter @mapequation/d3gl exec tsc -b
pnpm vitest run packages/d3gl
pnpm --filter @mapequation/d3gl test:browser
```

Expected: all PASS (full browser suite ~25 s under the watchdog).

- [ ] **Step 4: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add packages/d3gl/src/map
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(map): export interaction API; reject interaction opts on passThrough"
```

---

### Task 14: Website shared data — named rivers + `centreCells` move

**Files:**
- Modify: `website/src/examples/shared/geo-data.ts:151-169,242-243`
- Modify: `website/src/examples/map-projections/draw.ts:44-48,66`
- Test: `website/src/examples/shared/geo-data.test.ts` (new) — plus run the existing `geo-data.streaming.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// website/src/examples/shared/geo-data.test.ts
import { describe, it, expect } from "vitest";
import { makeMajorRivers, centreCells } from "./geo-data.js";

describe("makeMajorRivers", () => {
  it("returns one named LineString feature per river", () => {
    const rivers = makeMajorRivers();
    expect(rivers.length).toBe(7);
    expect(rivers.map((r) => r.properties.name)).toContain("Amazon");
    for (const r of rivers) {
      expect(r.geometry.type).toBe("LineString");
      expect(r.geometry.coordinates.length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("centreCells", () => {
  it("is the 4° grid restricted to lon ±60°, lat ±30°", () => {
    const cells = centreCells();
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(Math.abs(c.center[0])).toBeLessThanOrEqual(60);
      expect(Math.abs(c.center[1])).toBeLessThanOrEqual(30);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run website/src/examples/shared/geo-data.test.ts`. Expected: FAIL (rivers shape; centreCells missing).

- [ ] **Step 3: Implement.** In `geo-data.ts`, replace `makeMajorRivers` (lines 151-169) with:

```ts
/** A handful of major rivers as rough named polylines (the bundled world-atlas data
 *  has no rivers), shown on the GeoJSON-features map and used as streaming cluster
 *  centers. Coordinates are approximate [lon, lat] traces, mouth → source. */
export function makeMajorRivers(): Feature<LineString, { name: string }>[] {
  const rivers: [string, [number, number][]][] = [
    ["Amazon", [[-50.0, -0.7], [-55.5, -2.5], [-60.0, -3.1], [-67.9, -3.5], [-73.2, -4.5]]],
    ["Nile", [[31.3, 31.4], [32.9, 24.1], [32.5, 15.6], [32.5, 9.5], [31.6, 2.3]]],
    ["Mississippi", [[-89.2, 29.2], [-90.1, 32.3], [-90.2, 38.6], [-91.2, 43.5], [-95.0, 47.2]]],
    ["Yangtze", [[121.8, 31.4], [114.3, 30.6], [106.5, 29.6], [100.2, 26.9], [94.7, 33.5]]],
    ["Congo", [[12.4, -6.0], [16.2, -4.3], [20.0, -1.0], [25.2, 0.5], [27.2, 3.0]]],
    ["Volga", [[48.0, 46.3], [45.0, 48.7], [44.5, 51.6], [47.5, 54.3], [37.0, 57.3]]],
    ["Ganges", [[90.5, 22.5], [88.0, 24.5], [83.0, 25.4], [78.0, 26.5], [78.9, 30.1]]],
  ];
  return rivers.map(([name, coordinates]) => ({
    type: "Feature",
    properties: { name },
    geometry: { type: "LineString", coordinates },
  }));
}
```

Update `buildParents` (line 242-243) to the new shape:

```ts
  for (const river of makeMajorRivers())
    for (const p of river.geometry.coordinates) parents.push({ lon: p[0]!, lat: p[1]!, spread: 2.5, weight: 2 });
```

Add `centreCells` after `makeCells`:

```ts
/** A fine grid over the central third of the globe (lon ±60°, lat ±30°), 4° cells —
 *  a "dense" demo layer (used clipped to land). */
export function centreCells(): Cell[] {
  return makeCells(4).filter((c) => Math.abs(c.center[0]) <= 60 && Math.abs(c.center[1]) <= 30);
}
```

In `map-projections/draw.ts`: delete the local `centreCells` (lines 44-48), import it from `../shared/geo-data.js` instead, keep the `const cells = centreCells();` call.

- [ ] **Step 4: Run website tests + typecheck**

```bash
pnpm vitest run website/src/examples/shared
pnpm --filter @d3gl/website exec tsc --noEmit 2>/dev/null || pnpm --filter @d3gl/website exec astro check
```

(Use whichever check the website package supports — check its package.json scripts; at minimum the vitest run and the Task 18 build gate type safety.) Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add website/src/examples/shared website/src/examples/map-projections
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(website): named river features + shared centreCells"
```

---

### Task 15: GeoJSON-features example — cells layer + tooltips

**Files:**
- Modify: `website/src/examples/geojson-features/draw.ts`

- [ ] **Step 1: Rewrite `draw.ts`** (full file; preserves the existing layers/labels, adds cells + tooltips):

```ts
import { geoNaturalEarth1 } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis } from "d3-scale-chromatic";
import { geoMap } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import { LabelLayer, type LabelAnchor } from "@mapequation/d3gl/labels";
import type { ImperativeSetup } from "../types.js";
import {
  loadWorld,
  makeGraticule,
  makeRoute,
  makeCities,
  makeCluster,
  makeDemoPolygon,
  makeMajorRivers,
  centreCells,
} from "../shared/geo-data.js";

const OCEAN = "#d4e6f5";
const LAND = "#e3e6ea";
const PR = 3.5; // city point radius, in px
const heat = scaleSequential(interpolateViridis).domain([0, 1]);

/**
 * One map exercising every GeoJSON geometry type — land (`MultiPolygon`),
 * graticule (`MultiLineString`), a value grid clipped to land, a demo `Polygon`,
 * a `LineString` route, a `MultiPoint` cluster, and `Point` cities — plus an HTML
 * `LabelLayer` overlay for the city names that tracks zoom. Every feature layer
 * has a hover `tooltip` (core-managed div); picking is clip-aware, so grid cells
 * only read out where they are visibly painted on land. Pure d3gl; the harness
 * supplies `width`/`height`/`backend`.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const world = loadWorld();
  const cities = makeCities();
  const cells = centreCells();
  const cellById = new Map(cells.map((c) => [c.id, c]));
  const projection = fitProjection(geoNaturalEarth1(), { type: "Sphere" }, width, height);

  const map = geoMap(host, {
    width, height, projection, backend,
    tooltipClass:
      "rounded border border-border bg-card/95 px-1.5 py-0.5 text-xs text-foreground",
  });
  map.layer("ocean", [world.sphere], { fill: OCEAN });
  map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.5 });
  // Declared right after land so rivers/route/cities render — and pick — above the grid.
  map.layer("cells", cells.map((c) => c.geometry), {
    id: (_g, i) => cells[i]!.id,
    fill: (_g, i) => heat(cells[i]!.value),
    clipTo: "land",
    tooltip: (_g, id) => {
      const c = cellById.get(id as string);
      return c ? `value ${c.value.toFixed(3)}` : null;
    },
  });
  map.layer("graticule", [makeGraticule()], { stroke: "#bcc6d0", lineWidth: 0.5 });
  map.layer("rivers", makeMajorRivers(), {
    id: (f) => f.properties.name,
    stroke: "#3b82c4",
    lineWidth: 0.9,
    tooltip: (f) => f.properties.name,
  });
  map.layer("region", [makeDemoPolygon()], {
    fill: "#9bd1a466", stroke: "#3b8c4e", lineWidth: 1,
    tooltip: () => "Sahara box (demo region)",
  });
  map.layer("route", [makeRoute()], {
    stroke: "#e8932f", lineWidth: 1.5,
    tooltip: () => "London → New York → Tokyo",
  });
  map.layer("cluster", [makeCluster()], {
    fill: "#4dd0e1", pointRadius: 3,
    tooltip: () => "Cluster (MultiPoint)",
  });
  map.layer("cities", cities.map((c) => c.geometry), {
    id: (_g, i) => cities[i]!.id,
    fill: "#e23b2f",
    pointRadius: PR,
    tooltip: (_g, id) => String(id),
  });
  map.render();

  // HTML label overlay over the canvas (host is positioned `relative` by the harness).
  const labelEl = document.createElement("div");
  labelEl.className = "absolute inset-0 pointer-events-none text-[11px] text-[#222]";
  host.appendChild(labelEl);

  const labels = new LabelLayer(labelEl, (a) => a.text);
  const anchors: LabelAnchor[] = cities.map((c) => {
    const [x, y] = projection(c.geometry.coordinates as [number, number])!;
    // Sit each label just right of the dot, vertically centred on it. The LabelLayer places
    // the box's TOP-LEFT at (refX + offsetX, refY + offsetY), so offset y = -height/2.
    return {
      id: c.id,
      refX: x,
      refY: y,
      text: c.name,
      width: c.name.length * 6.2 + 6,
      height: 14,
      offset: [PR + 3, -7],
    };
  });
  const update = (t = { k: 1, x: 0, y: 0 }) => labels.update(anchors, t, { width, height });
  map.enableZoom([1, 50], (t) => update(t)); // scroll to zoom, drag to pan; labels track zoom
  update();

  return { engine: map, dispose: () => labels.destroy() };
};
```

- [ ] **Step 2: Verify in the dev server** (manual smoke; run, open the GeoJSON-features page, hover cells/rivers/cities):

```bash
pnpm --filter @d3gl/website dev
```

Expected: grid visible clipped to land; tooltips show value / river name / city name; no tooltip over open ocean. Kill the server after checking.

- [ ] **Step 3: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add website/src/examples/geojson-features
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(website): geojson-features — land-clipped value grid + hover tooltips"
```

---

### Task 16: Heatmap → Highlight example

**Files:**
- Rename: `website/src/examples/heatmap/` → `website/src/examples/highlight/` (`Heatmap.tsx` → `Highlight.tsx`)
- Rename: `website/src/content/docs/examples/map/heatmap.mdx` → `highlight.mdx`
- Modify: `website/astro.config.mjs` (sidebar)

- [ ] **Step 1: Rename with git**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction mv website/src/examples/heatmap website/src/examples/highlight
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction mv website/src/examples/highlight/Heatmap.tsx website/src/examples/highlight/Highlight.tsx
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction mv website/src/content/docs/examples/map/heatmap.mdx website/src/content/docs/examples/map/highlight.mdx
```

- [ ] **Step 2: Rewrite `website/src/examples/highlight/draw.ts`**

```ts
import { geoNaturalEarth1 } from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis } from "d3-scale-chromatic";
import { geoMap } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import type { ImperativeSetup } from "../types.js";
import { makeCells, loadWorld, type Cell } from "../shared/geo-data.js";

const heat = scaleSequential(interpolateViridis).domain([0, 1]);

/**
 * Hover + click interaction on a land-clipped value grid, all through core d3gl:
 * the `hover` option outlines the hovered cell in a tiny overlay layer (the grid's
 * buffers are untouched), `tooltip` reads out its value, and a click selects the
 * cell plus every cell within ±0.1 of its value — `select()` dims the rest to 30%
 * via the `selection` option (one style-table write, no re-tessellation). Clicking
 * open ocean clears the selection (picking is clip-aware, so a cell only counts
 * where it is visibly painted on land). The `cells` slider rebuilds only the grid
 * layer, preserving zoom/pan; a rebuilt grid starts unselected (its ids change).
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const world = loadWorld();
  const projection = fitProjection(geoNaturalEarth1(), { type: "Sphere" }, width, height);

  // The cells the click handler resolves against, kept current as render rebuilds them.
  let cells: Cell[] = [];
  let cellById = new Map<string, Cell>();

  const map = geoMap(host, {
    width, height, projection, backend,
    tooltipClass:
      "rounded border border-border bg-card/95 px-1.5 py-0.5 text-xs text-foreground",
  });
  map.layer("ocean", [world.sphere], { fill: "#d4e6f5" });
  map.layer("land", [world.land], { fill: "#e7e7e0" });
  map.on("click", (hit) => {
    if (hit?.layer !== "cells") {
      map.select("cells", null); // clicked outside the grid: clear
      return;
    }
    const v = cellById.get(hit.id as string)?.value;
    if (v === undefined) return;
    map.select("cells", (_g, i) => Math.abs(cells[i]!.value - v) <= 0.1);
  });
  map.enableZoom([1, 50]); // scroll to zoom, drag to pan (clicks still fire — drags don't)

  return {
    engine: map,
    // Rebuild only the "cells" layer at the chosen grid size; re-pushed at the
    // map's CURRENT transform, so zoom/pan survives a slider change.
    render: (options) => {
      const exp = (options.cells as number) ?? 2; // grid-size exponent from the slider
      const step = 2 ** exp; // degrees: 0→1°, 1→2°, 2→4°, 3→8°
      cells = makeCells(step);
      cellById = new Map(cells.map((c) => [c.id, c]));
      map.layer("cells", cells.map((c) => c.geometry), {
        id: (_g, i) => cells[i]!.id,
        fill: (_g, i) => heat(cells[i]!.value),
        clipTo: "land", // clip the grid to the land outline
        hover: { stroke: "#fff", lineWidth: 1 },
        tooltip: (_g, id) => {
          const c = cellById.get(id as string);
          return c ? `value ${c.value.toFixed(3)}` : null;
        },
        selection: { others: { opacity: 0.3 } },
      });
      map.render();
    },
  };
};
```

- [ ] **Step 3: Rewrite `Highlight.tsx`** (same harness shape as before, renamed):

```tsx
import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness wrapper: hover-highlight + click-selection on a land-clipped value grid,
 *  with a cell-size slider. */
export default function Highlight() {
  return (
    <Example
      controls={[
        {
          type: "range",
          key: "cells",
          label: "Cell size",
          min: 0,
          max: 3,
          step: 1,
          value: 2,
          display: ["1°", "2°", "4°", "8°"],
        },
      ]}
      width={900}
      height={450}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
```

- [ ] **Step 4: Rewrite `highlight.mdx`**

```mdx
---
title: Highlight
description: Hover-highlight and click-selection on a value grid — an overlay redraw plus style-table writes, no re-tessellation.
---

import ExampleCard from "../../../../components/ExampleCard.astro";
import Highlight from "../../../../examples/highlight/Highlight.tsx";

A synthetic value field on a grid, **clipped to the land outline**. **Hover** any cell to
highlight it and read its value. **Click** a cell to select it together with every cell within
±0.1 of its value — all other cells dim to 30% opacity. Click open ocean to clear the selection.

Hover redraws only the hovered cell into a tiny overlay layer, and selection rewrites only the
per-cell color tables — neither touches the grid's geometry, so both stay instant at 1° (≈ 65k
cells). Scroll to zoom; the **cell-size** slider rebuilds the grid (which clears the selection).

<ExampleCard files={["highlight/draw.ts"]}>
  <Highlight client:visible slot="demo" />
</ExampleCard>
```

- [ ] **Step 5: Update the sidebar** in `website/astro.config.mjs`: replace `{ label: "Heatmap", slug: "examples/map/heatmap" }` with `{ label: "Highlight", slug: "examples/map/highlight" }`.

- [ ] **Step 6: Manual smoke** — `pnpm --filter @d3gl/website dev`, open Examples → Highlight: hover outline + tooltip; click selects ±0.1 band, others dim; ocean click clears; slider rebuild clears selection; drag-pan doesn't select. Kill the server.

- [ ] **Step 7: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add -A website/src website/astro.config.mjs
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "feat(website): remake Heatmap example as Highlight (hover + click selection)"
```

---

### Task 17: "Interaction" docs page

**Files:**
- Create: `website/src/content/docs/interaction.mdx`
- Modify: `website/astro.config.mjs` (sidebar "Start Here")

- [ ] **Step 1: Write the page**

```mdx
---
title: Interaction
description: Hover, tooltips, highlight, click selection, and per-drawable style overrides — and what each one costs.
---

Retained layers are pickable by default (a CPU hit index per layer; disable with
`pickable: false`). Picking is **clip-aware**: a layer with `clipTo` only hits where its
clip source is also hit, so interaction matches what is visibly painted.

## Events

```ts
map.on("hover", (hit, ev) => { /* hit: { layer, id, datum } | null */ });
map.on("click", (hit, ev) => { /* fires only when the pointer didn't drag (≤ 4 px) */ });
```

`click` coexists with pan/zoom/rotation: a drag never fires it.

## Hover highlight

```ts
map.layer("cells", geoms, {
  hover: true,                                   // default: white outline (ring for points)
  // hover: { stroke: "#fff", lineWidth: 1.5 },  // or replay the item with this style
  // hover: (d, g) => { ... },                   // or fully custom draw (see below)
});
map.highlight("cells", id | [ids] | null, styleOrDraw?); // the imperative primitive
```

The hovered item is **redrawn into a tiny internal overlay layer** (inheriting the source
layer's `clipTo`/`sizeMode`, rendered on top). The base layer's buffers are never touched, so
sweeping fast across a dense grid costs O(one feature) per cell crossed — no fps drop. Because
only one item is re-tessellated, `lineWidth` is allowed here (unlike bulk overrides).

Custom draw gets a `HighlightBuilder` scoped to the hovered drawable (world coordinates):

```ts
hover: (city, g) => {
  g.replay({ fill: "#fff" });                       // the item itself, restyled —
                                                    // uses its already-projected geometry
  const [x, y] = g.anchor!;                         // a point feature's projected center
  g.path((ctx) => ctx.arc(x, y, 8, 0, 2 * Math.PI), // plus anything else
    { stroke: "#e23b2f", lineWidth: 1.5 });
  g.point(x, y - 12, 2, { fill: "#e23b2f" });
}
```

## Tooltips

```ts
const map = geoMap(host, { ..., tooltipClass: "my-tooltip" }); // optional styling hook
map.layer("cities", pts, { tooltip: (d, id) => d.name });      // string | HTMLElement | null
```

One shared absolutely-positioned div (`class="d3gl-tooltip"`), engine-managed: filled from the
accessor of the hovered layer, follows the pointer clamped to the host, hidden off-target.
Without `tooltipClass` it gets a minimal default look.

## Selection and style overrides

```ts
map.layer("cells", geoms, {
  selection: { selected: { stroke: "#fff" },   // optional; default keeps base style
               others: { opacity: 0.3 } },     // default when omitted
});
map.select("cells", ids | ((d, i) => boolean)); // apply
map.select("cells", null);                      // clear (restores base styles)

map.setStyle("cells", id | [ids], { fill?, stroke?, opacity? }); // the primitives
map.clearStyle("cells", ids?);
```

Overrides compose **over** the base accessor colors: `fill`/`stroke` replace the base color,
`opacity` multiplies the base alpha (dimming keeps each item's hue). They survive projection
switches and rotation rebuilds; re-declaring the layer (`map.layer(name, …)` again) resets
them. `select()` rewrites the layer's whole override table (last write wins vs `setStyle`).

Bulk overrides are colors-only: stroke geometry bakes its width at tessellation time, so a bulk
`lineWidth` would be O(n) re-tessellation — use the hover overlay for width changes.

## Cost model

| Operation | Cost | When |
| --- | --- | --- |
| Pointer move within one item | one pick + tooltip reposition | per move |
| Hover crosses into a new item | tessellate 1 feature + tiny upload | per change |
| `select()` / `setStyle` bulk | O(n) byte writes + one small table upload | per call (e.g. click) |
| Pan/zoom/rotate frames | unchanged — the hover pipeline pauses during gestures | — |

Nothing here adds per-frame work, changes shaders, or rebuilds vertex buffers.
```

- [ ] **Step 2: Sidebar** — in `website/astro.config.mjs`, "Start Here" items, after "Rendering backends":

```js
        { label: "Interaction", slug: "interaction" },
```

- [ ] **Step 3: Build the site** (also validates the MDX):

```bash
pnpm --filter @d3gl/website build
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add website/src/content/docs/interaction.mdx website/astro.config.mjs
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "docs(website): interaction guide (hover, tooltips, highlight, selection)"
```

---

### Task 18: Changeset + final verification

**Files:**
- Create: `.changeset/interaction-highlight.md`

- [ ] **Step 1: Write the changeset**

```md
---
"@mapequation/d3gl": minor
---

Interactive styling for retained layers: `on("click")` (drag-suppressed), hover
highlight via per-item overlay (`hover` layer option / `highlight()`, with custom
draw through `HighlightBuilder`), core tooltips (`tooltip` option + `tooltipClass`),
click selection with complement dimming (`selection` option + `select()`), per-drawable
style overrides (`setStyle`/`clearStyle`) on a new styles-only backend path
(`updateLayerStyles`), faster `recolor()`, and clip-aware picking (`clipTo` layers no
longer hit where they are visibly clipped away).
```

- [ ] **Step 2: Full verification gate**

```bash
pnpm --filter @mapequation/d3gl exec tsc -b
pnpm build:lib
pnpm vitest run
pnpm --filter @mapequation/d3gl test:browser
pnpm --filter @d3gl/website build
```

Expected: ALL pass. Fix anything that fails before committing.

- [ ] **Step 3: Commit**

```bash
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction add .changeset/interaction-highlight.md
git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/highlight-interaction commit -m "chore: changeset for interaction/highlight features"
```

- [ ] **Step 4: Final review** — run the requesting-code-review skill (or at minimum re-read the spec's Public API + Testing sections against the diff) before offering a PR via the finishing-a-development-branch skill.
