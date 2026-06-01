# d3gl — marker size modes, d3-shape links, unified example app — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goals:**
1. **Marker size mode** — point layers can size markers in `"world"` units (scale with zoom,
   current default) or `"screen"` px (constant, like text labels), cleanly across WebGL /
   Canvas / SVG.
2. **Use more d3-shape** — the phylotree example draws links with `d3.linkHorizontal()` /
   `d3.linkRadial()` (drawing into d3gl's `PathContext`), keeping layout in d3-hierarchy.
3. **Unified example app** — combine bioregions + phylotree into one React app
   (`examples/app`) with a left drawer to pick the example; add a root `dev` script.

Branch: `feat/phylotree-example` (PR #4). Run tests: Node from repo root
(`corepack pnpm@9.15.9 test <pat>`); browser from package
(`cd packages/<pkg> && corepack pnpm@9.15.9 exec vitest run --config vitest.config.ts <pat>`).

---

### Task 1: Point marker size mode (`world` | `screen`) across backends

**Files:** `packages/core/src/backend.ts` (RenderLayer flag), `packages/webgl/src/shaders.ts`
+ `renderer.ts` + `webgl-backend.ts`, `packages/canvas/src/canvas-backend.ts`,
`packages/svg/src/serialize.ts`, `packages/map/src/plot.ts` + `base-engine.ts`,
`packages/geo/src/geo-layer.ts`. Tests: extend backend browser tests.

**Model:** size mode is a per-layer property. Add to `RenderLayer`:
```ts
/** "world" (default): radius in reference px, scales with zoom. "screen": constant px. */
pointSizeMode?: "world" | "screen";
```
Thread it from the engine: `BaseEngine` `LayerSpec` gains `pointSizeMode`; `renderLayer()`
copies it onto the `RenderLayer`. `Plot.points(opts)` and geo point layers accept
`sizeMode?: "world" | "screen"` and store it on the spec.

**WebGL** (`shaders.ts` `POINT_VS` + `renderer.ts`): add uniforms `u_pointScreen` (float 0/1)
and `u_viewport` (vec2). Compute the corner offset in clip space for screen mode:
```glsl
vec3 c = u_transform * vec3(a_center, 1.0);            // center -> clip
vec2 off = (u_pointScreen > 0.5)
  ? a_corner * a_radius * vec2(2.0 / u_viewport.x, -2.0 / u_viewport.y)  // screen px -> clip
  : (u_transform * vec3(a_center + a_corner * a_radius, 1.0)).xy - c.xy; // world (scales)
gl_Position = vec4(c.xy + off, 0.0, 1.0);
```
`GroupRenderer` gets `setPointSizeMode("world"|"screen")` (sets `u_pointScreen` on the point
pass uniforms) and the point-pass uniforms include `u_viewport`; `WebGLBackend` constructs
the renderer with the viewport (it knows width/height) and calls `setPointSizeMode` per layer
from `layer.pointSizeMode` in `drawInto` (default "world").

**Canvas** (`canvas-backend.ts`): when a layer's `pointSizeMode === "screen"`, draw its
circles in the identity transform at projected centers. In the per-drawable loop, for circles:
- world: `ctx.arc(c.x, c.y, c.r, …)` under the active `setTransform(k,0,0,k,x,y)` (current).
- screen: `ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.arc(k*c.x + x, k*c.y + y, c.r, …);
  fill/stroke; ctx.restore();` (radius constant). The clip region still applies (clip is set
  in device space before the transform; verify a screen-mode circle is still clipped — if the
  clip was set under the k-transform, re-establish it, or accept that screen markers are drawn
  after clipped content; for the examples screen markers are city/tip dots that needn't clip).
  Simplest: pass the layer's `pointSizeMode` into the render loop.

**SVG** (`serialize.ts`): `svgFromLayers` already wraps everything in one `<g transform>`.
For `screen`-mode point drawables, emit their `<circle>`s into a **separate, untransformed**
group at screen coords: `cx = t.k*c.x + t.x`, `cy = t.k*c.y + t.y`, `r = c.r`. Build that
group after the main transformed group so screen markers sit on top. `svgFromLayers` receives
layers (which now carry `pointSizeMode`), so branch per layer.

**API:** `Plot.points(name, data, { …, sizeMode })`; `geoLayer`/`GeoMap.layer` point options
gain `sizeMode` (default "world"). Default everywhere is `"world"` so current behavior/tests
are unchanged.

- [ ] **Step 1: failing test** (WebGL screen mode keeps pixel size constant under zoom). In
`packages/webgl`, a browser test: one screen-mode point radius 8 at center; render at k=1 and
again at k=4 (via `clipFromView({k:4,...})` keeping the center fixed) and assert the lit
pixel span across the center row is ~the same at both zooms (constant screen size), whereas a
world-mode point's span grows ~4×. (Use `GroupRenderer.setPointSizeMode` + a viewport uniform;
read a horizontal pixel strip and count non-clear pixels.)
- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** the flag + per-backend handling above.
- [ ] **Step 4: PASS** + full Node suite + all backend browser suites green (default "world"
unchanged). 
- [ ] **Step 5: commit** `feat: point marker size mode (world|screen) across WebGL/Canvas/SVG`

---

### Task 2: Unify the example apps into `examples/app` with a left drawer

**Files:** create `examples/app/{package.json,tsconfig.json,vite.config.ts,index.html}` and
`src/{main.tsx,App.tsx,examples/Bioregions.tsx,examples/PhyloTree.tsx, …support files}`. Move the
existing example sources in; delete `examples/bioregions` and `examples/phylotree`. Add a root
`dev` script.

- New package `@d3gl/example` (name used by the root script). `package.json` = union of the
  two old examples' deps (`@d3gl/core`, `@d3gl/map`, `@d3gl/geo`, `@d3gl/labels`, `@d3gl/svg`,
  `@d3gl/canvas`, `d3-geo`, `d3-hierarchy`, `d3-shape`, `d3-scale`, `d3-scale-chromatic`,
  `d3-selection`, `d3-zoom`, `topojson-client`, `world-atlas`, `react`, `react-dom`) + their
  devDeps and `@types/*`. `tsconfig.json` mirrors the old examples (jsx, resolveJsonModule,
  paths for every `@d3gl/*`). `vite.config.ts` aliases every `@d3gl/*` to source. Copy
  `world-atlas.d.ts`. Run `corepack pnpm@9.15.9 install`.
- Move `examples/bioregions/src/{data.ts,App.tsx}` → `examples/app/src/examples/Bioregions.tsx`
  (rename the exported component `Bioregions`, keep its logic) + `bioregions-data.ts`. Move
  `examples/phylotree/src/{tree.ts,layout.ts,App.tsx}` → `examples/app/src/examples/PhyloTree.tsx`
  + `tree.ts`/`layout.ts`. Each becomes a self-contained component (no top-level `App`).
- `App.tsx` shell: a flex layout — a left **drawer** (~200px, list of examples:
  "Bioregions", "Phylogenetic tree") and a main content area rendering the selected component.
  Selected example in `useState`; clicking a drawer item switches. Style: drawer dark panel,
  main area fills remaining width (reduces the black space — let the example sit top-left in a
  larger area). Keep each example's internal fixed W×H for now.
- `main.tsx`: `createRoot(...).render(<App/>)` (no StrictMode, as before).
- **Root `package.json`:** add `"dev": "pnpm --filter @d3gl/example dev"` to scripts (so VS
  Code's npm-scripts can launch it). Keep existing `build`/`test`.
- Delete `examples/bioregions` and `examples/phylotree` directories. Update the root vitest
  config if it referenced `examples/*` test globs (the phylotree `layout.test.ts` moves to
  `examples/app/src/layout.test.ts` — keep it working from the root Node config).

- [ ] Steps: scaffold package; move + rename components; build shell + drawer; root script;
  delete old dirs; `cd examples/app && corepack pnpm@9.15.9 typecheck && build` clean; full
  `corepack pnpm@9.15.9 test` green (layout test moved). Commit
  `refactor(example): unify bioregions + phylotree into one app with a drawer; add root dev script`.

---

### Task 3: Draw tree links with d3-shape generators

**Files:** `examples/app/src/examples/PhyloTree.tsx`, `…/layout.ts`.

Replace the hand-rolled `drawLink` with d3-shape link generators drawing into the
`PathContext` (demonstrates d3gl ↔ d3-shape compatibility):
- **Rectangular:** `d3.linkHorizontal<AugLink, AugNode>().x(d => d.px).y(d => d.py)` — set its
  `.context(ctx)` and call `link(l)` inside the layer `draw` (smooth cubic links). (Our
  rectangular px = horizontal/time axis, py = vertical spacing — `linkHorizontal` curves in x,
  matching a left→right dendrogram.)
- **Radial:** `d3.linkRadial<AugLink, AugNode>().angle(d => d.angle).radius(d => d.radius)`.
  `linkRadial` emits points via `pointRadial(angle, radius)` around the **origin (0,0)**, so:
  - In `layoutRadial`, store `node.angle` (cluster angle, d3 convention) + `node.radius`, and
    set `node.px, node.py = pointRadial(angle, radius)` (origin-centered; import `pointRadial`
    from d3-shape) — NOT offset by CX/CY.
  - The radial view is centered via the **view transform**: when the example is in radial mode,
    set the d3-zoom transform base to `translate(CX, CY)` (e.g.
    `zoomBehavior.transform(sel, zoomIdentity.translate(CX, CY))` and `transformRef = {k:1, x:CX, y:CY}`).
    In rectangular mode the base is identity. Reset the zoom to the layout's base on layout
    switch. Points/labels/hit-test all use the origin-centered `px,py`, so they stay aligned
    (the engine inverts the transform for hit-test; labels map ref→screen through it).
- The `draw` fn for the links layer: `(ctx, l) => linkGen(l)` where `linkGen` has `.context(ctx)`
  bound. Build the generator per render (cheap) with the current accessors.
- Keep the tip-node `points` layer and labels as-is (labels already use `n.px/n.py`).

- [ ] Steps: add `d3-shape` (+ `@types/d3-shape`) dep if missing; implement; example
  `typecheck && build` clean. Commit `feat(example): draw tree links with d3.linkHorizontal/linkRadial (d3-shape into PathContext)`.

(The controller verifies visually: rectangular curved links, radial centered with d3.linkRadial
curves, screen-mode vs world-mode markers, the drawer switching between examples.)

---

## Self-review notes
- Size mode defaults to `"world"` everywhere → no behavior change for existing tests/examples
  until a layer opts into `"screen"`.
- Radial uses origin-centered coords + a centering view transform so `d3.linkRadial` works
  unmodified; hit-test/labels stay consistent because they all go through the same transform.
- The unified app keeps each example's internals; only the shell/drawer + packaging change.
- Root `dev` script targets `@d3gl/example` (the new unified package name).
