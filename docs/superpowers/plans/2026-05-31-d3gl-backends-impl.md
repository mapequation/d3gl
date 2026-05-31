# d3gl Backends (Canvas, SVG, WebGL+stencil) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement the three `Backend`s (from `@d3gl/core`) so the same Scene renders to
Canvas2D, DOM SVG, and WebGL — each with pan/zoom (`ViewTransform`) and pixel-accurate
clip-to-layer. Plus a shared layers→SVG serializer used by every backend's `toSVG()`.

**Architecture:** All backends consume `RenderLayer[]` (`{ name, buffers, drawables,
clipTo? }`) + a `ViewTransform`. Vector backends (Canvas/SVG) replay `DrawableVector`
subpaths; WebGL reuses the existing `GroupRenderer` (GPU buffers) and adds stencil
clipping via the spike-proven recipe. Clip source layers must appear **before** the layers
that clip to them (painter order); the engine guarantees this.

**Tech stack:** TypeScript, luma.gl v9.3 (WebGL), Vitest (Node for SVG string/serializer,
Playwright browser for Canvas/WebGL pixels). Run package tests via
`corepack pnpm@9.15.9 test` **inside each package dir**.

This is Plan 2 of 4. Depends on Plan 1 (core): `Backend`, `RenderLayer`, `ViewTransform`,
`DrawableVector`, `Scene.drawables()`. WebGL stencil recipe proven in
`packages/webgl/src/stencil-spike.browser.test.ts`.

**Test & package setup (read first):**
- **Node** tests (`*.test.ts`, e.g. the serializer) are collected by the **root**
  `vitest.config.ts`; run them from the repo root with `corepack pnpm@9.15.9 test
  <pattern>` (or `corepack pnpm@9.15.9 exec vitest run <pattern>`). The root config excludes
  `*.browser.test.ts`.
- **Browser** tests (`*.browser.test.ts`) need a per-package browser config. `@d3gl/webgl`
  and `@d3gl/geo` already have `vitest.config.ts` (browser, Playwright/Chromium). For
  `@d3gl/svg` and `@d3gl/canvas`, **create** `packages/<pkg>/vitest.config.ts` copied
  verbatim from `packages/geo/vitest.config.ts`. Run browser tests from inside the package:
  `cd packages/<pkg> && corepack pnpm@9.15.9 exec vitest run --config vitest.config.ts <pattern>`.
  `vitest`, `@vitest/browser-playwright`, and `playwright` resolve from the workspace root
  (geo uses them without listing them) — no need to add them to the package.
- **Workspace deps to add** (then run `corepack pnpm@9.15.9 install` from the repo root to
  relink): `@d3gl/canvas` → add `@d3gl/svg: "workspace:*"`; `@d3gl/webgl` → add
  `@d3gl/svg: "workspace:*"`. `@d3gl/svg` already depends on `@d3gl/core`.
- The `@luma.gl/*` packages needed by the WebGL browser test are already in
  `@d3gl/webgl`'s devDeps.

Shared helper used in several tasks — convert an RGBA byte tuple to a CSS color (alpha 0 ⇒
"none" for fill/stroke skipping):
```ts
export function rgba([r, g, b, a]: readonly [number, number, number, number]): string {
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(4)})`;
}
```

---

### Task 1: Shared layers→SVG serializer (`@d3gl/svg`)

**Files:**
- Create: `packages/svg/src/serialize.ts`
- Modify: `packages/svg/src/index.ts`
- Test: `packages/svg/src/__tests__/serialize.test.ts`

Context: `@d3gl/svg` already has `SvgPathContext` (PathContext→`d` string) and
`svgDocument(width,height,paths)`. We add `svgFromLayers` that turns `RenderLayer[]` +
`ViewTransform` into a full SVG string, including a `<clipPath>` per clipped layer and a
root `<g transform>` for pan/zoom. Each drawable becomes a `<path>` whose `d` is built by
replaying its subpaths into an `SvgPathContext` (moveTo/lineTo/closePath). This is used by
every backend's `toSVG()`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/svg/src/__tests__/serialize.test.ts
import { describe, it, expect } from "vitest";
import { Scene } from "@d3gl/core";
import { svgFromLayers } from "../serialize.js";

function layer(name: string, clipTo?: string) {
  const scene = new Scene();
  scene.group(name, (b) => b.drawable("d", (c) => c.rect(0, 0, 10, 10)));
  scene.setFill(name, "d", "rgb(10, 20, 30)");
  return { name, buffers: scene.buffers(name), drawables: scene.drawables(name), clipTo };
}

describe("svgFromLayers", () => {
  it("emits a transform group, a path per drawable, and a clipPath for clipped layers", () => {
    const land = layer("land");
    const cells = layer("cells", "land");
    const svg = svgFromLayers(200, 100, [land, cells], { k: 2, x: 5, y: 7 });
    expect(svg).toContain('width="200"');
    expect(svg).toContain("translate(5, 7) scale(2)");      // view transform
    expect(svg).toContain("<clipPath"); // clip def for the clipped layer
    expect(svg).toContain('clip-path="url(#');             // applied to cells group
    expect(svg).toContain("rgba(10, 20, 30");              // fill color
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThanOrEqual(3); // land + clip use + cells
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** From the repo root: `corepack pnpm@9.15.9 test serialize` (Node test via root config) → FAIL.

- [ ] **Step 3: Implement** `packages/svg/src/serialize.ts`:

```ts
import type { RenderLayer, ViewTransform, DrawableVector } from "@d3gl/core";
import { SvgPathContext } from "./svg-context.js";

function rgba([r, g, b, a]: readonly [number, number, number, number]): string {
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(4)})`;
}

function pathD(d: DrawableVector): string {
  const ctx = new SvgPathContext();
  for (const s of d.subpaths) {
    const p = s.points;
    if (p.length < 2) continue;
    ctx.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
    if (s.closed) ctx.closePath();
  }
  return ctx.toPath();
}

/** A full SVG document for the given layers under a view transform. */
export function svgFromLayers(width: number, height: number, layers: readonly RenderLayer[], t: ViewTransform): string {
  const defs: string[] = [];
  const groups: string[] = [];
  for (const layer of layers) {
    // A clipPath def referencing the named clip layer's silhouette.
    let clipAttr = "";
    if (layer.clipTo) {
      const src = layers.find((l) => l.name === layer.clipTo);
      if (src) {
        const id = `clip-${layer.name}`;
        const paths = src.drawables
          .filter((d) => (d.flags & 1) !== 0)
          .map((d) => `<path d="${pathD(d)}" />`)
          .join("");
        defs.push(`<clipPath id="${id}">${paths}</clipPath>`);
        clipAttr = ` clip-path="url(#${id})"`;
      }
    }
    const paths = layer.drawables
      .filter((d) => (d.flags & 1) !== 0)
      .map((d) => {
        const fill = d.fill[3] > 0 ? rgba(d.fill) : "none";
        const attrs = [`d="${pathD(d)}"`, `fill="${fill}"`];
        if (d.stroke[3] > 0 && d.lineWidth > 0) {
          attrs.push(`stroke="${rgba(d.stroke)}"`, `stroke-width="${d.lineWidth}"`);
        }
        return `<path ${attrs.join(" ")} />`;
      })
      .join("");
    groups.push(`<g${clipAttr}>${paths}</g>`);
  }
  const transform = `translate(${t.x}, ${t.y}) scale(${t.k})`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs>${defs.join("")}</defs><g transform="${transform}">${groups.join("")}</g></svg>`
  );
}
```

Export `svgFromLayers` (and `rgba` is internal). Add `@d3gl/core` to `packages/svg/package.json` deps if not present.

- [ ] **Step 4: Run tests, verify pass.** From repo root: `corepack pnpm@9.15.9 test serialize` → pass; full `corepack pnpm@9.15.9 test` still green.

- [ ] **Step 5: Commit:** `git commit -m "feat(svg): svgFromLayers — serialize render layers (with clipPath + view transform) to SVG"`

---

### Task 2: SvgBackend (`@d3gl/svg`)

**Files:**
- Create: `packages/svg/src/svg-backend.ts`
- Modify: `packages/svg/src/index.ts`
- Test: `packages/svg/src/__tests__/svg-backend.browser.test.ts`
- Create `packages/svg/vitest.config.ts` (copy `packages/geo/vitest.config.ts`) per the Test setup note.

Context: `SvgBackend implements Backend` building a live DOM `<svg>` inside the host
element. It uses `svgFromLayers` to produce markup, then sets it via `innerHTML` of the
root `<svg>` (simple, correct; incremental patching is a future optimization). Pan/zoom and
recolor just re-serialize and re-set `innerHTML` — acceptable for SVG (the slow-at-scale
backend, documented). `toSVG()` returns the same markup; `toPNG()` rasterizes via an
offscreen canvas (`<img>` from a data URL drawn to canvas → `toDataURL`), and if that
fails headlessly, throws a clear "route PNG via a raster backend" error.

- [ ] **Step 1: Write the failing browser test**

```ts
// packages/svg/src/__tests__/svg-backend.browser.test.ts
import { describe, it, expect } from "vitest";
import { Scene } from "@d3gl/core";
import { SvgBackend } from "../svg-backend.js";

function layer(name: string, color: string, clipTo?: string) {
  const scene = new Scene();
  scene.group(name, (b) => b.drawable("d", (c) => c.rect(0, 0, 50, 50)));
  scene.setFill(name, "d", color);
  return { name, buffers: scene.buffers(name), drawables: scene.drawables(name), clipTo };
}

describe("SvgBackend", () => {
  it("renders an <svg> with a group per layer and applies the transform", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const backend = new SvgBackend(el, 100, 100);
    backend.setLayers([layer("a", "rgb(255,0,0)")]);
    backend.setTransform({ k: 3, x: 2, y: 1 });
    backend.render();
    const svg = el.querySelector("svg")!;
    expect(svg).toBeTruthy();
    expect(svg.querySelector("g")!.getAttribute("transform")).toContain("scale(3)");
    expect(svg.querySelectorAll("path").length).toBeGreaterThanOrEqual(1);
    backend.destroy();
  });
});
```

- [ ] **Step 2: Run it, verify it fails.**
`cd packages/svg && corepack pnpm@9.15.9 exec vitest run --config vitest.config.ts svg-backend` → FAIL.

- [ ] **Step 3: Implement** `SvgBackend`:

```ts
import type { Backend, RenderLayer, ViewTransform } from "@d3gl/core";
import { svgFromLayers } from "./serialize.js";

export class SvgBackend implements Backend {
  private layers: RenderLayer[] = [];
  private transform: ViewTransform = { k: 1, x: 0, y: 0 };
  private root: SVGSVGElement;

  constructor(private host: HTMLElement, private width: number, private height: number) {
    this.root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.root.setAttribute("width", String(width));
    this.root.setAttribute("height", String(height));
    host.appendChild(this.root);
  }
  setLayers(layers: RenderLayer[]): void { this.layers = layers; }
  updateLayer(name: string, layer: RenderLayer): void {
    const i = this.layers.findIndex((l) => l.name === name);
    if (i >= 0) this.layers[i] = layer; else this.layers.push(layer);
  }
  setTransform(t: ViewTransform): void { this.transform = t; }
  render(): void {
    // Re-serialize the body into the live root svg (innerHTML of the inner markup).
    const full = svgFromLayers(this.width, this.height, this.layers, this.transform);
    const inner = full.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
    this.root.innerHTML = inner;
  }
  toSVG(): string { return svgFromLayers(this.width, this.height, this.layers, this.transform); }
  toPNG(): string {
    throw new Error("SvgBackend.toPNG: rasterize via a raster backend (canvas/webgl); SVG export is toSVG()");
  }
  destroy(): void { this.root.remove(); this.layers = []; }
}
```

(Setting `root.innerHTML` with SVG-namespaced children works in browsers for SVG content.
If a test shows children land in the wrong namespace, build a `<g>` via
`createElementNS` and assign its `innerHTML` instead, appended to root.) `toPNG` throwing is
intentional — the engine routes PNG through a raster backend; document it.

- [ ] **Step 4: Run tests, verify pass.** Browser test passes; Node `corepack pnpm@9.15.9 test` still green.

- [ ] **Step 5: Commit:** `git commit -m "feat(svg): SvgBackend — live DOM svg renderer with clip + view transform"`

---

### Task 3: CanvasBackend (`@d3gl/canvas`)

**Files:**
- Create: `packages/canvas/src/canvas-backend.ts`
- Modify: `packages/canvas/src/index.ts`, `packages/canvas/package.json` (dep `@d3gl/svg` for `toSVG`, `@d3gl/core`)
- Test: `packages/canvas/src/__tests__/canvas-backend.browser.test.ts`
- Create `packages/canvas/vitest.config.ts` (copy `packages/geo/vitest.config.ts`) per the Test setup note.

Context: `CanvasBackend implements Backend`, immediate-mode replay of `DrawableVector`
subpaths into a 2D context. Clear in identity transform, then draw under
`ctx.setTransform(k,0,0,k,x,y)`. Clip via `ctx.save()` + trace clip layer silhouette +
`ctx.clip()` + draw layer + `ctx.restore()`. `toPNG` = `canvas.toDataURL`. `toSVG`
delegates to `svgFromLayers`.

- [ ] **Step 1: Write the failing browser test**

```ts
// packages/canvas/src/__tests__/canvas-backend.browser.test.ts
import { describe, it, expect } from "vitest";
import { Scene } from "@d3gl/core";
import { CanvasBackend } from "../canvas-backend.js";

function rectLayer(name: string, x: number, y: number, w: number, h: number, color: string, clipTo?: string) {
  const scene = new Scene();
  scene.group(name, (b) => b.drawable("d", (c) => c.rect(x, y, w, h)));
  scene.setFill(name, "d", color);
  return { name, buffers: scene.buffers(name), drawables: scene.drawables(name), clipTo };
}

describe("CanvasBackend", () => {
  it("fills a rect and clips one layer to another (pixel-accurate)", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 100; canvas.height = 100;
    const backend = new CanvasBackend(canvas, 100, 100);
    // clip source: left half. clipped layer: full red, clipped to left half.
    const mask = rectLayer("mask", 0, 0, 50, 100, "rgb(0,0,0)");
    const red = rectLayer("red", 0, 0, 100, 100, "rgb(255,0,0)", "mask");
    backend.setLayers([mask, red]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    backend.render();
    const ctx = canvas.getContext("2d")!;
    const left = ctx.getImageData(25, 50, 1, 1).data;
    const right = ctx.getImageData(75, 50, 1, 1).data;
    expect(left[0]).toBeGreaterThan(200);   // red inside mask
    expect(right[0]).toBeLessThan(40);      // clipped out on the right
  });
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement** `CanvasBackend`:

```ts
import type { Backend, RenderLayer, ViewTransform, DrawableVector } from "@d3gl/core";
import { svgFromLayers } from "@d3gl/svg";

function trace(ctx: CanvasRenderingContext2D, d: DrawableVector): void {
  ctx.beginPath();
  for (const s of d.subpaths) {
    const p = s.points;
    if (p.length < 2) continue;
    ctx.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
    if (s.closed) ctx.closePath();
  }
}
const css = (c: readonly [number, number, number, number]) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] / 255).toFixed(4)})`;

export class CanvasBackend implements Backend {
  private ctx: CanvasRenderingContext2D;
  private layers: RenderLayer[] = [];
  private transform: ViewTransform = { k: 1, x: 0, y: 0 };

  constructor(private canvas: HTMLCanvasElement, private width: number, private height: number) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("CanvasBackend: 2D context unavailable");
    this.ctx = ctx;
  }
  setLayers(layers: RenderLayer[]): void { this.layers = layers; }
  updateLayer(name: string, layer: RenderLayer): void {
    const i = this.layers.findIndex((l) => l.name === name);
    if (i >= 0) this.layers[i] = layer; else this.layers.push(layer);
  }
  setTransform(t: ViewTransform): void { this.transform = t; }
  render(): void {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const t = this.transform;
    ctx.setTransform(t.k, 0, 0, t.k, t.x, t.y);
    for (const layer of this.layers) {
      const clipSrc = layer.clipTo ? this.layers.find((l) => l.name === layer.clipTo) : undefined;
      if (clipSrc) {
        ctx.save();
        ctx.beginPath();
        for (const d of clipSrc.drawables) if ((d.flags & 1) !== 0) {
          for (const s of d.subpaths) {
            const p = s.points; if (p.length < 2) continue;
            ctx.moveTo(p[0]!, p[1]!);
            for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
            if (s.closed) ctx.closePath();
          }
        }
        ctx.clip();
      }
      for (const d of layer.drawables) {
        if ((d.flags & 1) === 0) continue;
        trace(ctx, d);
        if (d.fill[3] > 0) { ctx.fillStyle = css(d.fill); ctx.fill(); }
        if (d.stroke[3] > 0 && d.lineWidth > 0) { ctx.strokeStyle = css(d.stroke); ctx.lineWidth = d.lineWidth; ctx.stroke(); }
      }
      if (clipSrc) ctx.restore();
    }
  }
  toPNG(): string { this.render(); return this.canvas.toDataURL("image/png"); }
  toSVG(): string { return svgFromLayers(this.width, this.height, this.layers, this.transform); }
  destroy(): void { this.layers = []; }
}
```

Note: the clip-path accumulation uses one `beginPath`+`clip` for all silhouette subpaths;
`fill()` implicitly closes subpaths so the mask is the union of the clip layer's fills.

- [ ] **Step 4: Run tests, verify pass.**

- [ ] **Step 5: Commit:** `git commit -m "feat(canvas): CanvasBackend — immediate-mode renderer with ctx.clip + view transform"`

---

### Task 4: GroupRenderer stencil modes + WebGLBackend (`@d3gl/webgl`)

**Files:**
- Modify: `packages/webgl/src/renderer.ts` (add `setStencil`)
- Create: `packages/webgl/src/webgl-backend.ts`
- Modify: `packages/webgl/src/index.ts`, `packages/webgl/package.json` (dep `@d3gl/svg`)
- Test: `packages/webgl/src/webgl-backend.browser.test.ts`

Context: `WebGLBackend implements Backend`, one `GroupRenderer` per layer (reusing the
shipped renderer). Clipping uses the spike-proven stencil recipe. luma quirks (from the
spike): hardcoded stencil ref 0, all-three-ops-or-none, `compare:"always"` disables the
test, clear writes only masked bits ⇒ confine to bit 0. The onscreen framebuffer is
obtained with a stencil via `device.getDefaultCanvasContext().getCurrentFramebuffer({
depthStencilFormat: "depth24plus-stencil8" })`. An offscreen stencil framebuffer is used
for `toPNG`.

GroupRenderer addition (`renderer.ts`) — a method to switch stencil mode on its fill/stroke
fillModels via `model.setParameters` (confirmed to exist in luma v9.3):

```ts
private static STENCIL = {
  off:   { depthCompare: "always", depthWriteEnabled: false, stencilCompare: "always" },
  write: { depthCompare: "always", depthWriteEnabled: false, stencilCompare: "equal", stencilReadMask: 0x01, stencilWriteMask: 0x01, stencilPassOperation: "increment-clamp", stencilFailOperation: "keep", stencilDepthFailOperation: "keep" },
  test:  { depthCompare: "always", depthWriteEnabled: false, stencilCompare: "not-equal", stencilReadMask: 0x01, stencilWriteMask: 0x01, stencilPassOperation: "keep", stencilFailOperation: "keep", stencilDepthFailOperation: "keep" },
} as const;

/** Switch stencil state for clipping. "write" = clip source (mask), "test" = clipped layer, "off" = normal. */
setStencil(mode: "off" | "write" | "test"): void {
  const params = GroupRenderer.STENCIL[mode] as Record<string, unknown>;
  if (this.fill) this.fill.fillModel.setParameters(params);
  if (this.stroke) this.stroke.fillModel.setParameters(params);
}
```

WebGLBackend (`webgl-backend.ts`): mirror `MapController` (which it can wrap or duplicate).
`create(canvas, {width,height})` builds the device exactly like `MapController.create`
plus an offscreen framebuffer **with** `depthStencilAttachment: "depth24plus-stencil8"`.

```ts
render(): void {
  const cc = this.device.getDefaultCanvasContext();
  const fb = cc.getCurrentFramebuffer({ depthStencilFormat: "depth24plus-stencil8" });
  this.drawInto(fb);
}
private drawInto(framebuffer: Framebuffer): void {
  const clipSources = new Set<string>();
  for (const l of this.order) { const ct = this.layers.get(l)?.clipTo; if (ct) clipSources.add(ct); }
  const pass = this.device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0], clearStencil: 0 });
  for (const name of this.order) {
    const r = this.renderers.get(name)!;
    const layer = this.layers.get(name)!;
    r.setStencil(clipSources.has(name) ? "write" : layer.clipTo ? "test" : "off");
    r.render(pass);
  }
  pass.end();
  this.device.submit();
}
toPNG(): string { this.drawInto(this.offscreen); return toPNG(this.device, this.offscreen, this.width, this.height); }
toSVG(): string { return svgFromLayers(this.width, this.height, this.order.map((n) => this.layers.get(n)!), this.viewTransform); }
```

Store both the `clipFromView` matrix (for renderers) and the raw `ViewTransform`
(`this.viewTransform`, for `toSVG`). `setLayers` destroys old renderers, builds one
`GroupRenderer` per layer, records `this.order`, applies the current transform.
`updateLayer` calls `renderer.updateColors(layer.buffers)`. `destroy` destroys all
renderers + offscreen + device.

- [ ] **Step 1: Write the failing browser test** — clip a full-screen layer to a left-half mask layer and assert left red / right transparent.

```ts
// packages/webgl/src/webgl-backend.browser.test.ts
import { describe, it, expect } from "vitest";
import { Scene } from "@d3gl/core";
import { WebGLBackend } from "./webgl-backend.js";

function rectLayer(name: string, x: number, y: number, w: number, h: number, color: string, clipTo?: string) {
  const scene = new Scene();
  scene.group(name, (b) => b.drawable("d", (c) => c.rect(x, y, w, h)));
  scene.setFill(name, "d", color);
  return { name, buffers: scene.buffers(name), drawables: scene.drawables(name), clipTo };
}

describe("WebGLBackend", () => {
  it("clips a layer to a mask layer via the stencil buffer", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: 64, height: 64 });
    const mask = rectLayer("mask", 0, 0, 32, 64, "rgb(0,0,0)");
    const red = rectLayer("red", 0, 0, 64, 64, "rgb(255,0,0)", "mask");
    backend.setLayers([mask, red]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    const png = backend.toPNG(); // renders into the offscreen stencil framebuffer
    expect(png.startsWith("data:image/png")).toBe(true);
    // Pixel check via the offscreen readback helper exposed for tests:
    const left = backend.readPixel(16, 32);
    const right = backend.readPixel(48, 32);
    expect(left[0]).toBeGreaterThan(200);
    expect(right[3]).toBeLessThan(40); // clipped out -> transparent
    backend.destroy();
  });
});
```

Add a `readPixel(x, y)` method to `WebGLBackend` (same as `MapController.readPixel`, reading
from `this.offscreen` after `drawInto(this.offscreen)`), used by the test. The mask layer
also paints color where it draws — that's fine here (it's black on the left and the red
layer overdraws it). Coordinate origin for `readPixel` matches `MapController` (flip y).

- [ ] **Step 2: Run it, verify it fails.** `cd packages/webgl && corepack pnpm@9.15.9 exec vitest run --config vitest.config.ts webgl-backend` → FAIL.

- [ ] **Step 3: Implement** `setStencil` + `WebGLBackend` as above. Reuse `clipFromView`,
`toPNG`, `GroupRenderer` from the package. The offscreen framebuffer is created with
`depthStencilAttachment: "depth24plus-stencil8"` so `toPNG`/`readPixel` get stencil too.

- [ ] **Step 4: Run tests, verify pass.** Also run the existing webgl browser suite
(`corepack pnpm@9.15.9 test`) — `GroupRenderer.render` default behavior must be unchanged
when `setStencil` is never called (models keep their default parameters until `setStencil`
is first invoked, so existing tests stay green).

- [ ] **Step 5: Commit:** `git commit -m "feat(webgl): WebGLBackend with stencil clipping; GroupRenderer.setStencil modes"`

---

## Self-review notes
- Spec coverage: SVG serializer (Task 1) backs every `toSVG`; SvgBackend (2), CanvasBackend
  (3), WebGLBackend+stencil (4). Clip-to-layer implemented per backend with the mechanism
  the spec names (`clipPath` / `ctx.clip` / stencil).
- Type consistency: all backends `implements Backend`; all consume `RenderLayer`/
  `ViewTransform`/`DrawableVector` from Plan 1. `svgFromLayers(width,height,layers,t)`
  signature identical across Tasks 1/2/3/4.
- WebGL stencil parameters are copied verbatim from the proven spike; the clip source layer
  is assumed to render before its dependents (engine guarantees order) and to tessellate
  without overlapping triangles (true for geoPath fills).
- Known limitation to note in code: a single stencil bit ⇒ one active clip mask per pass
  (sufficient for the example: cells clip to land). Multiple distinct masks per frame is
  future work.
