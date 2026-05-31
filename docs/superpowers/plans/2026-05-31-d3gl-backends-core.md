# d3gl Backend Foundation (core) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@d3gl/core` everything the backend-agnostic renderer needs: the `Scene`
retains vector paths (for Canvas/SVG/hit-test), a `Backend` interface all backends
implement, and a CPU quadtree hit-test that works independent of any backend.

**Architecture:** The `Scene` already records drawables via `PathRecorder` (subpaths) and
tessellates them; today it discards the subpaths. We retain them and expose a vector view
alongside the existing GPU `buffers()`. A new `Backend` interface and a `ViewTransform`
type live in core so all backends share them. A `HitIndex` (bbox-bucketed point-in-ring
test) provides backend-independent picking.

**Tech stack:** TypeScript, Vitest (Node). No new deps.

This is Plan 1 of 4 (core → backends → map engine → react+example). It depends on the
shipped foundation and the proven stencil spike.

---

### Task 1: Scene retains per-drawable vector paths

**Files:**
- Modify: `packages/core/src/scene.ts`
- Modify: `packages/core/src/index.ts` (export `DrawableVector`)
- Test: `packages/core/src/__tests__/scene-vector.test.ts`

Context: `GroupData` (scene.ts ~line 52) accumulates fill/stroke buffers, `ranges`,
`idToDrawable`, `fillColors`/`strokeColors`/`flags` (flat number arrays, 4 per drawable
for colors). `addDrawable` (~line 80) builds a `PathRecorder`, reads `recorder.subpaths`,
tessellates fill, expands stroke, then pushes color/flag defaults. `Subpath` is
`{ points: number[]; closed: boolean }` from `path-context.ts`. We must also retain, per
drawable: the subpaths, the domain `id`, and the `lineWidth` (currently only used
transiently for stroke expansion).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/scene-vector.test.ts
import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";

describe("Scene vector view", () => {
  it("exposes per-drawable subpaths, colors, lineWidth and flags", () => {
    const scene = new Scene();
    scene.group("g", (b) => {
      b.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10), { lineWidth: 2 });
      b.drawable("b", (ctx) => {
        ctx.moveTo(0, 0);
        ctx.lineTo(5, 0);
      });
    });
    scene.setFill("g", "a", "rgb(255, 0, 0)");
    scene.setStroke("g", "a", "rgb(0, 0, 255)");
    scene.setFlag("g", "b", 0);

    const ds = scene.drawables("g");
    expect(ds.map((d) => d.id)).toEqual(["a", "b"]);

    const a = ds[0]!;
    expect(a.subpaths.length).toBe(1);
    expect(a.subpaths[0]!.closed).toBe(true);
    expect(a.subpaths[0]!.points.length).toBeGreaterThanOrEqual(8); // rect corners
    expect(a.fill).toEqual([255, 0, 0, 255]);
    expect(a.stroke).toEqual([0, 0, 255, 255]);
    expect(a.lineWidth).toBe(2);
    expect(a.flags).toBe(1);

    const b = ds[1]!;
    expect(b.subpaths[0]!.closed).toBe(false);
    expect(b.flags).toBe(0); // hidden
    expect(b.lineWidth).toBe(0); // default
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd packages/core && pnpm test scene-vector` → FAIL (`scene.drawables` is not a function).

- [ ] **Step 3: Implement**

In `scene.ts`:
- Add to `GroupData`: `subpaths: Subpath[][] = []`, `ids: (string | number)[] = []`,
  `lineWidths: number[] = []`. Import `Subpath` from `./path-context.js`.
- In `addDrawable`, after `const subpaths = recorder.subpaths;` push a **copy** of the
  subpaths (`data.subpaths.push(subpaths.map((s) => ({ closed: s.closed, points: s.points.slice() })))`),
  `data.ids.push(id)`, and `data.lineWidths.push(opts?.lineWidth ?? 0)`. Keep all existing
  tessellation/stroke/color/flag pushes unchanged.
- Add the exported interface and accessor:

```ts
export interface DrawableVector {
  id: string | number;
  subpaths: Subpath[];
  fill: [number, number, number, number];
  stroke: [number, number, number, number];
  lineWidth: number;
  flags: number;
}

// method on Scene:
drawables(name: string): DrawableVector[] {
  const data = this.get(name);
  return data.ids.map((id, i) => ({
    id,
    subpaths: data.subpaths[i]!,
    fill: [data.fillColors[i * 4]!, data.fillColors[i * 4 + 1]!, data.fillColors[i * 4 + 2]!, data.fillColors[i * 4 + 3]!],
    stroke: [data.strokeColors[i * 4]!, data.strokeColors[i * 4 + 1]!, data.strokeColors[i * 4 + 2]!, data.strokeColors[i * 4 + 3]!],
    lineWidth: data.lineWidths[i]!,
    flags: data.flags[i]!,
  }));
}
```

Export `DrawableVector` from `index.ts` alongside the existing `GroupBuffers` exports.

- [ ] **Step 4: Run tests, verify pass**

Run: `cd packages/core && pnpm test` → all pass (existing buffer tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scene.ts packages/core/src/index.ts packages/core/src/__tests__/scene-vector.test.ts
git commit -m "feat(core): retain per-drawable vector paths; add Scene.drawables() view"
```

---

### Task 2: ViewTransform + Backend interface in core

**Files:**
- Create: `packages/core/src/backend.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/webgl/src/transform.ts` (re-export `ViewTransform` from core)
- Test: `packages/core/src/__tests__/backend.test.ts`

Context: `ViewTransform` (`{ k, x, y }`) is currently declared in
`packages/webgl/src/transform.ts` and re-exported from `@d3gl/webgl`. All three backends
need it, so it moves to core. `clipFromView` stays in `@d3gl/webgl`. The `Backend`
interface is pure types; the test asserts a trivial in-memory stub satisfies it (compile +
shape), which is the meaningful check for an interface.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/backend.test.ts
import { describe, it, expect } from "vitest";
import type { Backend, RenderLayer, ViewTransform } from "../backend.js";

describe("Backend interface", () => {
  it("an in-memory stub satisfies the interface", () => {
    const calls: string[] = [];
    const stub: Backend = {
      setLayers: (l: RenderLayer[]) => calls.push(`setLayers:${l.length}`),
      updateLayer: (n) => calls.push(`updateLayer:${n}`),
      setTransform: (t: ViewTransform) => calls.push(`t:${t.k}`),
      render: () => calls.push("render"),
      toPNG: () => "data:image/png;base64,",
      toSVG: () => "<svg></svg>",
      destroy: () => calls.push("destroy"),
    };
    stub.setTransform({ k: 2, x: 0, y: 0 });
    stub.render();
    expect(calls).toEqual(["t:2", "render"]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd packages/core && pnpm test backend` → FAIL (cannot find `../backend.js`).

- [ ] **Step 3: Implement**

Create `packages/core/src/backend.ts`:

```ts
import type { GroupBuffers, DrawableVector } from "./scene.js";

/** View transform applied on top of project-once geometry: scale k, translate (x, y). */
export interface ViewTransform {
  k: number;
  x: number;
  y: number;
}

/** One named layer handed to a backend: GPU buffers + the vector view + optional clip. */
export interface RenderLayer {
  name: string;
  buffers: GroupBuffers;
  drawables: DrawableVector[];
  /** Name of an earlier layer whose filled silhouette clips this one. */
  clipTo?: string;
}

/** A renderer for a Scene, implemented per target (WebGL / Canvas / SVG). */
export interface Backend {
  setLayers(layers: RenderLayer[]): void;
  updateLayer(name: string, layer: RenderLayer): void;
  setTransform(t: ViewTransform): void;
  render(): void;
  toPNG(): string;
  toSVG(): string;
  destroy(): void;
}
```

Export from `index.ts`:
```ts
export type { Backend, RenderLayer, ViewTransform } from "./backend.js";
```

In `packages/webgl/src/transform.ts`: replace the local `ViewTransform` declaration with
`import type { ViewTransform } from "@d3gl/core";` and `export type { ViewTransform };`
(keep `clipFromView` and its existing export path working — `@d3gl/webgl` still
re-exports `ViewTransform`).

- [ ] **Step 4: Run tests, verify pass**

Run: `cd packages/core && pnpm test backend` → PASS.
Run: `cd packages/webgl && pnpm test` → still PASS (type re-export unchanged at runtime).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/backend.ts packages/core/src/index.ts packages/webgl/src/transform.ts packages/core/src/__tests__/backend.test.ts
git commit -m "feat(core): add Backend interface; move ViewTransform to core"
```

---

### Task 3: CPU quadtree hit-test

**Files:**
- Create: `packages/core/src/hit-test.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/hit-test.test.ts`

Context: hover/pick must be backend-independent. Build an index over a layer's
`DrawableVector[]` in **projected** coordinates; the engine inverts the screen point
through the current `ViewTransform` before querying. Fill drawables hit-test by
point-in-polygon (use `groupRings` + `pointInRing` from `./rings.js` to respect holes);
stroke-only drawables (no closed subpath, `lineWidth > 0`) hit-test by distance to any
segment `<= lineWidth / 2 + tolerance`. Hidden drawables (flags bit 0 == 0) never hit.
Topmost wins (later drawables drawn on top → iterate in reverse). A simple bbox prefilter
keeps it fast enough for ~10k drawables at pointer rates; a uniform-grid bucket may be
added later (note it, don't build it).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/hit-test.test.ts
import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";
import { HitIndex } from "../hit-test.js";

describe("HitIndex", () => {
  it("returns the topmost filled drawable under a point, -1 on miss", () => {
    const scene = new Scene();
    scene.group("g", (b) => {
      b.drawable("base", (ctx) => ctx.rect(0, 0, 100, 100));
      b.drawable("top", (ctx) => ctx.rect(40, 40, 20, 20)); // overlaps base
    });
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(50, 50)).toBe("top");   // overlap -> topmost
    expect(idx.pick(10, 10)).toBe("base");  // base only
    expect(idx.pick(200, 200)).toBe(null);  // miss
  });

  it("skips hidden drawables and hits strokes near the line", () => {
    const scene = new Scene();
    scene.group("g", (b) => {
      b.drawable("hidden", (ctx) => ctx.rect(0, 0, 100, 100));
      b.drawable("line", (ctx) => { ctx.moveTo(0, 50); ctx.lineTo(100, 50); }, { lineWidth: 4 });
    });
    scene.setFlag("g", "hidden", 0);
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(50, 50)).toBe("line");   // on the line, hidden fill skipped
    expect(idx.pick(50, 70)).toBe(null);     // far from line, fill hidden
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd packages/core && pnpm test hit-test` → FAIL (cannot find `../hit-test.js`).

- [ ] **Step 3: Implement**

Create `packages/core/src/hit-test.ts`:

```ts
import type { DrawableVector } from "./scene.js";
import { groupRings, pointInRing, type RingGroup } from "./rings.js";
import type { Subpath } from "./path-context.js";

interface Entry {
  id: string | number;
  minX: number; minY: number; maxX: number; maxY: number;
  filled: boolean;          // has >=1 closed subpath with area
  rings: RingGroup[];       // for filled (outer/holes are Subpath objects)
  strokes: Subpath[];       // for stroke hit-test
  halfWidth: number;
}

function bounds(subpaths: Subpath[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of subpaths)
    for (let i = 0; i < s.points.length; i += 2) {
      const x = s.points[i]!, y = s.points[i + 1]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  return [minX, minY, maxX, maxY];
}

function distToSegments(px: number, py: number, pts: number[]): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i]!, ay = pts[i + 1]!, bx = pts[i + 2]!, by = pts[i + 3]!;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    const d = Math.hypot(px - qx, py - qy);
    if (d < best) best = d;
  }
  return best;
}

export class HitIndex {
  private entries: Entry[] = [];

  constructor(drawables: readonly DrawableVector[], tolerance = 1) {
    this.tolerance = tolerance;
    for (const d of drawables) {
      if ((d.flags & 1) === 0) continue; // hidden never hits
      const closed = d.subpaths.filter((s) => s.closed && s.points.length >= 6);
      const [minX, minY, maxX, maxY] = bounds(d.subpaths);
      this.entries.push({
        id: d.id, minX, minY, maxX, maxY,
        filled: closed.length > 0,
        rings: closed.length > 0 ? groupRings(closed) : [],
        strokes: d.lineWidth > 0 ? d.subpaths : [],
        halfWidth: d.lineWidth / 2 + tolerance,
      });
    }
  }
  private tolerance: number;

  /** Pick in PROJECTED coordinates (invert the view transform before calling). */
  pick(x: number, y: number): string | number | null {
    for (let i = this.entries.length - 1; i >= 0; i--) { // topmost first
      const e = this.entries[i]!;
      if (x < e.minX - e.halfWidth || x > e.maxX + e.halfWidth || y < e.minY - e.halfWidth || y > e.maxY + e.halfWidth) continue;
      if (e.filled) {
        for (const r of e.rings) {
          if (pointInRing(x, y, r.outer.points) && !r.holes.some((h) => pointInRing(x, y, h.points))) return e.id;
        }
      }
      if (e.strokes.length > 0) {
        for (const s of e.strokes) if (distToSegments(x, y, s.points) <= e.halfWidth) return e.id;
      }
    }
    return null;
  }
}
```

(`RingGroup` is `{ outer: Subpath; holes: Subpath[] }` and `pointInRing(x, y, points)`
takes interleaved x,y — both confirmed against `rings.ts`.) Export `HitIndex` from
`index.ts`.

- [ ] **Step 4: Run tests, verify pass**

Run: `cd packages/core && pnpm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/hit-test.ts packages/core/src/index.ts packages/core/src/__tests__/hit-test.test.ts
git commit -m "feat(core): backend-independent quadtree hit-test (point-in-ring + stroke distance)"
```

---

## Self-review notes
- Spec coverage: Scene vector retention (Task 1), Backend interface + ViewTransform move
  (Task 2), CPU hit-test respecting visibility/clip-less geometry (Task 3). Clipping in
  `RenderLayer.clipTo` is consumed by the backends (Plan 2), not core.
- Type consistency: `DrawableVector` defined in Task 1 is imported by Tasks 2 and 3.
  `ViewTransform` defined in Task 2 is the type all backends and `geoMap` use.
- Open verification for implementers: confirm `groupRings`/`pointInRing` signatures in
  `rings.ts` before relying on them (Task 3, Step 3).
