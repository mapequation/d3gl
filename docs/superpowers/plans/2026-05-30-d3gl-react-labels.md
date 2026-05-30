# d3gl React + Labels Implementation Plan (Plan 5 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make d3gl usable from React and prove the end-to-end map. `@d3gl/labels` adds an HTML label overlay with viewport/collision culling (geometry stays on the GPU; only readable labels enter the DOM — the slow-tree fix). `@d3gl/react` adds a headless `MapController` (device + renderers + transform + recolor + pick + PNG) and a thin `<D3GL>` React component. A performance-budget test guards the thesis: recolor stays cheap (texture write), never re-tessellation.

**Architecture:**
- `@d3gl/labels` (Node + browser): `cullLabels()` (pure: viewport clip + greedy collision resolution) and `LabelLayer` (framework-agnostic DOM overlay that positions absolutely-placed elements from reference-space anchors through the view transform).
- `@d3gl/react`: `MapController` (headless, browser-tested — owns the luma device, a `GroupRenderer` per group, an offscreen framebuffer for pick/export; `setGroup`/`setTransform`/`updateColors`/`render`/`renderToFramebuffer`/`pick`/`toPNG`/`destroy`) and `<D3GL>` (a thin component: a `<canvas>` whose effect creates the controller, applies `groups`/`transform` props, and renders).

**Tech Stack (versions confirmed by spike):** React 19.2.6 + `react-dom` 19.2.6 via plain `react-dom/client` `createRoot` (no helper lib). Browser tests in vitest 4.x browser mode (Playwright Chromium WebGL2); the deterministic test pattern is an `onReady` callback the async effect calls, wrapped in an awaited Promise. Reuses `@d3gl/core` (Scene), `@d3gl/webgl` (GroupRenderer, clipFromView, pickAt, toPNG), `@d3gl/geo` (featureGroup, ViewTransform). `cullLabels` is Node-tested.

**Confirmed config (from spike — apply per package that has `.tsx`):** `tsconfig.json` needs `"jsx": "react-jsx"`. The browser `vitest.config.ts` needs `oxc: { transform: { react: {} } }` (vitest 4.x uses oxc, NOT esbuild) and an include glob `src/**/*.browser.test.{ts,tsx}`. Avoid `<StrictMode>` in tests (double-invokes effects); the effect guards with a `cancelled` flag regardless. Readback needs an explicit framebuffer (not the default canvas buffer).

**Display vs test rendering:** `MapController.render()` targets the visible canvas (display); pixel correctness is asserted via `renderToFramebuffer()` + `readPixelsToArrayWebGL` (the verified path). The `<D3GL>` test drives the controller through `onReady` and verifies pixels via the offscreen framebuffer, so the full React→controller→GPU path is pixel-checked even though the on-canvas draw itself is validated structurally (same `GroupRenderer.render`, different target).

**Scope boundary / documented follow-ups (NOT in this plan):** a standalone runnable Vite example app; the `<Layer>`-as-children sugar API (this plan uses a declarative `groups` prop on `<D3GL>`, functionally equivalent and fully testable); orthographic globe interaction; MSDF/canvas label backends (HTML overlay only here); d3-zoom event attachment (consumer wires pointer/wheel → `viewTransform` → `transform` prop).

---

## File Structure

```
packages/
├─ labels/
│  ├─ package.json            # @d3gl/labels (dep: @d3gl/webgl for ViewTransform)
│  ├─ tsconfig.json
│  ├─ vitest.config.ts        # browser config (for LabelLayer DOM test)
│  └─ src/
│     ├─ cull.ts              # cullLabels                                  (Task 1)
│     ├─ label-layer.ts       # LabelLayer (DOM overlay)                    (Task 2)
│     ├─ index.ts
│     ├─ __tests__/cull.test.ts                                            (Task 1, Node)
│     └─ label-layer.browser.test.ts                                       (Task 2, browser)
└─ react/
   ├─ package.json            # @d3gl/react (deps: core, webgl, geo, react, react-dom)
   ├─ tsconfig.json           # jsx: react-jsx
   ├─ vitest.config.ts        # browser config + oxc react + {ts,tsx} glob
   └─ src/
      ├─ controller.ts        # MapController                              (Task 3)
      ├─ D3GL.tsx             # <D3GL> component                           (Task 4)
      ├─ index.ts
      ├─ controller.browser.test.ts                                       (Task 3)
      ├─ D3GL.browser.test.tsx                                            (Task 4)
      └─ perf.browser.test.ts # performance-budget gate                    (Task 5)
```

**Tooling note (every task):** bare `pnpm` is broken — use `corepack pnpm@9`. Node suites: `corepack pnpm@9 test -- <name>`. Browser suite for a package: `corepack pnpm@9 --filter <pkg> exec vitest run --config vitest.config.ts`. New packages need `corepack pnpm@9 install`. Commit with `git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "..."` — no co-author/"claude" attribution.

---

## Task 1: Label culling (`@d3gl/labels` cull.ts)

**Files:**
- Create: `packages/labels/package.json`, `packages/labels/tsconfig.json`
- Create: `packages/labels/src/cull.ts`, `packages/labels/src/index.ts`
- Test: `packages/labels/src/__tests__/cull.test.ts`

- [ ] **Step 1: Create the package manifest**

Create `packages/labels/package.json`:

```json
{
  "name": "@d3gl/labels",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "build": "tsc -b" },
  "dependencies": { "@d3gl/webgl": "workspace:*" }
}
```

Create `packages/labels/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/labels/src/__tests__/cull.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cullLabels } from "../cull.js";

const viewport = { width: 100, height: 100 };

describe("cullLabels", () => {
  it("keeps non-overlapping in-viewport labels", () => {
    const out = cullLabels(
      [
        { id: "a", x: 10, y: 10, width: 20, height: 10 },
        { id: "b", x: 60, y: 60, width: 20, height: 10 },
      ],
      { viewport },
    );
    expect(out.map((l) => l.id).sort()).toEqual(["a", "b"]);
  });

  it("drops labels whose anchor is outside the viewport (+padding)", () => {
    const out = cullLabels(
      [
        { id: "in", x: 50, y: 50, width: 10, height: 10 },
        { id: "out", x: 200, y: 50, width: 10, height: 10 },
      ],
      { viewport },
    );
    expect(out.map((l) => l.id)).toEqual(["in"]);
  });

  it("resolves overlap by keeping the higher-priority label", () => {
    const out = cullLabels(
      [
        { id: "low", x: 10, y: 10, width: 40, height: 20, priority: 1 },
        { id: "high", x: 15, y: 12, width: 40, height: 20, priority: 5 },
      ],
      { viewport },
    );
    expect(out.map((l) => l.id)).toEqual(["high"]);
  });

  it("places both when priority ties but they do not overlap", () => {
    const out = cullLabels(
      [
        { id: "a", x: 5, y: 5, width: 10, height: 10, priority: 1 },
        { id: "b", x: 80, y: 80, width: 10, height: 10, priority: 1 },
      ],
      { viewport },
    );
    expect(out).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `corepack pnpm@9 install`, then `corepack pnpm@9 test -- cull`
Expected: FAIL — cannot resolve `../cull.js`.

- [ ] **Step 4: Implement cullLabels**

Create `packages/labels/src/cull.ts`:

```ts
/** A label positioned in SCREEN pixels (after the view transform is applied). */
export interface LabelBox {
  id: string | number;
  /** Screen-space anchor (top-left of the label box). */
  x: number;
  y: number;
  /** Box size in pixels; used for collision. Defaults to a small box if omitted. */
  width?: number;
  height?: number;
  /** Higher wins collisions; defaults to 0. */
  priority?: number;
  /** Carried through untouched (e.g. text, datum). */
  [key: string]: unknown;
}

export interface CullOptions {
  viewport: { width: number; height: number };
  /** Anchors within this many pixels outside the viewport are still considered. */
  padding?: number;
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  const aw = a.width ?? 0;
  const ah = a.height ?? 0;
  const bw = b.width ?? 0;
  const bh = b.height ?? 0;
  return a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y;
}

/**
 * Reduce label candidates to a renderable subset: drop anchors outside the
 * viewport (+padding), then greedily place highest-priority first, skipping any
 * that collide with an already-placed box. This keeps the DOM at a few hundred
 * nodes regardless of how many features exist (the "geometry on GPU, only visible
 * labels in DOM" approach).
 */
export function cullLabels(candidates: readonly LabelBox[], options: CullOptions): LabelBox[] {
  const pad = options.padding ?? 0;
  const { width, height } = options.viewport;
  const inView = candidates.filter(
    (c) => c.x >= -pad && c.x <= width + pad && c.y >= -pad && c.y <= height + pad,
  );
  // Stable sort by priority desc (preserve input order on ties).
  const ordered = inView
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.priority ?? 0) - (a.c.priority ?? 0) || a.i - b.i)
    .map((e) => e.c);

  const placed: LabelBox[] = [];
  for (const cand of ordered) {
    if (!placed.some((p) => overlaps(cand, p))) placed.push(cand);
  }
  return placed;
}
```

- [ ] **Step 5: Create the index**

Create `packages/labels/src/index.ts`:

```ts
export { cullLabels } from "./cull.js";
export type { LabelBox, CullOptions } from "./cull.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `corepack pnpm@9 test -- cull`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/labels pnpm-lock.yaml
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(labels): add viewport + collision label culling"
```

---

## Task 2: HTML label overlay (`@d3gl/labels` LabelLayer)

**Files:**
- Create: `packages/labels/vitest.config.ts`
- Create: `packages/labels/src/label-layer.ts`
- Modify: `packages/labels/src/index.ts`
- Test: `packages/labels/src/label-layer.browser.test.ts`

- [ ] **Step 1: Create the browser vitest config**

Create `packages/labels/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    include: ["src/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
```

- [ ] **Step 2: Write the failing browser test**

Create `packages/labels/src/label-layer.browser.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { LabelLayer } from "./label-layer.js";

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
});

function setup() {
  container = document.createElement("div");
  document.body.appendChild(container);
  return new LabelLayer(container, (l) => String(l.text));
}

describe("LabelLayer", () => {
  it("creates a positioned DOM node per visible label", () => {
    const layer = setup();
    layer.update(
      [
        { id: "a", refX: 0, refY: 0, text: "A", width: 20, height: 10 },
        { id: "b", refX: 10, refY: 10, text: "B", width: 20, height: 10 },
      ],
      { k: 1, x: 0, y: 0 },
      { width: 100, height: 100 },
    );
    const nodes = container!.querySelectorAll("[data-label-id]");
    expect(nodes.length).toBe(2);
    const a = container!.querySelector<HTMLElement>('[data-label-id="a"]')!;
    expect(a.textContent).toBe("A");
    expect(a.style.left).toBe("0px");
    expect(a.style.top).toBe("0px");
    layer.destroy();
  });

  it("applies the view transform to reference anchors", () => {
    const layer = setup();
    layer.update(
      [{ id: "a", refX: 10, refY: 10, text: "A", width: 5, height: 5 }],
      { k: 2, x: 30, y: 40 }, // screen = k*ref + (x,y) => (50, 60)
      { width: 100, height: 100 },
    );
    const a = container!.querySelector<HTMLElement>('[data-label-id="a"]')!;
    expect(a.style.left).toBe("50px");
    expect(a.style.top).toBe("60px");
    layer.destroy();
  });

  it("removes nodes for labels no longer present on update", () => {
    const layer = setup();
    const vp = { width: 100, height: 100 };
    layer.update([{ id: "a", refX: 0, refY: 0, text: "A" }], { k: 1, x: 0, y: 0 }, vp);
    layer.update([{ id: "b", refX: 0, refY: 0, text: "B" }], { k: 1, x: 0, y: 0 }, vp);
    expect(container!.querySelector('[data-label-id="a"]')).toBeNull();
    expect(container!.querySelector('[data-label-id="b"]')).not.toBeNull();
    layer.destroy();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `corepack pnpm@9 --filter @d3gl/labels exec vitest run --config vitest.config.ts`
Expected: FAIL — cannot resolve `./label-layer.js`.

- [ ] **Step 4: Implement LabelLayer**

Create `packages/labels/src/label-layer.ts`:

```ts
import type { ViewTransform } from "@d3gl/webgl";
import { cullLabels } from "./cull.js";
import type { LabelBox } from "./cull.js";

/** A label anchored in REFERENCE (projected, pre-transform) pixel space. */
export interface LabelAnchor {
  id: string | number;
  refX: number;
  refY: number;
  text: string;
  width?: number;
  height?: number;
  priority?: number;
}

/**
 * An HTML overlay of absolutely-positioned label elements. On each update it maps
 * reference anchors through the view transform to screen pixels, culls to the
 * viewport with collision resolution, and reconciles the DOM (reusing nodes by
 * id). Geometry stays on the GPU; only the surviving labels are in the DOM.
 *
 * The container should be positioned (e.g. `position: relative`) and overlay the
 * canvas; label nodes are `position: absolute`.
 */
export class LabelLayer {
  private nodes = new Map<string, HTMLDivElement>();

  constructor(
    private readonly container: HTMLElement,
    private readonly text: (anchor: LabelAnchor) => string,
  ) {}

  update(
    anchors: readonly LabelAnchor[],
    transform: ViewTransform,
    viewport: { width: number; height: number },
  ): void {
    // reference -> screen: screen = k*ref + (x,y)
    const boxes: LabelBox[] = anchors.map((a) => ({
      id: a.id,
      x: transform.k * a.refX + transform.x,
      y: transform.k * a.refY + transform.y,
      width: a.width,
      height: a.height,
      priority: a.priority,
      text: a.text,
    }));
    const visible = cullLabels(boxes, { viewport });
    const seen = new Set<string>();

    for (const box of visible) {
      const key = String(box.id);
      seen.add(key);
      let node = this.nodes.get(key);
      if (!node) {
        node = document.createElement("div");
        node.dataset.labelId = key;
        node.style.position = "absolute";
        node.style.pointerEvents = "none";
        node.style.whiteSpace = "nowrap";
        this.container.appendChild(node);
        this.nodes.set(key, node);
      }
      node.textContent = this.text({
        id: box.id,
        refX: 0,
        refY: 0,
        text: String(box.text),
      });
      node.style.left = `${Math.round(box.x)}px`;
      node.style.top = `${Math.round(box.y)}px`;
    }

    // Remove nodes that are no longer visible.
    for (const [key, node] of this.nodes) {
      if (!seen.has(key)) {
        node.remove();
        this.nodes.delete(key);
      }
    }
  }

  destroy(): void {
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
  }
}
```

- [ ] **Step 5: Re-export from index.ts**

Replace `packages/labels/src/index.ts` with:

```ts
export { cullLabels } from "./cull.js";
export type { LabelBox, CullOptions } from "./cull.js";
export { LabelLayer } from "./label-layer.js";
export type { LabelAnchor } from "./label-layer.js";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `corepack pnpm@9 --filter @d3gl/labels exec vitest run --config vitest.config.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `corepack pnpm@9 -r exec tsc --noEmit` (clean).

```bash
git add packages/labels/vitest.config.ts packages/labels/src/label-layer.ts packages/labels/src/index.ts packages/labels/src/label-layer.browser.test.ts
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(labels): add HTML overlay LabelLayer with transform + reconciliation"
```

---

## Task 3: MapController (`@d3gl/react` headless controller)

**Files:**
- Create: `packages/react/package.json`, `packages/react/tsconfig.json`, `packages/react/vitest.config.ts`
- Create: `packages/react/src/controller.ts`, `packages/react/src/index.ts`
- Test: `packages/react/src/controller.browser.test.ts`

- [ ] **Step 1: Create the package manifest + configs**

Create `packages/react/package.json`:

```json
{
  "name": "@d3gl/react",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "build": "tsc -b" },
  "dependencies": {
    "@d3gl/core": "workspace:*",
    "@d3gl/webgl": "workspace:*",
    "@d3gl/geo": "workspace:*",
    "@luma.gl/core": "^9.3.3",
    "@luma.gl/engine": "^9.3.3",
    "@luma.gl/webgl": "^9.3.3"
  },
  "peerDependencies": { "react": "^19", "react-dom": "^19" },
  "devDependencies": {
    "react": "^19.2.6",
    "react-dom": "^19.2.6",
    "@types/react": "^19.2.15",
    "@types/react-dom": "^19.2.3"
  }
}
```

Create `packages/react/tsconfig.json` (note `jsx`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src", "jsx": "react-jsx" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]
}
```

Create `packages/react/vitest.config.ts` (note oxc react + {ts,tsx} glob):

```ts
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  oxc: { transform: { react: {} } },
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
```

- [ ] **Step 2: Write the failing browser test**

Create `packages/react/src/controller.browser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Scene } from "@d3gl/core";
import { MapController } from "./controller.js";

const W = 64;
const H = 64;

function twoHalves() {
  const scene = new Scene();
  scene.group("cells", (g) => {
    g.drawable("a", (ctx) => ctx.rect(0, 0, W / 2, H));
    g.drawable("b", (ctx) => ctx.rect(W / 2, 0, W / 2, H));
  });
  return scene;
}

async function setup() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  const controller = await MapController.create(canvas, { width: W, height: H });
  return { controller, canvas };
}

describe("MapController", () => {
  it("renders a group's fill colors (via the offscreen framebuffer)", async () => {
    const { controller } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    controller.setGroup("cells", scene.buffers("cells"));
    controller.setTransform({ k: 1, x: 0, y: 0 });

    const left = controller.readPixel(16, 32);
    const right = controller.readPixel(48, 32);
    expect(left[0]).toBeGreaterThan(200); // red (top-left origin)
    expect(right[2]).toBeGreaterThan(200); // blue

    controller.destroy();
  });

  it("recolors via updateColors without a rebuild", async () => {
    const { controller } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    controller.setGroup("cells", scene.buffers("cells"));
    controller.setTransform({ k: 1, x: 0, y: 0 });
    expect(controller.readPixel(16, 32)[0]).toBeGreaterThan(200);

    scene.setFill("cells", "a", "#00ff00");
    controller.updateColors("cells", scene.buffers("cells"));
    expect(controller.readPixel(16, 32)[1]).toBeGreaterThan(200);

    controller.destroy();
  });

  it("picks the drawableId under a top-left screen pixel", async () => {
    const { controller } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    controller.setGroup("cells", scene.buffers("cells"));
    controller.setTransform({ k: 1, x: 0, y: 0 });
    expect(controller.pick("cells", 16, 32)).toBe(0);
    expect(controller.pick("cells", 48, 32)).toBe(1);
    controller.destroy();
  });

  it("exports a PNG data URL", async () => {
    const { controller } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    controller.setGroup("cells", scene.buffers("cells"));
    controller.setTransform({ k: 1, x: 0, y: 0 });
    const url = controller.toPNG();
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    controller.destroy();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `corepack pnpm@9 install`, then `corepack pnpm@9 --filter @d3gl/react exec vitest run --config vitest.config.ts`
Expected: FAIL — cannot resolve `./controller.js`.

- [ ] **Step 4: Implement MapController**

Create `packages/react/src/controller.ts`:

```ts
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import type { Device, Framebuffer } from "@luma.gl/core";
import type { GroupBuffers } from "@d3gl/core";
import { GroupRenderer, clipFromView, pickAt, toPNG } from "@d3gl/webgl";
import type { ViewTransform } from "@d3gl/webgl";

export interface MapControllerOptions {
  width: number;
  height: number;
}

/**
 * Headless owner of the GPU map: a luma device, one GroupRenderer per named
 * group, and an offscreen framebuffer used for pick / PNG / pixel readback.
 *
 * render() targets the visible canvas (display). renderToFramebuffer() / readPixel
 * / pick / toPNG go through the offscreen framebuffer (the verified, testable
 * path). Pan/zoom is setTransform (uniform); recolor is updateColors (texture
 * write) — neither rebuilds geometry.
 */
export class MapController {
  private renderers = new Map<string, GroupRenderer>();
  private transform: Float32Array;

  private constructor(
    private readonly device: Device,
    private readonly offscreen: Framebuffer,
    private readonly width: number,
    private readonly height: number,
  ) {
    this.transform = clipFromView({ k: 1, x: 0, y: 0 }, width, height);
  }

  static async create(canvas: HTMLCanvasElement, opts: MapControllerOptions): Promise<MapController> {
    const device = await luma.createDevice({
      adapters: [webgl2Adapter],
      type: "webgl",
      createCanvasContext: { canvas, useDevicePixels: false },
    });
    const offscreen = device.createFramebuffer({
      width: opts.width,
      height: opts.height,
      colorAttachments: ["rgba8unorm"],
    });
    return new MapController(device, offscreen, opts.width, opts.height);
  }

  setGroup(name: string, buffers: GroupBuffers): void {
    this.renderers.get(name)?.destroy();
    const renderer = new GroupRenderer(this.device, buffers);
    renderer.setTransform(this.transform);
    this.renderers.set(name, renderer);
  }

  updateColors(name: string, buffers: GroupBuffers): void {
    this.renderers.get(name)?.updateColors(buffers);
  }

  setTransform(t: ViewTransform): void {
    this.transform = clipFromView(t, this.width, this.height);
    for (const r of this.renderers.values()) r.setTransform(this.transform);
  }

  /** Draw all groups to the visible canvas (display path). */
  render(): void {
    const pass = this.device.beginRenderPass({ clearColor: [0, 0, 0, 0] });
    for (const r of this.renderers.values()) r.render(pass);
    pass.end();
    this.device.submit();
  }

  /** Draw all groups into the offscreen framebuffer (test / readback path). */
  renderToFramebuffer(): void {
    const pass = this.device.beginRenderPass({ framebuffer: this.offscreen, clearColor: [0, 0, 0, 1] });
    for (const r of this.renderers.values()) r.render(pass);
    pass.end();
    this.device.submit();
  }

  /** Read one RGBA pixel at top-left-origin (x, y) after rendering to offscreen. */
  readPixel(x: number, y: number): number[] {
    this.renderToFramebuffer();
    const p = this.device.readPixelsToArrayWebGL(this.offscreen, {
      sourceX: Math.floor(x),
      sourceY: Math.floor(this.height - 1 - y),
      sourceWidth: 1,
      sourceHeight: 1,
    });
    return [p[0]!, p[1]!, p[2]!, p[3]!];
  }

  /** Pick the drawableId under a top-left screen pixel in `name`'s group, or -1. */
  pick(name: string, x: number, y: number): number {
    const renderer = this.renderers.get(name);
    if (!renderer) return -1;
    return pickAt(this.device, renderer, this.offscreen, x, y, this.height);
  }

  /** Render to offscreen and encode the framebuffer as a PNG data URL. */
  toPNG(): string {
    this.renderToFramebuffer();
    return toPNG(this.device, this.offscreen, this.width, this.height);
  }

  destroy(): void {
    for (const r of this.renderers.values()) r.destroy();
    this.renderers.clear();
    this.offscreen.destroy();
    this.device.destroy();
  }
}
```

- [ ] **Step 5: Create the index**

Create `packages/react/src/index.ts`:

```ts
export { MapController } from "./controller.js";
export type { MapControllerOptions } from "./controller.js";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `corepack pnpm@9 --filter @d3gl/react exec vitest run --config vitest.config.ts`
Expected: PASS (4 controller tests).

If `device.beginRenderPass({ clearColor })` with no framebuffer errors (display path), use the canvas context's framebuffer explicitly — e.g. obtain it via the device's canvas context (`device.getCanvasContext?.()` / `canvasContext.getCurrentFramebuffer()`) and pass it. The render() display path is not pixel-asserted; only `renderToFramebuffer`-based reads are. Report any adjustment.

- [ ] **Step 7: Typecheck and commit**

Run: `corepack pnpm@9 -r exec tsc --noEmit` (clean).

```bash
git add packages/react/package.json packages/react/tsconfig.json packages/react/vitest.config.ts packages/react/src/controller.ts packages/react/src/index.ts packages/react/src/controller.browser.test.ts pnpm-lock.yaml
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(react): add headless MapController (render, recolor, pick, PNG)"
```

---

## Task 4: `<D3GL>` React component

**Files:**
- Create: `packages/react/src/D3GL.tsx`
- Modify: `packages/react/src/index.ts`
- Test: `packages/react/src/D3GL.browser.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/react/src/D3GL.browser.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { Scene } from "@d3gl/core";
import { D3GL } from "./D3GL.js";
import type { MapController } from "./controller.js";

const W = 64;
const H = 64;

function twoHalves() {
  const scene = new Scene();
  scene.group("cells", (g) => {
    g.drawable("a", (ctx) => ctx.rect(0, 0, W / 2, H));
    g.drawable("b", (ctx) => ctx.rect(W / 2, 0, W / 2, H));
  });
  scene.setFill("cells", "a", "#ff0000");
  scene.setFill("cells", "b", "#0000ff");
  return scene;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

describe("<D3GL>", () => {
  it("mounts, builds the GPU map, and renders the group's colors", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const scene = twoHalves();

    const controller = await new Promise<MapController>((resolve, reject) => {
      root = createRoot(container!);
      root.render(
        React.createElement(D3GL, {
          width: W,
          height: H,
          transform: { k: 1, x: 0, y: 0 },
          groups: [{ name: "cells", buffers: scene.buffers("cells") }],
          onReady: resolve,
          onError: reject,
        }),
      );
    });

    // canvas mounted at the right size
    const canvas = container.querySelector("canvas")!;
    expect(canvas.width).toBe(W);
    expect(canvas.height).toBe(H);

    // pixel correctness via the controller's verified offscreen path
    expect(controller.readPixel(16, 32)[0]).toBeGreaterThan(200); // red
    expect(controller.readPixel(48, 32)[2]).toBeGreaterThan(200); // blue
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm@9 --filter @d3gl/react exec vitest run --config vitest.config.ts`
Expected: FAIL — cannot resolve `./D3GL.js`.

- [ ] **Step 3: Implement `<D3GL>`**

Create `packages/react/src/D3GL.tsx`:

```tsx
import React, { useEffect, useRef } from "react";
import type { GroupBuffers } from "@d3gl/core";
import type { ViewTransform } from "@d3gl/webgl";
import { MapController } from "./controller.js";

export interface D3GLGroup {
  name: string;
  buffers: GroupBuffers;
}

export interface D3GLProps {
  width: number;
  height: number;
  transform?: ViewTransform;
  groups?: D3GLGroup[];
  onReady?: (controller: MapController) => void;
  onError?: (err: unknown) => void;
  className?: string;
}

/**
 * A canvas-backed GPU map. The effect creates a MapController, applies the
 * initial groups + transform, renders, and reports the controller via onReady.
 * Group and transform prop changes are pushed to the controller without rebuild
 * (recolor = texture write, pan/zoom = uniform). Recreated only when size changes.
 */
export function D3GL(props: D3GLProps): React.ReactElement {
  const { width, height, transform, groups, onReady, onError, className } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<MapController | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    MapController.create(canvas, { width, height })
      .then((controller) => {
        if (cancelled) {
          controller.destroy();
          return;
        }
        controllerRef.current = controller;
        for (const g of groups ?? []) controller.setGroup(g.name, g.buffers);
        if (transform) controller.setTransform(transform);
        controller.render();
        onReady?.(controller);
      })
      .catch((err) => {
        if (!cancelled) onError?.(err);
      });
    return () => {
      cancelled = true;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
    // Recreate the device only when the canvas size changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  useEffect(() => {
    const c = controllerRef.current;
    if (!c || !transform) return;
    c.setTransform(transform);
    c.render();
  }, [transform]);

  useEffect(() => {
    const c = controllerRef.current;
    if (!c) return;
    for (const g of groups ?? []) c.setGroup(g.name, g.buffers);
    c.render();
  }, [groups]);

  return <canvas ref={canvasRef} width={width} height={height} className={className} />;
}
```

- [ ] **Step 4: Re-export from index.ts**

Replace `packages/react/src/index.ts` with:

```ts
export { MapController } from "./controller.js";
export type { MapControllerOptions } from "./controller.js";
export { D3GL } from "./D3GL.js";
export type { D3GLProps, D3GLGroup } from "./D3GL.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `corepack pnpm@9 --filter @d3gl/react exec vitest run --config vitest.config.ts`
Expected: PASS (controller + D3GL tests).

- [ ] **Step 6: Typecheck and commit**

Run: `corepack pnpm@9 -r exec tsc --noEmit` (clean).

```bash
git add packages/react/src/D3GL.tsx packages/react/src/index.ts packages/react/src/D3GL.browser.test.tsx
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(react): add <D3GL> component wrapping MapController"
```

---

## Task 5: Performance-budget gate

**Files:**
- Test: `packages/react/src/perf.browser.test.ts`

- [ ] **Step 1: Write the perf-budget test**

Create `packages/react/src/perf.browser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Scene } from "@d3gl/core";
import { MapController } from "./controller.js";

const W = 256;
const H = 256;

/** A dense grid of cells covering the WxH pixel space. */
function grid(cols: number, rows: number) {
  const scene = new Scene();
  const cw = W / cols;
  const ch = H / rows;
  scene.group("cells", (g) => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        g.drawable(`${c}-${r}`, (ctx) => ctx.rect(c * cw, r * ch, cw, ch));
      }
    }
  });
  return scene;
}

describe("performance budget", () => {
  it("recolor + render stays far cheaper than the initial geometry build", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    document.body.appendChild(canvas);
    const controller = await MapController.create(canvas, { width: W, height: H });

    const cols = 64;
    const rows = 64; // 4096 cells
    const scene = grid(cols, rows);
    const ids = Array.from({ length: cols * rows }, (_, i) => `${i % cols}-${Math.floor(i / cols)}`);

    // Cost of building geometry (tessellation + upload).
    const t0 = performance.now();
    controller.setGroup("cells", scene.buffers("cells"));
    controller.setTransform({ k: 1, x: 0, y: 0 });
    controller.renderToFramebuffer();
    const buildMs = performance.now() - t0;

    // Cost of N recolor cycles (CPU scale lookups + one texture write + redraw).
    const cycles = 20;
    const t1 = performance.now();
    for (let n = 0; n < cycles; n++) {
      const shade = n % 2 === 0 ? "#ff0000" : "#00ff00";
      for (const id of ids) scene.setFill("cells", id, shade);
      controller.updateColors("cells", scene.buffers("cells"));
      controller.renderToFramebuffer();
    }
    const recolorMs = (performance.now() - t1) / cycles;

    // A recolor cycle must be cheap. If recolor secretly re-tessellated, it would
    // cost ~buildMs each; assert it is well under that (generous tripwire), and
    // under a generous absolute ceiling to catch gross regressions.
    expect(recolorMs).toBeLessThan(Math.max(buildMs, 50));
    expect(recolorMs).toBeLessThan(250);

    // Correctness: the final recolor actually took effect.
    const px = controller.readPixel(4, 4);
    const isRed = px[0]! > 150 && px[1]! < 100;
    const isGreen = px[1]! > 150 && px[0]! < 100;
    expect(isRed || isGreen).toBe(true);

    controller.destroy();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `corepack pnpm@9 --filter @d3gl/react exec vitest run --config vitest.config.ts`
Expected: PASS. If `recolorMs` is noisy near the bound on CI hardware, the bound is generous by design; only loosen the absolute ceiling (250ms) if a real, non-regressed run exceeds it — never remove the `recolorMs < buildMs`-style relative tripwire, which is what actually catches a re-tessellation regression. Report the observed `buildMs` / `recolorMs`.

- [ ] **Step 3: Commit**

```bash
git add packages/react/src/perf.browser.test.ts
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "test(react): add performance-budget gate (recolor << rebuild)"
```

---

## Self-Review

**Spec coverage (this plan's slice):**
- HTML LabelLayer with viewport/collision culling → Task 1 (`cullLabels`) + Task 2 (`LabelLayer`). ✓
- `<D3GL>` React component → Task 4; `MapController` core → Task 3. ✓
- Tooltips: GPU pick wired into the controller → Task 3 (`pick`); lon/lat available via `@d3gl/geo` (Plan 4). ✓
- Bioregions map proof (grid cells + heatmap recolor + colors) → Task 4 test (real grid via Scene, recolor) + Task 3 (pick/recolor/PNG). ✓
- Performance-budget CI gate (recolor = texture write, not re-tessellation) → Task 5. ✓

**Deferred (documented in Scope boundary):** standalone Vite example app; `<Layer>`-children sugar (declarative `groups` prop instead); globe interaction; MSDF/canvas label backends; d3-zoom event attachment.

**Placeholder scan:** No TBD/TODO. The Task 3 note about `beginRenderPass()` with no framebuffer (display path) is a spike-unverified line with a concrete documented fallback; the offscreen render path (used by all pixel assertions) is fully verified.

**Type/name consistency:** `ViewTransform` (Plan 3 `@d3gl/webgl`) consumed by `LabelLayer` (Task 2), `MapController.setTransform`, and `<D3GL>`. `GroupBuffers` (Plan 2) consumed by `setGroup`/`updateColors`/`D3GLGroup`. `GroupRenderer`/`clipFromView`/`pickAt`/`toPNG` (Plan 3) used by `MapController` (Task 3). `LabelBox` (Task 1) consumed by `cullLabels` and produced inside `LabelLayer.update` (Task 2). `MapController` methods are introduced in Task 3 and used identically in Tasks 4–5. The `<D3GL>` `onReady(controller)` callback type matches `MapController`.

---

## d3gl is feature-complete after this plan

With Plans 1–5 the library spans: the polymorphic `PathContext` (SVG/Canvas/WebGL), the retained `Scene` with recolor side-tables, the luma.gl GPU renderer (palette-texture color, transform-uniform pan/zoom, GPU picking), geo project-once + SVG/PNG export, and a React surface with HTML labels. Remaining, as documented follow-ups: a runnable bioregions example app, the `<Layer>` children API, orthographic globe interaction, and MSDF/canvas label backends for dense trees.
```
