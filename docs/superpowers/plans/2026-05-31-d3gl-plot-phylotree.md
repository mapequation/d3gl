# d3gl `plot()` engine + phylogenetic tree example — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Add a generic, d3-familiar `plot()` engine (draw-into-context layers) to
`@d3gl/map` by extracting the shared machinery `GeoMap` already has, then build a
phylogenetic tree example (rectangular ⇄ radial, size slider, labels, backend switch,
zoom, hover).

**Architecture:** Extract `BaseEngine` from `GeoMap` (Scene + backends + transform + zoom +
hover + recolor + clip + export + hit-test). `GeoMap` and the new `Plot` both extend it and
only differ in how a layer's Scene group is built (geoLayer vs a user draw function). Layout
stays in d3-hierarchy.

**Tech stack:** TypeScript, d3-hierarchy, `@d3gl/map`, `@d3gl/labels`, Vitest browser.

Plan depends on the merged backend-abstraction work. Run tests: Node from repo root
(`corepack pnpm@9.15.9 test <pat>`); browser from the package
(`cd packages/<pkg> && corepack pnpm@9.15.9 exec vitest run --config vitest.config.ts <pat>`).

---

### Task 1: Extract `BaseEngine`; reimplement `GeoMap` on it; add `plot()`/`Plot`

**Files:**
- Create: `packages/map/src/base-engine.ts`
- Modify: `packages/map/src/geo-map.ts` (GeoMap extends BaseEngine)
- Create: `packages/map/src/plot.ts`
- Modify: `packages/map/src/index.ts` (export `plot`, `Plot`, `PlotLayerOptions`)
- Test: `packages/map/src/plot.browser.test.ts`

Context: read the current `packages/map/src/geo-map.ts`. It already implements everything;
this task moves the non-geo parts into `BaseEngine` and adds a second public engine. **The
GeoMap public API and behavior must not change** — the existing `geo-map.browser.test.ts`,
`set-clip.browser.test.ts`, the react tests, and the bioregions example all depend on it and
must stay green.

`BaseEngine` (protected/shared). A `LayerSpec` now carries the data + a group builder:

```ts
import { geoPath } from "d3-geo"; // (only if needed; drop if unused)
import { select } from "d3-selection";
import { zoom as d3zoom, type D3ZoomEvent } from "d3-zoom";
import { Scene, HitIndex, type GroupBuilder, type RenderLayer, type ViewTransform } from "@d3gl/core";
import { createBackend, type BackendType, type BackendHandle } from "./backend-factory.js";

export type Accessor<D, T> = T | ((d: D, i: number) => T);
export interface HoverHit { layer: string; id: string | number; datum: unknown; }

interface LayerSpec {
  name: string;
  data: any[];
  ids: (string | number)[];
  fill?: Accessor<any, string>;
  stroke?: Accessor<any, string>;
  clipTo?: string;
  build: (g: GroupBuilder) => void;   // rebuilds the Scene group (geo or draw)
}

export abstract class BaseEngine {
  protected scene = new Scene();
  protected specs: LayerSpec[] = [];
  protected hitIndexes = new Map<string, HitIndex>();
  protected transform: ViewTransform = { k: 1, x: 0, y: 0 };
  protected handle: BackendHandle | null = null;
  protected ready: Promise<void>;
  private hoverCb: ((hit: HoverHit | null, ev: PointerEvent) => void) | null = null;
  private swapToken = 0;

  constructor(protected host: HTMLElement, protected width: number, protected height: number, backend: BackendType) {
    this.ready = this.swapBackend(backend);
  }
  whenReady(): Promise<void> { return this.ready; }

  /** Register/replace a layer: build its Scene group, apply accessors, index, push. */
  protected registerLayer(spec: LayerSpec): void {
    this.scene.group(spec.name, spec.build);
    this.applyAccessors(spec);
    this.specs = this.specs.filter((s) => s.name !== spec.name).concat(spec);
    this.hitIndexes.set(spec.name, new HitIndex(this.scene.drawables(spec.name)));
    this.pushLayers();
  }

  recolor(name: string): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    this.applyAccessors(spec);
    this.handle?.backend.updateLayer(name, this.renderLayer(spec));
    this.render();
    return this;
  }
  setClip(name: string, clipTo?: string): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    spec.clipTo = clipTo;
    this.pushLayers();
    return this;
  }
  setBackend(type: BackendType): this { this.ready = this.swapBackend(type); return this; }
  setTransform(t: ViewTransform): this { this.transform = t; this.handle?.backend.setTransform(t); this.render(); return this; }
  enableZoom(extent: [number, number] = [1, 100]): this {
    const sel = select(this.host as Element);
    const behavior = d3zoom<Element, unknown>().scaleExtent(extent).on("zoom", (e: D3ZoomEvent<Element, unknown>) => {
      this.setTransform({ k: e.transform.k, x: e.transform.x, y: e.transform.y });
    });
    (sel as any).call(behavior);
    return this;
  }
  on(event: "hover", cb: (hit: HoverHit | null, ev: PointerEvent) => void): this {
    if (event === "hover") {
      this.hoverCb = cb;
      this.host.addEventListener("pointermove", this.onPointerMove);
      this.host.addEventListener("pointerleave", this.onPointerLeave);
    }
    return this;
  }
  pick(x: number, y: number): HoverHit | null {
    const px = (x - this.transform.x) / this.transform.k;
    const py = (y - this.transform.y) / this.transform.k;
    for (let i = this.specs.length - 1; i >= 0; i--) {
      const spec = this.specs[i]!;
      const id = this.hitIndexes.get(spec.name)?.pick(px, py);
      if (id != null) {
        const di = spec.ids.indexOf(id);
        return { layer: spec.name, id, datum: di >= 0 ? spec.data[di] : null };
      }
    }
    return null;
  }
  render(): this { this.handle?.backend.render(); return this; }
  toSVG(): string { return this.handle?.backend.toSVG() ?? ""; }
  toPNG(): string { return this.handle?.backend.toPNG() ?? ""; }
  destroy(): void {
    this.host.removeEventListener("pointermove", this.onPointerMove);
    this.host.removeEventListener("pointerleave", this.onPointerLeave);
    this.handle?.backend.destroy();
    if (this.handle && this.handle.element !== this.host) this.handle.element.remove();
    this.handle = null;
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.hoverCb) return;
    const r = this.host.getBoundingClientRect();
    this.hoverCb(this.pick(e.clientX - r.left, e.clientY - r.top), e);
  };
  private onPointerLeave = (e: PointerEvent): void => { this.hoverCb?.(null, e); };
  private resolve<T>(a: Accessor<any, T> | undefined, d: any, i: number): T | undefined {
    return typeof a === "function" ? (a as (d: any, i: number) => T)(d, i) : a;
  }
  private applyAccessors(spec: LayerSpec): void {
    spec.data.forEach((d, i) => {
      const id = spec.ids[i]!;
      const fill = this.resolve(spec.fill, d, i);
      if (fill) this.scene.setFill(spec.name, id, fill);
      const stroke = this.resolve(spec.stroke, d, i);
      if (stroke) this.scene.setStroke(spec.name, id, stroke);
    });
  }
  private renderLayer(spec: LayerSpec): RenderLayer {
    return { name: spec.name, buffers: this.scene.buffers(spec.name), drawables: this.scene.drawables(spec.name), clipTo: spec.clipTo };
  }
  private pushLayers(): void {
    this.handle?.backend.setLayers(this.specs.map((s) => this.renderLayer(s)));
    this.handle?.backend.setTransform(this.transform);
    this.render();
  }
  private async swapBackend(type: BackendType): Promise<void> {
    const token = ++this.swapToken;
    const old = this.handle;
    const next = await createBackend(type, this.host, this.width, this.height);
    if (token !== this.swapToken) { next.backend.destroy(); if (next.element !== this.host) next.element.remove(); return; }
    old?.backend.destroy();
    if (old && old.element !== this.host) old.element.remove();
    this.handle = next;
    next.backend.setLayers(this.specs.map((s) => this.renderLayer(s)));
    next.backend.setTransform(this.transform);
    next.backend.render();
  }
}
```

`GeoMap` (reimplemented on the base — keep `GeoMapOptions`, `LayerOptions`, exports, and
behavior identical):

```ts
import { type GeoProjection } from "d3-geo";
import { geoLayer } from "@d3gl/geo";
import { BaseEngine, type HoverHit } from "./base-engine.js";
import type { BackendType } from "./backend-factory.js";

export interface GeoMapOptions { width: number; height: number; projection: GeoProjection; backend?: BackendType; }
export interface LayerOptions<F = any> {
  fill?: string | ((f: F, i: number) => string);
  stroke?: string | ((f: F, i: number) => string);
  lineWidth?: number; pointRadius?: number; clipTo?: string;
  id?: (f: F, i: number) => string | number;
}

export class GeoMap extends BaseEngine {
  constructor(host: HTMLElement, private opts: GeoMapOptions) {
    super(host, opts.width, opts.height, opts.backend ?? "webgl");
  }
  layer<F>(name: string, features: F | readonly F[], opts: LayerOptions<F> = {}): this {
    const list = Array.isArray(features) ? (features as F[]) : [features as F];
    const ids = list.map((f, i) => (opts.id ? opts.id(f, i) : i));
    this.registerLayer({
      name, data: list as any[], ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo,
      build: geoLayer(list as any[], this.opts.projection, { id: (_f, i) => ids[i]!, lineWidth: opts.lineWidth, pointRadius: opts.pointRadius }),
    });
    return this;
  }
}
export function geoMap(host: HTMLElement, opts: GeoMapOptions): GeoMap { return new GeoMap(host, opts); }
export type { HoverHit };
```

`Plot` (NEW — `packages/map/src/plot.ts`):

```ts
import type { GroupBuilder, PathContext } from "@d3gl/core";
import { BaseEngine } from "./base-engine.js";
import type { BackendType } from "./backend-factory.js";

export interface PlotOptions { width: number; height: number; backend?: BackendType; }
export interface PlotLayerOptions<D = any> {
  draw: (ctx: PathContext, datum: D, index: number) => void;
  fill?: string | ((d: D, i: number) => string);
  stroke?: string | ((d: D, i: number) => string);
  lineWidth?: number; clipTo?: string;
  id?: (d: D, i: number) => string | number;
}

export class Plot extends BaseEngine {
  constructor(host: HTMLElement, opts: PlotOptions) { super(host, opts.width, opts.height, opts.backend ?? "webgl"); }
  layer<D>(name: string, data: readonly D[], opts: PlotLayerOptions<D>): this {
    const list = data as D[];
    const ids = list.map((d, i) => (opts.id ? opts.id(d, i) : i));
    const drawOpts = opts.lineWidth != null ? { lineWidth: opts.lineWidth } : undefined;
    const build = (g: GroupBuilder): void => {
      list.forEach((d, i) => g.drawable(ids[i]!, (ctx: PathContext) => opts.draw(ctx, d, i), drawOpts));
    };
    this.registerLayer({ name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo, build });
    return this;
  }
}
export function plot(host: HTMLElement, opts: PlotOptions): Plot { return new Plot(host, opts); }
```

Update `index.ts` to export `plot`, `Plot`, `PlotLayerOptions`, and keep all existing
exports (`geoMap`, `GeoMap`, `GeoMapOptions`, `LayerOptions`, `HoverHit`, `createBackend`,
`BackendType`, `BackendHandle`). Note `HoverHit` is now defined in `base-engine.ts`; re-export
it from the same names so consumers (the bioregions example imports `HoverHit` from
`@d3gl/map`) keep working.

- [ ] **Step 1: Write the failing test** — `packages/map/src/plot.browser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { PathContext } from "@d3gl/core";
import { plot } from "./plot.js";

describe("plot engine", () => {
  it("draws via a context fn, recolors, hit-tests, switches backend", async () => {
    const host = document.createElement("div");
    host.style.width = "200px"; host.style.height = "200px";
    document.body.appendChild(host);
    const chart = plot(host, { width: 200, height: 200, backend: "canvas" });
    await chart.whenReady();
    const rects = [{ x: 20, y: 20 }, { x: 120, y: 120 }];
    chart.layer("boxes", rects, {
      draw: (ctx: PathContext, d) => ctx.rect(d.x, d.y, 40, 40),
      fill: (_d, i) => (i === 0 ? "rgb(255,0,0)" : "rgb(0,0,255)"),
      id: (_d, i) => `b${i}`,
    });
    chart.render();
    expect(chart.pick(40, 40)?.id).toBe("b0");      // inside first box
    expect(chart.pick(140, 140)?.id).toBe("b1");
    expect(chart.pick(80, 80)).toBe(null);          // gap
    chart.recolor("boxes");
    chart.setBackend("webgl");
    await chart.whenReady();
    expect(host.querySelector("canvas")).toBeTruthy();
    chart.destroy();
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `cd packages/map && corepack pnpm@9.15.9 exec vitest run --config vitest.config.ts plot` → FAIL.

- [ ] **Step 3: Implement** the refactor + `Plot` as above.

- [ ] **Step 4: Verify.** New plot test passes. **Critically:** the existing map browser
tests stay green (`cd packages/map && corepack pnpm@9.15.9 exec vitest run --config vitest.config.ts`),
the full Node suite is green, and `cd examples/bioregions && corepack pnpm@9.15.9 typecheck && build`
still pass (GeoMap behavior preserved).

- [ ] **Step 5: Commit:** `git commit -m "feat(map): extract BaseEngine; add generic plot() engine (draw-into-context layers); GeoMap unchanged"`

---

### Task 2: `examples/phylotree` — tree layout + rendering

**Files:**
- Create: `examples/phylotree/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/tree.ts`, `src/layout.ts`, `src/App.tsx`
- Test: `examples/phylotree/src/layout.test.ts` (Node) — exclude in tsconfig like other examples
- Mirror `examples/bioregions` config files (vite alias to `packages/*/src/index.ts`, tsconfig paths). `package.json` deps: `@d3gl/core`, `@d3gl/map`, `@d3gl/labels`, `d3-hierarchy`, `d3-scale-chromatic`, `d3-selection`, `d3-zoom`, `react`, `react-dom`; devDeps `@types/d3-hierarchy`, `@types/d3-*`, `@types/react*`, `@vitejs/plugin-react`, `typescript`, `vite`. Run `corepack pnpm@9.15.9 install`.

`src/tree.ts` — generate a synthetic bifurcating tree with branch lengths:

```ts
export interface TreeNode { name: string; group: number; length: number; children?: TreeNode[]; }

/** Deterministic LCG so trees are stable across renders (no Math.random in render path). */
function lcg(seed: number) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff; }

/** Build a random bifurcating tree with ~`tips` leaves. */
export function makeTree(tips: number, seed = 42): TreeNode {
  const rnd = lcg(seed);
  let leafCount = 0;
  const build = (depth: number): TreeNode => {
    const length = 0.2 + rnd() * 0.8;
    const group = Math.floor(rnd() * 8);
    // Stop splitting once we have enough leaves or got deep.
    if (leafCount >= tips || depth > 40 || (depth > 2 && rnd() < 0.18 && leafCount < tips)) {
      leafCount++;
      return { name: `tip_${leafCount}`, group, length };
    }
    return { name: `node`, group, length, children: [build(depth + 1), build(depth + 1)] };
  };
  // Ensure at least 2 tips.
  const root = build(0);
  return root.children ? root : { name: "root", group: 0, length: 0, children: [root, build(0)] };
}
```

`src/layout.ts` — positions via d3-hierarchy; rectangular + radial:

```ts
import { hierarchy, cluster, type HierarchyNode } from "d3-hierarchy";
import type { TreeNode } from "./tree.js";

export interface Positioned { x: number; y: number; } // world coords
export type PNode = HierarchyNode<TreeNode> & Positioned;

/** Rectangular phylogram: cross-axis from cluster, main-axis = cumulative branch length. */
export function layoutRectangular(root: TreeNode, width: number, height: number, pad = 40): HierarchyNode<TreeNode> {
  const h = hierarchy(root, (d) => d.children);
  cluster<TreeNode>().size([height - 2 * pad, 1])(h);
  // cumulative distance from root
  let maxDist = 0;
  h.eachBefore((n: any) => { n.dist = (n.parent ? n.parent.dist : 0) + n.data.length; maxDist = Math.max(maxDist, n.dist); });
  const sx = (width - 2 * pad) / (maxDist || 1);
  h.each((n: any) => { n.x = pad + n.x; n.y = pad + n.dist * sx; });  // x: vertical pos, y: horizontal depth
  return h;
}

/** Radial: cross-axis -> angle, distance -> radius. */
export function layoutRadial(root: TreeNode, width: number, height: number, pad = 30): HierarchyNode<TreeNode> {
  const h = hierarchy(root, (d) => d.children);
  cluster<TreeNode>().size([2 * Math.PI, 1])(h);
  let maxDist = 0;
  h.eachBefore((n: any) => { n.dist = (n.parent ? n.parent.dist : 0) + n.data.length; maxDist = Math.max(maxDist, n.dist); });
  const R = Math.min(width, height) / 2 - pad;
  const cx = width / 2, cy = height / 2;
  h.each((n: any) => {
    const a = n.x;          // angle from cluster (0..2π)
    const r = (n.dist / (maxDist || 1)) * R;
    n.angle = a; n.radius = r;
    n.x = cx + r * Math.cos(a); n.y = cy + r * Math.sin(a);
  });
  return h;
}
```

`src/layout.test.ts` (Node):

```ts
import { describe, it, expect } from "vitest";
import { makeTree } from "./tree.js";
import { layoutRectangular, layoutRadial } from "./layout.js";

describe("tree layout", () => {
  it("rectangular: finite coords, leaves at increasing depth", () => {
    const h = layoutRectangular(makeTree(64), 800, 600);
    const ns = h.descendants() as any[];
    expect(ns.length).toBeGreaterThan(64);
    for (const n of ns) { expect(Number.isFinite(n.x)).toBe(true); expect(Number.isFinite(n.y)).toBe(true); }
    expect(h.links().length).toBe(ns.length - 1);
  });
  it("radial: finite coords within the viewport", () => {
    const h = layoutRadial(makeTree(64), 800, 600) as any;
    for (const n of h.descendants()) { expect(Number.isFinite(n.x)).toBe(true); expect(Number.isFinite(n.y)).toBe(true); }
  });
});
```

- [ ] Steps: write `layout.test.ts` first, run (FAIL), implement `tree.ts`+`layout.ts`, run (PASS), commit `feat(example): phylotree tree generator + rectangular/radial layout`.

---

### Task 3: `examples/phylotree` — App (plot rendering, labels, controls)

**Files:** `examples/phylotree/src/App.tsx`, `src/main.tsx`, `index.html`.

`App.tsx` responsibilities (use `plot()` imperatively + manual d3-zoom for label sync):
- State: `layout` ("rectangular"|"radial"), `backend`, `tips` (slider), `tooltip`.
- On mount / on `[layout, tips]` change: compute `h = layout==="rectangular" ? layoutRectangular(makeTree(tips),W,H) : layoutRadial(...)`; nodes = `h.descendants()`, links = `h.links()`.
- Create `plot(host, {width:W,height:H,backend})` once (store in ref); on layout/tips change, re-add the two layers:
  - `chart.layer("links", links, { draw: (ctx, l) => drawLink(ctx, l, layout), stroke: "#8aa", lineWidth: 0.6 })`
  - `chart.layer("nodes", nodes.filter(n=>!n.children), { draw:(ctx,n)=>dot(ctx,n.x,n.y,2.2), fill:(n)=>schemeCategory10[n.data.group%10], id:(n,i)=>`t${i}` })` (tips only as dots; or all nodes)
  - `drawLink(ctx, l, layout)`: rectangular → elbow: `ctx.moveTo(l.source.y, l.source.x); ctx.lineTo(l.source.y, l.target.x); ctx.lineTo(l.target.y, l.target.x)` (note rectangular stores x=vertical, y=horizontal; draw in (y,x)). radial → `ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y)` (straight radial; optionally an arc step). Keep coordinates consistent: in rectangular the world coords for the context are (n.y as X-screen, n.x as Y-screen) — i.e. pass `(n.y, n.x)`; in radial pass `(n.x, n.y)`. Pick a single convention: store final screen-space `(px, py)` on each node per layout so `draw`/labels/hit-test all agree. Recommended: in `layout.ts` set `n.px,n.py` to the actual canvas coordinates (rectangular: px=pad+dist*sx, py=pad+clusterX; radial: px,py as computed) and have `draw` use `(n.px, n.py)`. Update the layout functions to expose `px,py` and the test to assert those.
- `@d3gl/labels` `LabelLayer` over the host: anchors = tip nodes `{id, refX:n.px, refY:n.py, text:n.data.name, priority:n.data.length}`; on every transform change call `labelLayer.update(anchors, transform, {width:W,height:H})`.
- Manual d3-zoom on the wrapper → `chart.setTransform(t)` + `labelLayer.update(...)`. Keep the current transform in a ref so re-adding layers preserves it.
- Hover → `chart.on("hover", hit => tooltip)` showing the node name / branch length (hit.datum).
- Controls: layout buttons, backend buttons, tip-count `<input type=range min=64 max=4096>`, Export PNG/SVG.

Match the bioregions `App.tsx` styling/structure. Keep it readable.

- [ ] Steps: implement `App.tsx`+`main.tsx`+`index.html`; `corepack pnpm@9.15.9 typecheck && build` clean; commit `feat(example): phylotree app — plot() rendering, labels, rectangular/radial, backend switch, zoom`.

(The controller verifies rendering via headless screenshots: rectangular & radial on a
backend, labels visible, no console errors.)

---

## Self-review notes
- Spec coverage: `plot()` generic engine (Task 1), tree layout both styles + size (Task 2),
  app with labels/backends/zoom/hover/slider (Task 3).
- GeoMap preserved: Task 1 keeps its API and is guarded by existing tests + the bioregions
  build.
- Coordinate convention pitfall called out: expose final `px,py` per layout so draw, labels,
  and hit-test agree (don't mix the rectangular x/y swap across consumers).
- Type consistency: `HoverHit` moves to `base-engine.ts` and is re-exported from `@d3gl/map`
  under the same name (bioregions imports it).
