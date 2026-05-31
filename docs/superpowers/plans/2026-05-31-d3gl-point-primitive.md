# d3gl analytic point/circle primitive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make points/circles a first-class primitive that renders as a **true circle** on
every backend at any zoom — no polygon facets, no LOD subdivision. SVG `<circle>`, Canvas
`arc`, WebGL fragment-shader circle on a quad (deck.gl ScatterplotLayer style). Wire it into
`geoLayer` (GeoJSON Point/MultiPoint) and `plot`, and use it for the phylotree tip nodes and
bioregions cities.

**Architecture:** A drawable can be a *circle drawable* carrying `(x, y, radius)` centers
(not flattened path points). It shares the existing drawableId / palette-color / flag / id
system. Backends render circles natively; the WebGL backend expands each circle to a quad
and discards fragments outside the unit disc in the fragment shader. Radius is in reference
(pre-transform) pixels, so circles scale with zoom like all other geometry.

**Tech stack:** TypeScript, luma.gl v9.3, Vitest (Node + browser). Run tests: Node from repo
root `corepack pnpm@9.15.9 test <pat>`; browser from the package
`cd packages/<pkg> && corepack pnpm@9.15.9 exec vitest run --config vitest.config.ts <pat>`.

Builds on the merged backend + plot work. Current relevant shapes:
- `GroupData` already has `subpaths: Subpath[][]`, `ids`, `lineWidths`, `fillColors`,
  `strokeColors`, `flags`, `ranges`, `idToDrawable` (parallel arrays indexed by drawableId =
  `ranges.length` at insert time).
- `GroupBuffers` = `{ fillVertices, fillIndices, strokeVertices, strokeIndices, fillColors,
  strokeColors, flags, drawableCount }`.
- `DrawableVector` = `{ id, subpaths, fill, stroke, lineWidth, flags }`.

---

### Task 1: Core — circle drawables (`@d3gl/core`)

**Files:** Modify `packages/core/src/scene.ts`, `packages/core/src/hit-test.ts`,
`packages/core/src/index.ts`. Test: `packages/core/src/__tests__/scene-points.test.ts`,
extend `packages/core/src/__tests__/hit-test.test.ts`.

Add to `GroupData`: `circles: { x: number; y: number; r: number }[][] = []` (one array per
drawable; empty for path drawables). Add a private `addCircleDrawable(data, id, centers, r)`
that mirrors `addDrawable`'s bookkeeping but with **no** path geometry:
- push a zero fill+stroke range (so `drawableId = ranges.length` stays aligned),
- `data.subpaths.push([])`, `data.circles.push(centers.map(([x,y]) => ({x,y,r})))`,
- `data.ids.push(id)`, `data.lineWidths.push(0)`,
- default `fillColors`/`strokeColors` (0,0,0,0) and `flags` (1) — same as `addDrawable`.
Path drawables push `data.circles.push([])` in `addDrawable` to keep arrays aligned.

Extend `GroupBuilder`:
```ts
export interface GroupBuilder {
  drawable(id: string | number, draw: (ctx: PathRecorder) => void, opts?: DrawableOpts): void;
  /** A single filled circle at (x, y) with the given radius (reference px). */
  point(id: string | number, x: number, y: number, radius: number): void;
  /** Multiple circles (one drawable, e.g. a GeoJSON MultiPoint). */
  points(id: string | number, centers: readonly [number, number][], radius: number): void;
}
```
Wire both to `addCircleDrawable` (`point` = single-element centers).

Extend `GroupBuffers` with point data and build it in `buffers(name)`:
```ts
// added fields:
pointCenters: Float32Array;  // stride 4: [x, y, radius, drawableId] per circle
pointCount: number;
```
Build by iterating drawables in order: for each drawable `i`, for each circle, push
`x, y, r, i`. Circles use the **fill** color (set via `setFill`) and the drawable's flag.

Extend `DrawableVector` with `circles: { x: number; y: number; r: number }[]`; populate from
`data.circles[i]` in `drawables(name)`.

`HitIndex`: for a drawable with circles, a hit is `distance(point, center) <= r + tolerance`.
In the constructor, record circles per entry; in `pick`, after the bbox prefilter, test
circles (in addition to filled rings / strokes). Bbox for a circle drawable = union of
`[cx±r, cy±r]`.

- [ ] **Step 1: failing tests**

```ts
// packages/core/src/__tests__/scene-points.test.ts
import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";
describe("circle drawables", () => {
  it("records points as circle drawables with fill color + point buffer", () => {
    const s = new Scene();
    s.group("g", (b) => {
      b.point("a", 10, 20, 3);
      b.points("b", [[30, 30], [40, 40]], 2);
    });
    s.setFill("g", "a", "rgb(255,0,0)");
    const ds = s.drawables("g");
    expect(ds[0]!.circles).toEqual([{ x: 10, y: 20, r: 3 }]);
    expect(ds[0]!.fill).toEqual([255, 0, 0, 255]);
    expect(ds[1]!.circles.length).toBe(2);
    const buf = s.buffers("g");
    expect(buf.pointCount).toBe(3);             // 1 + 2 circles
    expect(buf.drawableCount).toBe(2);
    // first circle: x,y,r,drawableId
    expect(Array.from(buf.pointCenters.slice(0, 4))).toEqual([10, 20, 3, 0]);
    expect(buf.pointCenters[11]).toBe(1);        // 3rd circle's drawableId = 1
  });
});
```
Add to `hit-test.test.ts`:
```ts
it("hits circle drawables within the radius", () => {
  const s = new Scene();
  s.group("g", (b) => b.point("dot", 50, 50, 5));
  const idx = new HitIndex(s.drawables("g"));
  expect(idx.pick(52, 52)).toBe("dot");   // inside r=5
  expect(idx.pick(60, 60)).toBe(null);    // outside
});
```

- [ ] **Step 2: run, FAIL.** `corepack pnpm@9.15.9 test scene-points hit-test`
- [ ] **Step 3: implement** the above.
- [ ] **Step 4: run, PASS** + full core suite green (existing scene-vector/buffer tests unaffected — path drawables now also push an empty `circles` entry; `pointCount` is 0 for them).
- [ ] **Step 5: commit** `feat(core): circle drawables — point()/points() builder, point buffers, hit-test`

---

### Task 2: WebGL analytic point pass (`@d3gl/webgl`)

**Files:** Modify `packages/webgl/src/shaders.ts` (add `POINT_VS`, `POINT_FS`),
`packages/webgl/src/renderer.ts` (point pass). Test: `packages/webgl/src/points.browser.test.ts`.

Shaders (GLSL 300 es; mirror `FILL_VS` palette/flags lookup):
```glsl
// POINT_VS
#version 300 es
precision highp float;
uniform mat3 u_transform;
uniform highp sampler2D u_colorTable;
uniform highp sampler2D u_flags;
in vec2 a_center; in vec2 a_corner; in float a_radius; in float a_pointId;
out vec4 v_color; out vec2 v_local;
void main() {
  int id = int(a_pointId + 0.5);
  ivec2 cs = textureSize(u_colorTable, 0);
  v_color = texelFetch(u_colorTable, ivec2(id % cs.x, id / cs.x), 0);
  ivec2 fsz = textureSize(u_flags, 0);
  int flags = int(texelFetch(u_flags, ivec2(id % fsz.x, id / fsz.x), 0).r * 255.0 + 0.5);
  if ((flags & 1) == 0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  v_local = a_corner;
  vec2 world = a_center + a_corner * a_radius;     // radius in reference px (scales with zoom)
  vec3 p = u_transform * vec3(world, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}
```
```glsl
// POINT_FS
#version 300 es
precision highp float;
in vec4 v_color; in vec2 v_local; out vec4 fragColor;
void main() { if (dot(v_local, v_local) > 1.0) discard; fragColor = v_color; }
```

In `renderer.ts`: build a point pass when `buffers.pointCount > 0`. Expand each circle to a
quad (4 verts, 6 indices):
- `a_center` Float32Array(4N·2): center repeated ×4 per circle.
- `a_corner` Float32Array(4N·2): `(-1,-1),(1,-1),(1,1),(-1,1)`.
- `a_radius` Float32Array(4N): radius ×4.
- `a_pointId` Float32Array(4N): drawableId ×4 (from `pointCenters[i*4+3]`).
- index Uint32Array(6N): `[0,1,2, 0,2,3]` + `4*i`.
- bufferLayout `[{name:"a_center",format:"float32x2"},{name:"a_corner",format:"float32x2"},{name:"a_radius",format:"float32"},{name:"a_pointId",format:"float32"}]`.
- bindings = the SAME `u_colorTable`/`u_flags` textures the fill pass builds (circles use fill
  color); shared `uniforms` object (so `setTransform` updates it). A `Model` with `POINT_VS`/
  `POINT_FS`, `topology:"triangle-list"`, the index buffer, `vertexCount: indices.length`.
- `render(pass)` draws fill, stroke, **then points**. `setStencil(mode)` must also call
  `setParameters` on the point model (so clipped point layers clip). `updateColors` must
  re-upload the point pass's color/flags textures too (reuse the fill textures or rebuild).
- `destroy()` destroys point pass resources.

Simplest wiring: reuse the existing `buildPass` palette/flags-texture creation by sharing the
fill pass's textures with the point pass (build the point Model with `bindings` pointing at
`this.fill.colorTexture`/`this.fill.flagsTexture` when a fill pass exists; otherwise build
point-only textures from `buffers.fillColors`/`buffers.flags`). Whatever is cleanest — the
invariant: points are colored by `fillColors[drawableId]` and culled by `flags`.

- [ ] **Step 1: failing browser test** — render two points, assert the **center** pixel is the
fill color and a pixel just **outside the radius** is the clear color (proves analytic disc):

```ts
// packages/webgl/src/points.browser.test.ts
import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Scene } from "@d3gl/core";
import { GroupRenderer } from "./renderer.js";
import { clipFromView } from "./transform.js";

const W = 64, H = 64;
describe("WebGL analytic points", () => {
  it("rasterizes a filled circle (center in, corner out)", async () => {
    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    document.body.appendChild(canvas);
    const device = await luma.createDevice({ adapters: [webgl2Adapter], type: "webgl", createCanvasContext: { canvas, useDevicePixels: false } });
    const fb = device.createFramebuffer({ width: W, height: H, colorAttachments: ["rgba8unorm"] });
    const scene = new Scene();
    scene.group("p", (b) => b.point("a", 32, 32, 12));
    scene.setFill("p", "a", "rgb(255,0,0)");
    const r = new GroupRenderer(device, scene.buffers("p"));
    r.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
    const pass = device.beginRenderPass({ framebuffer: fb, clearColor: [0, 0, 0, 1] });
    r.render(pass); pass.end(); device.submit();
    const px = (x: number, y: number) => device.readPixelsToArrayWebGL(fb, { sourceX: x, sourceY: H - 1 - y, sourceWidth: 1, sourceHeight: 1 });
    expect(px(32, 32)[0]).toBeGreaterThan(200);   // center -> red
    const corner = px(32 + 11, 32 + 11);          // ~ (r,r) diagonal ≈ 15.5 > 12 -> outside disc
    expect(corner[0]).toBeLessThan(40);
    r.destroy(); fb.destroy(); device.destroy();
  });
});
```

- [ ] Steps: write test → FAIL → implement point pass + shaders → PASS → existing webgl browser
suite still green (fill/stroke unchanged when `pointCount===0`) → commit
`feat(webgl): analytic point pass (fragment-shader circle on a quad)`.

---

### Task 3: Canvas + SVG circles (`@d3gl/canvas`, `@d3gl/svg`)

**Files:** Modify `packages/canvas/src/canvas-backend.ts`, `packages/svg/src/serialize.ts`.
Extend the existing backend browser/Node tests (or add a focused assertion).

- **Canvas:** in the per-drawable render loop, after tracing subpaths, for each circle in
  `d.circles`: `ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, 2*Math.PI); ctx.closePath();` then
  fill (if `d.fill[3] > 0`) and stroke (if `d.stroke[3] > 0 && d.lineWidth > 0`). Honors the
  active `ctx.clip()`.
- **SVG (`svgFromLayers`):** for each drawable, after its `<path>`, emit a `<circle cx cy r>`
  per circle with the same `fill`/`stroke` attributes. (A drawable is path-OR-circles, so in
  practice one of the two is non-empty.)
- Add an assertion to `canvas-backend.browser.test.ts`: a `point` drawable paints its centre
  pixel; and to `serialize.test.ts`: the SVG contains `<circle`.

- [ ] Steps: TDD each; commit `feat(canvas,svg): render circle drawables natively (arc / <circle>)`.

---

### Task 4: Wire geoLayer + plot.points(); update examples

**Files:** Modify `packages/geo/src/geo-layer.ts`, `packages/map/src/plot.ts`,
`examples/phylotree/src/App.tsx`. Verify bioregions cities still render.

- **geoLayer:** replace the closed-arc dot drawing for `Point`/`MultiPoint` with the builder
  point API. `geoLayer` currently calls `g.drawable(id, drawFn, opts)`. For a Point feature,
  call `g.point(id, px, py, radius)`; for MultiPoint, `g.points(id, projectedCenters, radius)`.
  (Project each coordinate with `projection`.) Non-point geometries keep using `g.drawable` +
  `geoPath`. The `geoLayer` builder must therefore branch per feature geometry type and call
  the right builder method — restructure so the returned `(g) => void` inspects each feature.
- **plot:** add a points layer method:
  ```ts
  export interface PlotPointOptions<D = any> {
    x: (d: D, i: number) => number; y: (d: D, i: number) => number;
    radius?: number | ((d: D, i: number) => number);
    fill?: string | ((d: D, i: number) => string);
    stroke?: string | ((d: D, i: number) => string);
    id?: (d: D, i: number) => string | number; clipTo?: string;
  }
  // Plot.points(name, data, opts): registerLayer with build = (g) => data.forEach((d,i) =>
  //   g.point(ids[i], opts.x(d,i), opts.y(d,i), resolveRadius)); fill/stroke accessors as usual.
  ```
  (Radius is constant per call in the simplest form; per-datum radius optional.)
- **phylotree App:** replace the `nodes` draw-layer (`dot` via context) with
  `chart.points("nodes", tipNodes, { x: n => n.px, y: n => n.py, radius: 2.6, fill: n => schemeCategory10[n.data.group % 10], id: (_n,i) => 't'+i })`. Remove the now-unused `dot` helper. Hover/labels unchanged (hit-test now hits circles).
- **bioregions:** cities go through `geoLayer` (Point) → now analytic automatically; no code
  change, but verify they still render after the geoLayer change.

- [ ] Steps: implement; `corepack pnpm@9.15.9 test` green; both examples `typecheck && build`
  clean; commit `feat(geo,map): route Point/MultiPoint through the circle primitive; plot.points(); examples`.
  (Controller verifies smooth circles via headless screenshots, incl. a zoomed-in tip.)

---

## Self-review notes
- Spec coverage: circle drawable in core (Task 1), analytic rendering on all three backends
  (Tasks 2–3), GeoJSON Point/MultiPoint + plot + examples (Task 4).
- Alignment invariant: circle drawables occupy the same drawableId space as path drawables
  (push a zero range), so `fillColors`/`flags`/`pointCenters[...][3]` all agree.
- Radius is reference-pixel (scales with zoom), consistent with project-once geometry; a
  screen-constant radius mode is future work (note, don't build).
- Existing tests guard no-regression: path drawables get empty `circles`; `pointCount===0`
  leaves the WebGL/Canvas/SVG paths byte-identical to today.
