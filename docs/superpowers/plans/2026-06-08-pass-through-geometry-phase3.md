# Pass-through Rendering — Phase 3: Generic GeoJSON geometry (polygons + lines)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. The controller writes detailed per-task subagent prompts from this skeleton.

**Goal:** Extend pass-through (Phases 1–2: points only) to **all GeoJSON geometry** — polygons, lines, multipolygons — through one unified pull→build→draw→discard pipeline reusing the existing geometry builders, with zero retention. This delivers the "unified logic" the design called for.

**Architecture:** The pass-through batch generalizes from `PointBatch` to `DrawBatch { points?, paths? }`. A path feature carries its **projected subpaths + fill/stroke colors + lineWidth** (NOT pre-tessellated). Canvas draws paths natively via `Path2D` (no tessellation). WebGL tessellates each path per repaint (reusing `tessellateFill`/`expandStroke`) into reused scratch fill/stroke buffers with per-vertex baked color, drawn into the existing accumulation FBO. The engine's time-slicing, snapshot-pan, FBO/composite, and Canvas accumulation are unchanged — only the batch payload and the per-backend draw widen.

**Tech Stack:** TypeScript, d3-geo (`geoPath`), luma.gl, Vitest (node + browser).

---

## Spec & prior work
- Design: [docs/superpowers/specs/2026-06-08-pass-through-point-rendering-design.md](../specs/2026-06-08-pass-through-point-rendering-design.md) — see "Generic geometry pipeline".
- Phase 1 (#31), Phase 2 (#32). This phase stacks on `feat/passthrough-webgl` (branch `feat/passthrough-geometry`).

### Cost / value (read before committing to this phase)
- **Value:** architectural unification + flat memory for huge polygon/line sets. NOT the OOM driver (the ~4–7M ceiling was a *points* problem; polygon datasets are usually far smaller).
- **Cost:** non-point geometry **re-tessellates on every repaint** (pan/zoom settle, time-sliced). Heavier than points. WebGL is the meaty task (tessellate-in-FBO).
- Picking still unsupported; single pass-through layer still the supported case (inherited scope).

### Existing builders to reuse (verified — do NOT reimplement)
- `core/path-recorder.ts` `PathRecorder(tolerance)` → `.subpaths: readonly Subpath[]`; `Subpath = { points: number[] /* [x0,y0,...] */, closed: boolean }`.
- `core/rings.ts` `groupRings(closedSubpaths) → { outer: Subpath, holes: Subpath[] }[]`.
- `core/tessellate.ts` `tessellateFill(polygons: Subpath[], holes: Subpath[][]) → { vertices: number[] /* x,y */, indices: number[] }`.
- `core/stroke.ts` `expandStroke(subpath, width) → { vertices: number[], indices: number[], anchors: number[] }`.
- `geo/geo-layer.ts` non-Point branch: `g.drawable(id, ctx => geoPath(projection, ctx)(feature), { lineWidth })` — the exact projection-into-PathRecorder pattern to reuse for `buildItem`.
- Retained sequence to mirror: `core/scene.ts` `addDrawable` (recorder → subpaths → groupRings → tessellateFill → fill; expandStroke → stroke).
- WebGL retained fill: `webgl/renderer.ts` `buildPass` + `FILL_VS/FILL_FS` (color via texture — pass-through replaces with a per-vertex `a_color`).
- Canvas retained path: `canvas/canvas-backend.ts` `drawShapes` path branch + `fillStroke` helper.

## Testing
Node: `npx vitest run`. Browser/GPU: `pnpm --filter @mapequation/d3gl test:browser <file>` (works reliably). Per-package typecheck: `pnpm --filter @mapequation/d3gl exec tsc -b`.

---

## Core types (introduced in Task 1, used throughout)

```ts
// map/draw-batch.ts
import type { Subpath } from "../core/path-context.js";
import type { PointBatch } from "../core/backend.js"; // existing

/** One projected path feature, ready to draw (canvas: native; webgl: tessellated per frame). */
export interface ProjectedPath {
  subpaths: Subpath[];                 // already projected to world coords
  fill: [number, number, number, number] | null;   // RGBA bytes, null = no fill
  stroke: [number, number, number, number] | null; // RGBA bytes, null = no stroke
  lineWidth: number;                   // 0 = no stroke geometry
}

/** Generalized transient pass-through payload. Either/both may be present. */
export interface DrawBatch {
  points: PointBatch | null;   // circles (Phase 1/2 path)
  paths: ProjectedPath[] | null;
}

/** What a PassThroughSpec produces per datum (generalizes the point-only project()). */
export type DrawItem =
  | { kind: "points"; centers: [number, number][]; radius: number; color: string }
  | { kind: "path"; subpaths: Subpath[]; fill: string | null; stroke: string | null; lineWidth: number };
```

`Backend.drawPassThrough` widens: `drawPassThrough?(name: string, batch: DrawBatch, mode): void`.

---

## Task 1 — `DrawBatch`/`DrawItem` types + `buildBatch`
**Files:** create `packages/d3gl/src/map/draw-batch.ts`, test `packages/d3gl/src/map/__tests__/draw-batch.test.ts`.

`buildBatch<D>(data, buildItem: (d,i)=>DrawItem|null): DrawBatch` — pure, DOM-free. Iterate data; collect `points` items into packed `PointBatch` arrays (positions/radii/colors, reusing the projectPoints packing — refactor `projectPoints` to share the packer, or call into it) and `path` items into `ProjectedPath[]` (parse colors to RGBA bytes via `d3-color`, fail-fast on invalid like `scene.ts`). Null items culled. Returns `{points, paths}` (each null if empty).

Node tests: a mix of point items + path items → correct PointBatch counts/positions + ProjectedPath array with parsed colors + culling. Invalid color throws.

## Task 2 — Generalize `PassThroughSpec` + engine + `plot.points`
**Files:** modify `base-engine.ts`, `plot.ts`.

- `PassThroughSpec`: replace `project/radius/color` with `buildItem: (d: unknown, i: number) => DrawItem | null`. Keep `name/source/sizeMode/clipTo`.
- `repaintPassThrough`/`appendPassThrough`: call `buildBatch(slice, spec.buildItem)` → `drawPassThrough(name, drawBatch, mode)` (unchanged time-slicing/cancellation).
- `plot.points`: build a `buildItem` returning `{kind:"points", centers:[[x,y]], radius, color}` per datum (points only — plot has no path geometry). Keep the callback-data + return-handle behavior.
- This is a refactor of Phase-1 internals; retained path untouched. All existing point pass-through tests must still pass (canvas + webgl).

## Task 3 — `geo-map.layer` buildItem for all geometry; lift the guard
**Files:** modify `geo-map.ts` (and reuse helpers from `geo-layer.ts`).

- Replace the point-only `project` (which throws on non-Point) with a `buildItem(f,i)` that switches on `geometry.type`:
  - `Point` → `{kind:"points", centers:[projectVisiblePoint(...)] filtered, radius: pointRadius, color: fill}` (cull if not visible).
  - `MultiPoint` → `{kind:"points", centers: visible projected centers, ...}`.
  - `Polygon`/`MultiPolygon`/`LineString`/`MultiLineString`/etc → record projected subpaths: `const rec = new PathRecorder(tolerance); geoPath(this.projection, rec)(feature); return {kind:"path", subpaths: rec.subpaths.map(clone), fill, stroke, lineWidth}`. (Reuse the exact `geoPath(projection, ctx)(feature)` call from `geo-layer.ts`.)
- Resolve `fill`/`stroke`/`lineWidth`/`pointRadius` from `LayerOptions` accessors. **Remove** the `"passThrough supports only Point geometry in Phase 1"` throw.
- Tests (browser): a Polygon pass-through layer + a LineString pass-through layer register without throwing (full render covered in Tasks 4/5).

## Task 4 — Canvas backend: draw path items
**Files:** modify `canvas/canvas-backend.ts`.

- `drawPassThrough(name, batch: DrawBatch, mode)`: keep the replace-first/render + snapshot-pan logic. In `drawPtBatch`, after drawing `batch.points` (existing), draw `batch.paths`: for each `ProjectedPath`, in the same identity-transform/screen-mapped space, trace its subpaths to a `Path2D` (apply `t.k*x+t.x` per point, or set the world transform and trace world coords — mirror `drawShapes`' world vs screen handling), then `fill` (if fill) and `stroke` (if stroke + lineWidth; world: `lineWidth*t.k`-ish per `drawShapes`). Reuse the `css()`/`fillStroke` conventions.
- Snapshot-pan unaffected (the whole canvas is still the accumulation surface).
- Browser tests: a filled polygon pass-through renders (pixel inside = fill color); a polyline renders its stroke; append + not-pickable hold for paths too.

## Task 5 — WebGL backend: tessellate path items into the FBO
**Files:** modify `webgl/passthrough-gl.ts`, `webgl/shaders.ts`; maybe `webgl-backend.ts` (no signature change — `drawPassThrough` already forwards the batch).

- Add `PT_FILL_VS`/reuse `FILL_FS`: a fill/stroke vertex shader taking `a_position` (vec2) + `a_color` (unorm8x4) + (for stroke screen-mode) `a_anchor` (vec2), `u_transform`/`u_screen`/`u_viewport`; outputs `v_color`. (Mirror `FILL_VS` but color from attribute, no texture/flags.) Layout `PT_FILL_LAYOUT`.
- In `PassThroughGL`: add reused scratch fill buffers (position/color/index) and stroke buffers (position/color/anchor/index) + two Models (fill, stroke) sharing the FBO. 
- `draw(batch: DrawBatch, transform, clear)`: render points (existing) AND, for `batch.paths`: tessellate each path's closed subpaths (`groupRings` → `tessellateFill`) → fill verts (bake `path.fill` per vertex), rebase indices; `expandStroke` each subpath if `lineWidth>0` → stroke verts (bake `path.stroke`), anchors. Accumulate across the batch's paths into the scratch buffers, then draw fill model + stroke model into the FBO in the same pass as points (one `beginRenderPass`, clear iff replace-first). 
- Browser/GPU tests: filled polygon renders (pixel readback inside = fill), polyline stroke renders, color-as-attribute (two polygons, two colors), accumulation/append, snapshot-pan still composites paths.

## Task 6 — Integration + verification
**Files:** `map/passthrough.browser.test.ts` (+ maybe a website-agnostic integration test).

- End-to-end through the engine on BOTH backends: a `geoMap` pass-through layer with a Polygon + a LineString + Points (mixed FeatureCollection) renders all three; `auto` upgrade keeps them; append works.
- Full verification: `tsc -b` clean; `npx vitest run` green; `pnpm --filter @mapequation/d3gl test:browser` full green.
- Update spec status (Phase 3 done) + commit.

## Out of scope (Phase 4 / later)
- Website docs + streaming example (Phase 4).
- Multiple simultaneous pass-through layers (single shared surface; inherited scope).
- Per-feature picking (still unsupported).
- Re-tessellation caching (re-tessellate-per-settle is accepted; a cache keyed by transform could come later if profiling demands).
