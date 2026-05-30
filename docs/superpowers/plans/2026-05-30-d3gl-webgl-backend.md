# d3gl WebGL Backend Implementation Plan (Plan 3 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a `@d3gl/core` `Scene` group on the GPU via luma.gl v9 (WebGL2): upload the packed buffers, look up each drawable's color from a palette texture indexed by `drawableId` in the vertex shader, apply a `mat3` view transform for pan/zoom, and make recolor + show/hide a texture update (no geometry re-upload) — the performance thesis, proven on the GPU with real pixel-readback tests.

**Architecture:** `@d3gl/webgl` adds: `transform.ts` (pure: pan/zoom → clip-space `mat3`), `palette.ts` (pure: color/flag texture layout + pick-id codec), `shaders.ts` (GLSL 300 es), and `GroupRenderer` (`renderer.ts`) which consumes a core `GroupBuffers`. Per-drawable color is a **palette texture** sampled by `drawableId` via `texelFetch`/`textureSize` in the vertex shader; a parallel R8 **flags texture** culls hidden drawables. Recolor = `texture.writeData`. The same vertex shader feeds a fill fragment shader (outputs color) and a pick fragment shader (outputs the `drawableId` encoded as RGB) for GPU hit-testing.

**Tech Stack (versions confirmed by spike):** `@luma.gl/core`/`engine`/`webgl` 9.3.3; Vitest 4.1.7 **browser mode** via `@vitest/browser-playwright` + Playwright Chromium (headless, no special flags on macOS). `transform.ts`/`palette.ts` are Node-tested; the renderer is tested in-browser with real WebGL2 + pixel readback.

**Verified API cheat-sheet (use exactly this — confirmed by spike):**
- Device (browser test): `await luma.createDevice({ adapters:[webgl2Adapter], type:"webgl", createCanvasContext:{ canvas, useDevicePixels:false } })`.
- Readback test target: render to an EXPLICIT `device.createFramebuffer({ width, height, colorAttachments:["rgba8unorm"] })` (the default canvas framebuffer cannot be read). After `pass.end()` call `device.submit()`, then `device.readPixelsToArrayWebGL(framebuffer, { sourceX, sourceY })` → `Uint8Array` `[R,G,B,A,…]`. Readback origin is bottom-left (WebGL convention).
- Index buffer: `device.createBuffer({ data: Uint32Array, usage: Buffer.INDEX, indexType:"uint32" })` (`Buffer` from `@luma.gl/core`); pass as `indexBuffer` in `ModelProps`; index count drives the draw.
- Uniform mat3: `uniforms:{ u_transform: Float32Array(9) }` (column-major, no transpose); update with `model.setUniforms({ u_transform })`.
- Texture: `device.createTexture({ data:Uint8Array, width, height, format:"rgba8unorm"|"r8unorm", mipmaps:false, sampler:{ minFilter:"nearest", magFilter:"nearest" } })`; bind via `bindings:{ name: texture }`; declare `uniform highp sampler2D name;`; `texelFetch`/`textureSize` work in the vertex shader.
- Texture update: `texture.writeData(Uint8Array, { x:0, y:0, width, height })`.

**Scope boundary:** No project-once/d3-geo/d3-zoom wiring, quadtree tooltips, or globe (Plan 4); no SVG backend (Plan 4); no labels/React/bioregions example/perf CI gate (Plan 5). Deferred with documented reasons: SDF stroke anti-aliasing (needs a per-vertex distance attribute `expandStroke` does not yet emit), MSAA, alpha blending of overlapping geometry (tests use opaque colors), and interleaved single-buffer attributes (the renderer de-interleaves the stride-3 vertices into separate position/id buffers to stay on the spike-verified single-attribute buffer layout).

---

## File Structure

```
packages/webgl/
├─ package.json                 # add @d3gl/core dep (Task 3)
└─ src/
   ├─ transform.ts              # clipFromView: pan/zoom -> clip-space mat3      (Task 1)
   ├─ palette.ts                # texture layout + pick-id codec                 (Task 2)
   ├─ shaders.ts                # FILL_VS / FILL_FS / PICK_FS                     (Task 3)
   ├─ renderer.ts               # GroupRenderer                                  (Tasks 3-6)
   ├─ index.ts                  # public exports                                 (Tasks 1-6)
   ├─ smoke.browser.test.ts     # (already present — toolchain sanity)
   └─ __tests__/
      ├─ transform.test.ts                                                       (Task 1)
      └─ palette.test.ts                                                         (Task 2)
   └─ renderer.browser.test.ts  # browser pixel tests                            (Tasks 3-6)
```

**Tooling note for every task:** bare `pnpm` is broken — use `corepack pnpm@9`. Node unit suites run from the repo root: `corepack pnpm@9 test` (the root config excludes `*.browser.test.ts`). The browser suite runs only via the package config: `corepack pnpm@9 --filter @d3gl/webgl exec vitest run --config vitest.config.ts`. Commit with `git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "..."` — never add co-author or "claude" attribution.

---

## Task 1: View transform (pan/zoom → clip-space mat3)

**Files:**
- Create: `packages/webgl/src/transform.ts`
- Create: `packages/webgl/src/index.ts`
- Test: `packages/webgl/src/__tests__/transform.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/webgl/src/__tests__/transform.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { clipFromView } from "../transform.js";

/** Apply a column-major mat3 to a 2D point. */
function apply(m: Float32Array, x: number, y: number): [number, number] {
  const cx = m[0]! * x + m[3]! * y + m[6]!;
  const cy = m[1]! * x + m[4]! * y + m[7]!;
  return [cx, cy];
}

describe("clipFromView", () => {
  it("maps the pixel rectangle to clip space at identity zoom", () => {
    const m = clipFromView({ k: 1, x: 0, y: 0 }, 100, 100);
    expect(apply(m, 0, 0)).toEqual([-1, 1]); // top-left pixel -> top-left clip
    expect(apply(m, 100, 100)).toEqual([1, -1]); // bottom-right pixel -> bottom-right clip
    const [cx, cy] = apply(m, 50, 50);
    expect(cx).toBeCloseTo(0, 6);
    expect(cy).toBeCloseTo(0, 6);
  });

  it("applies zoom scale k about the pixel origin", () => {
    const m = clipFromView({ k: 2, x: 0, y: 0 }, 100, 100);
    // pixel (50,50) at k=2 maps like pixel (100,100) did at k=1
    expect(apply(m, 50, 50)).toEqual([1, -1]);
  });

  it("applies pan translation in pixels", () => {
    const m = clipFromView({ k: 1, x: 50, y: 0 }, 100, 100);
    // pixel (0,0) shifted right by 50px -> clip x 0
    const [cx] = apply(m, 0, 0);
    expect(cx).toBeCloseTo(0, 6);
  });

  it("is column-major with translation in the third column", () => {
    const m = clipFromView({ k: 1, x: 0, y: 0 }, 200, 100);
    expect(m.length).toBe(9);
    expect(m[2]).toBe(0);
    expect(m[5]).toBe(0);
    expect(m[8]).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm@9 test -- transform`
Expected: FAIL — cannot resolve `../transform.js`.

- [ ] **Step 3: Implement the transform**

Create `packages/webgl/src/transform.ts`:

```ts
/** A d3-zoom-style transform: uniform scale `k` then pixel translation (x, y). */
export interface ViewTransform {
  k: number;
  x: number;
  y: number;
}

/**
 * Build a column-major 3x3 matrix mapping *reference pixel* coordinates
 * (origin top-left, y down, the space d3 projections / geoPath produce) through a
 * d3-zoom transform and into WebGL clip space [-1, 1] (origin center, y up).
 *
 * Pixel -> zoomed pixel:   px' = k*px + x,  py' = k*py + y
 * Zoomed pixel -> clip:    cx  = px'/W*2 - 1,  cy = 1 - py'/H*2   (y flipped)
 *
 * Composed (cx,cy,1) = M (px,py,1), so pan/zoom is a single uniform update and
 * the GPU never re-projects geometry.
 */
export function clipFromView(t: ViewTransform, width: number, height: number): Float32Array {
  const sx = (2 * t.k) / width;
  const sy = (-2 * t.k) / height;
  const tx = (2 * t.x) / width - 1;
  const ty = 1 - (2 * t.y) / height;
  // column-major: [col0, col1, col2]
  return new Float32Array([sx, 0, 0, 0, sy, 0, tx, ty, 1]);
}
```

- [ ] **Step 4: Create the public index**

Create `packages/webgl/src/index.ts`:

```ts
export { clipFromView } from "./transform.js";
export type { ViewTransform } from "./transform.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `corepack pnpm@9 test -- transform`
Expected: PASS — all transform tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/webgl/src/transform.ts packages/webgl/src/index.ts packages/webgl/src/__tests__/transform.test.ts
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(webgl): add pan/zoom to clip-space view transform"
```

---

## Task 2: Palette texture layout + pick-id codec

**Files:**
- Create: `packages/webgl/src/palette.ts`
- Modify: `packages/webgl/src/index.ts`
- Test: `packages/webgl/src/__tests__/palette.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/webgl/src/__tests__/palette.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  paletteDimensions,
  padPalette,
  padFlags,
  encodePickColor,
  decodePickColor,
} from "../palette.js";

describe("paletteDimensions", () => {
  it("is a single row up to the max width", () => {
    expect(paletteDimensions(10)).toEqual({ width: 10, height: 1 });
  });
  it("wraps into multiple rows beyond max width", () => {
    expect(paletteDimensions(300)).toEqual({ width: 256, height: 2 });
  });
  it("never returns a zero dimension", () => {
    expect(paletteDimensions(0)).toEqual({ width: 1, height: 1 });
  });
});

describe("padPalette", () => {
  it("lays RGBA colors into a width*height*4 buffer, zero-padded", () => {
    const colors = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); // 2 drawables
    const out = padPalette(colors, { width: 4, height: 1 });
    expect(out.length).toBe(4 * 1 * 4);
    expect(Array.from(out.slice(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(out.slice(8))).toEqual(new Array(8).fill(0));
  });
});

describe("padFlags", () => {
  it("lays 1-byte flags into a width*height buffer", () => {
    const flags = new Uint8Array([1, 0]);
    const out = padFlags(flags, { width: 4, height: 1 });
    expect(out.length).toBe(4);
    expect(Array.from(out)).toEqual([1, 0, 0, 0]);
  });
});

describe("pick id codec", () => {
  it("round-trips a drawableId through RGB bytes", () => {
    for (const id of [0, 1, 255, 256, 70000]) {
      const [r, g, b] = encodePickColor(id);
      expect(decodePickColor(r, g, b)).toBe(id);
    }
  });
  it("reserves black (0,0,0) for 'no drawable' (-1)", () => {
    expect(decodePickColor(0, 0, 0)).toBe(-1);
    // id 0 must therefore NOT encode to black
    expect(encodePickColor(0)).toEqual([1, 0, 0]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm@9 test -- palette`
Expected: FAIL — cannot resolve `../palette.js`.

- [ ] **Step 3: Implement palette helpers**

Create `packages/webgl/src/palette.ts`:

```ts
export interface PaletteDimensions {
  width: number;
  height: number;
}

/**
 * Texel dimensions for a per-drawable side-table of `count` entries. A single row
 * up to `maxWidth`, then wrapping into rows. drawableId -> texel is therefore
 * (id % width, floor(id / width)); the shader recovers `width` via textureSize().
 */
export function paletteDimensions(count: number, maxWidth = 256): PaletteDimensions {
  if (count <= 0) return { width: 1, height: 1 };
  const width = Math.min(count, maxWidth);
  const height = Math.ceil(count / width);
  return { width, height };
}

/** RGBA colors (4 bytes/drawable) laid into a width*height*4 buffer, zero-padded. */
export function padPalette(colors: Uint8Array, dims: PaletteDimensions): Uint8Array {
  const data = new Uint8Array(dims.width * dims.height * 4);
  data.set(colors.subarray(0, data.length));
  return data;
}

/** Flags (1 byte/drawable) laid into a width*height buffer, zero-padded. */
export function padFlags(flags: Uint8Array, dims: PaletteDimensions): Uint8Array {
  const data = new Uint8Array(dims.width * dims.height);
  data.set(flags.subarray(0, data.length));
  return data;
}

/**
 * Encode a drawableId into RGB bytes for GPU color-picking. Offset by +1 so that
 * a cleared (black) pick buffer decodes to -1 ("no drawable").
 */
export function encodePickColor(drawableId: number): [number, number, number] {
  const v = drawableId + 1;
  return [v & 255, (v >> 8) & 255, (v >> 16) & 255];
}

/** Decode RGB pick bytes back to a drawableId (-1 for the cleared background). */
export function decodePickColor(r: number, g: number, b: number): number {
  return (r | (g << 8) | (b << 16)) - 1;
}
```

- [ ] **Step 4: Re-export from index.ts**

Replace `packages/webgl/src/index.ts` with:

```ts
export { clipFromView } from "./transform.js";
export type { ViewTransform } from "./transform.js";
export {
  paletteDimensions,
  padPalette,
  padFlags,
  encodePickColor,
  decodePickColor,
} from "./palette.js";
export type { PaletteDimensions } from "./palette.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `corepack pnpm@9 test -- palette`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/webgl/src/palette.ts packages/webgl/src/index.ts packages/webgl/src/__tests__/palette.test.ts
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(webgl): add palette texture layout and pick-id codec"
```

---

## Task 3: GroupRenderer — fill rendering with palette-texture color lookup

**Files:**
- Modify: `packages/webgl/package.json` (add `@d3gl/core`)
- Create: `packages/webgl/src/shaders.ts`
- Create: `packages/webgl/src/renderer.ts`
- Modify: `packages/webgl/src/index.ts`
- Test: `packages/webgl/src/renderer.browser.test.ts`

- [ ] **Step 1: Add the core dependency**

Edit `packages/webgl/package.json` to add `"@d3gl/core": "workspace:*"` to `dependencies` (alongside the `@luma.gl/*` deps). Then:

Run: `corepack pnpm@9 install`
Expected: links `@d3gl/core` into `@d3gl/webgl`.

- [ ] **Step 2: Create the shaders**

Create `packages/webgl/src/shaders.ts`:

```ts
/**
 * GLSL 300 es shaders. The vertex shader applies the view transform and looks up
 * the per-drawable color from a palette texture indexed by drawableId via
 * texelFetch + textureSize (recolor = texture update, no geometry change). A
 * parallel R8 flags texture culls hidden drawables (visible flag in bit 0).
 */
export const FILL_VS = `#version 300 es
precision highp float;
uniform mat3 u_transform;
uniform highp sampler2D u_colorTable;
uniform highp sampler2D u_flags;
in vec2 a_position;
in float a_drawableId;
out vec4 v_color;
flat out float v_id;
void main() {
  int id = int(a_drawableId + 0.5);
  v_id = a_drawableId;
  ivec2 cs = textureSize(u_colorTable, 0);
  v_color = texelFetch(u_colorTable, ivec2(id % cs.x, id / cs.x), 0);
  ivec2 fsz = textureSize(u_flags, 0);
  float vis = texelFetch(u_flags, ivec2(id % fsz.x, id / fsz.x), 0).r;
  if (vis <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside clip space -> culled
    return;
  }
  vec3 p = u_transform * vec3(a_position, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

export const FILL_FS = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }`;

export const PICK_FS = `#version 300 es
precision highp float;
flat in float v_id;
out vec4 fragColor;
void main() {
  int id = int(v_id + 0.5) + 1; // +1 so background (0,0,0) decodes to -1
  fragColor = vec4(
    float(id & 255) / 255.0,
    float((id >> 8) & 255) / 255.0,
    float((id >> 16) & 255) / 255.0,
    1.0);
}`;
```

- [ ] **Step 3: Write the failing browser test**

Create `packages/webgl/src/renderer.browser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Scene } from "@d3gl/core";
import { GroupRenderer } from "./renderer.js";
import { clipFromView } from "./transform.js";

const W = 64;
const H = 64;

async function setup() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  const device = await luma.createDevice({
    adapters: [webgl2Adapter],
    type: "webgl",
    createCanvasContext: { canvas, useDevicePixels: false },
  });
  const framebuffer = device.createFramebuffer({
    width: W,
    height: H,
    colorAttachments: ["rgba8unorm"],
  });
  return { device, framebuffer, canvas };
}

/** Read the RGBA byte tuple at a framebuffer pixel (origin bottom-left). */
function pixel(device: any, framebuffer: any, x: number, y: number): number[] {
  const p = device.readPixelsToArrayWebGL(framebuffer, { sourceX: x, sourceY: y });
  return [p[0], p[1], p[2], p[3]];
}

/** Two rectangles: cell "a" left half, cell "b" right half of the WxH pixel space. */
function twoHalves() {
  const scene = new Scene();
  scene.group("cells", (g) => {
    g.drawable("a", (ctx) => ctx.rect(0, 0, W / 2, H));
    g.drawable("b", (ctx) => ctx.rect(W / 2, 0, W / 2, H));
  });
  return scene;
}

describe("GroupRenderer fill", () => {
  it("renders each drawable in its palette-table color", async () => {
    const { device, framebuffer } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000"); // red
    scene.setFill("cells", "b", "#0000ff"); // blue

    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
    renderer.render(pass);
    pass.end();
    device.submit();

    const left = pixel(device, framebuffer, 16, 32);
    const right = pixel(device, framebuffer, 48, 32);
    expect(left[0]).toBeGreaterThan(200); // red
    expect(left[2]).toBeLessThan(40);
    expect(right[2]).toBeGreaterThan(200); // blue
    expect(right[0]).toBeLessThan(40);

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `corepack pnpm@9 --filter @d3gl/webgl exec vitest run --config vitest.config.ts`
Expected: FAIL — cannot resolve `./renderer.js`.

- [ ] **Step 5: Implement GroupRenderer (fill pass)**

Create `packages/webgl/src/renderer.ts`:

```ts
import { Buffer } from "@luma.gl/core";
import type { Device, Texture, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { GroupBuffers } from "@d3gl/core";
import { paletteDimensions, padPalette, padFlags } from "./palette.js";
import { FILL_VS, FILL_FS, PICK_FS } from "./shaders.js";

const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** GPU resources for one geometry pass (fill or stroke). */
interface Pass {
  positionBuffer: Buffer;
  idBuffer: Buffer;
  indexBuffer: Buffer;
  colorTexture: Texture;
  flagsTexture: Texture;
  fillModel: Model;
  pickModel: Model;
}

/**
 * Renders one Scene group on the GPU. Geometry is uploaded once; pan/zoom is a
 * transform-uniform update and recolor/visibility is a palette/flags texture
 * update — neither touches the geometry buffers.
 */
export class GroupRenderer {
  private transform = identity();
  private fill: Pass | null;
  private stroke: Pass | null;

  constructor(private readonly device: Device, buffers: GroupBuffers) {
    this.fill = this.buildPass(
      buffers.fillVertices,
      buffers.fillIndices,
      buffers.fillColors,
      buffers.flags,
    );
    this.stroke = this.buildPass(
      buffers.strokeVertices,
      buffers.strokeIndices,
      buffers.strokeColors,
      buffers.flags,
    );
  }

  private buildPass(
    verts: Float32Array,
    indices: Uint32Array,
    colors: Uint8Array,
    flags: Uint8Array,
  ): Pass | null {
    if (indices.length === 0) return null;
    const device = this.device;

    // De-interleave the stride-3 [x, y, drawableId] vertices into separate
    // position and id buffers (keeps us on the spike-verified buffer layout).
    const n = verts.length / 3;
    const pos = new Float32Array(n * 2);
    const ids = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[2 * i] = verts[3 * i]!;
      pos[2 * i + 1] = verts[3 * i + 1]!;
      ids[i] = verts[3 * i + 2]!;
    }
    const positionBuffer = device.createBuffer({ data: pos });
    const idBuffer = device.createBuffer({ data: ids });
    const indexBuffer = device.createBuffer({
      data: indices,
      usage: Buffer.INDEX,
      indexType: "uint32",
    });

    const count = colors.length / 4;
    const dims = paletteDimensions(count);
    const colorTexture = device.createTexture({
      data: padPalette(colors, dims),
      width: dims.width,
      height: dims.height,
      format: "rgba8unorm",
      mipmaps: false,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });
    const flagsTexture = device.createTexture({
      data: padFlags(flags, dims),
      width: dims.width,
      height: dims.height,
      format: "r8unorm",
      mipmaps: false,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });

    const bufferLayout = [
      { name: "a_position", format: "float32x2" as const },
      { name: "a_drawableId", format: "float32" as const },
    ];
    const attributes = { a_position: positionBuffer, a_drawableId: idBuffer };
    const bindings = { u_colorTable: colorTexture, u_flags: flagsTexture };
    const common = {
      bufferLayout,
      attributes,
      indexBuffer,
      bindings,
      uniforms: { u_transform: this.transform },
      topology: "triangle-list" as const,
      vertexCount: indices.length,
    };

    const fillModel = new Model(device, { ...common, vs: FILL_VS, fs: FILL_FS });
    const pickModel = new Model(device, { ...common, vs: FILL_VS, fs: PICK_FS });
    return { positionBuffer, idBuffer, indexBuffer, colorTexture, flagsTexture, fillModel, pickModel };
  }

  private passes(): Pass[] {
    return [this.fill, this.stroke].filter((p): p is Pass => p !== null);
  }

  /** Set the view transform (column-major mat3) for pan/zoom. */
  setTransform(m: Float32Array): void {
    this.transform = m;
    for (const pass of this.passes()) {
      pass.fillModel.setUniforms({ u_transform: m });
      pass.pickModel.setUniforms({ u_transform: m });
    }
  }

  /** Draw the fill then stroke passes into an open render pass. */
  render(renderPass: RenderPass): void {
    if (this.fill) this.fill.fillModel.draw(renderPass);
    if (this.stroke) this.stroke.fillModel.draw(renderPass);
  }

  destroy(): void {
    for (const pass of this.passes()) {
      pass.positionBuffer.destroy();
      pass.idBuffer.destroy();
      pass.indexBuffer.destroy();
      pass.colorTexture.destroy();
      pass.flagsTexture.destroy();
      pass.fillModel.destroy();
      pass.pickModel.destroy();
    }
  }
}
```

Note: if `model.setUniforms` is not present on this luma.gl build, set uniforms by re-assigning at draw time via the documented alternative (`model.uniforms = {...}` or `model.shaderInputs`); the spike confirmed `uniforms` in `ModelProps` works, and `setUniforms` is the documented updater — adjust only if the browser run errors, and report the change.

- [ ] **Step 6: Export GroupRenderer**

Append to `packages/webgl/src/index.ts`:

```ts
export { GroupRenderer } from "./renderer.js";
```

- [ ] **Step 7: Run the browser test to verify it passes**

Run: `corepack pnpm@9 --filter @d3gl/webgl exec vitest run --config vitest.config.ts`
Expected: PASS — fill renders red/blue halves. (The smoke suite also runs and stays green.)

- [ ] **Step 8: Typecheck and commit**

Run: `corepack pnpm@9 -r exec tsc --noEmit`
Expected: clean.

```bash
git add packages/webgl/package.json packages/webgl/src/shaders.ts packages/webgl/src/renderer.ts packages/webgl/src/index.ts packages/webgl/src/renderer.browser.test.ts pnpm-lock.yaml
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(webgl): render Scene fill via palette-texture color lookup"
```

---

## Task 4: Recolor + visibility (texture-update hot path)

**Files:**
- Modify: `packages/webgl/src/renderer.ts` (add `updateColors`)
- Test: `packages/webgl/src/renderer.browser.test.ts` (append tests)

- [ ] **Step 1: Write the failing tests**

Append to the `describe("GroupRenderer fill", ...)` block in `packages/webgl/src/renderer.browser.test.ts` (add as new `it` cases; reuse the `setup`, `pixel`, `twoHalves` helpers already in the file):

```ts
  it("recolors via a texture update without recreating geometry", async () => {
    const { device, framebuffer } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const draw = () => {
      const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
      renderer.render(pass);
      pass.end();
      device.submit();
    };
    draw();
    expect(pixel(device, framebuffer, 16, 32)[0]).toBeGreaterThan(200); // a is red

    // Recolor a -> green and push only the color table.
    scene.setFill("cells", "a", "#00ff00");
    renderer.updateColors(scene.buffers("cells"));
    draw();
    const a = pixel(device, framebuffer, 16, 32);
    expect(a[1]).toBeGreaterThan(200); // now green
    expect(a[0]).toBeLessThan(40);

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });

  it("hides a drawable when its visible flag is cleared", async () => {
    const { device, framebuffer } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    scene.setFlag("cells", "a", 0); // hide a
    renderer.updateColors(scene.buffers("cells"));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
    renderer.render(pass);
    pass.end();
    device.submit();

    const a = pixel(device, framebuffer, 16, 32);
    expect(a[0]).toBeLessThan(40); // a's region shows the clear color, not red
    expect(pixel(device, framebuffer, 48, 32)[2]).toBeGreaterThan(200); // b still blue

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm@9 --filter @d3gl/webgl exec vitest run --config vitest.config.ts`
Expected: FAIL — `renderer.updateColors is not a function`.

- [ ] **Step 3: Implement `updateColors`**

In `packages/webgl/src/renderer.ts`, add this method to the `GroupRenderer` class (after `setTransform`):

```ts
  /**
   * Re-upload the color and flag tables from fresh buffers. Touches only the
   * palette/flags textures — geometry buffers are untouched, so this is the cheap
   * recolor / show-hide hot path.
   */
  updateColors(buffers: GroupBuffers): void {
    if (this.fill) this.writeTables(this.fill, buffers.fillColors, buffers.flags);
    if (this.stroke) this.writeTables(this.stroke, buffers.strokeColors, buffers.flags);
  }

  private writeTables(pass: Pass, colors: Uint8Array, flags: Uint8Array): void {
    const dims = paletteDimensions(colors.length / 4);
    pass.colorTexture.writeData(padPalette(colors, dims), {
      x: 0,
      y: 0,
      width: dims.width,
      height: dims.height,
    });
    pass.flagsTexture.writeData(padFlags(flags, dims), {
      x: 0,
      y: 0,
      width: dims.width,
      height: dims.height,
    });
  }
```

Note: if `texture.writeData`'s option object differs on this build (the spike confirmed `{ x, y, width, height }`), adjust to the real signature and report.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm@9 --filter @d3gl/webgl exec vitest run --config vitest.config.ts`
Expected: PASS — recolor and hide both work.

- [ ] **Step 5: Commit**

```bash
git add packages/webgl/src/renderer.ts packages/webgl/src/renderer.browser.test.ts
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(webgl): recolor and show/hide via texture updates (no geometry touch)"
```

---

## Task 5: Stroke pass + transform pan/zoom

**Files:**
- Test: `packages/webgl/src/renderer.browser.test.ts` (append a new describe block)

(The renderer already builds and draws the stroke pass and supports `setTransform` from Task 3; this task proves both with pixel tests. No production changes are expected — if a test reveals a gap, fix `renderer.ts` and note it.)

- [ ] **Step 1: Write the tests**

Append a new top-level describe block to `packages/webgl/src/renderer.browser.test.ts`:

```ts
describe("GroupRenderer stroke + transform", () => {
  it("renders stroke geometry in the stroke color", async () => {
    const { device, framebuffer } = await setup();
    const scene = new Scene();
    // a centered box with a thick border; fill transparent (default), stroke green
    scene.group("cells", (g) => {
      g.drawable("box", (ctx) => ctx.rect(16, 16, 32, 32), { lineWidth: 8 });
    });
    scene.setStroke("cells", "box", "#00ff00");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
    renderer.render(pass);
    pass.end();
    device.submit();

    // a pixel on the top edge of the box (y≈16) should be green stroke
    const edge = pixel(device, framebuffer, 32, H - 16);
    expect(edge[1]).toBeGreaterThan(150);
    // the box center should be clear (fill is transparent default)
    const center = pixel(device, framebuffer, 32, H - 32);
    expect(center[1]).toBeLessThan(80);

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });

  it("moves geometry by changing only the transform uniform", async () => {
    const { device, framebuffer } = await setup();
    const scene = new Scene();
    // a small square in the top-left pixel region [0,16]x[0,16]
    scene.group("cells", (g) => g.drawable("s", (ctx) => ctx.rect(0, 0, 16, 16)));
    scene.setFill("cells", "s", "#ff0000");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));

    const draw = () => {
      const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
      renderer.render(pass);
      pass.end();
      device.submit();
    };

    // Identity: square occupies top-left pixels (readback y is bottom-up).
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
    draw();
    expect(pixel(device, framebuffer, 8, H - 8)[0]).toBeGreaterThan(200); // present top-left
    expect(pixel(device, framebuffer, 40, H - 8)[0]).toBeLessThan(40); // absent to the right

    // Pan right by 32px: square should now be at x≈32..48 (only transform changed).
    renderer.setTransform(clipFromView({ k: 1, x: 32, y: 0 }, W, H));
    draw();
    expect(pixel(device, framebuffer, 8, H - 8)[0]).toBeLessThan(40); // gone from top-left
    expect(pixel(device, framebuffer, 40, H - 8)[0]).toBeGreaterThan(200); // moved right

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `corepack pnpm@9 --filter @d3gl/webgl exec vitest run --config vitest.config.ts`
Expected: PASS. If the stroke test fails because fill defaults are not transparent enough or stroke geometry is offset, inspect with extra pixel reads; the stroke is an 8px-wide band centred on the rect edge, so sample a few pixels around `y=H-16` to locate it, and adjust the asserted coordinate to a pixel that is unambiguously on the band (do not loosen the green threshold below 150). Do not change `renderer.ts` unless a real defect is found.

- [ ] **Step 3: Commit**

```bash
git add packages/webgl/src/renderer.browser.test.ts
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "test(webgl): verify stroke rendering and transform-only pan/zoom"
```

---

## Task 6: GPU color-picking

**Files:**
- Modify: `packages/webgl/src/renderer.ts` (add `renderPick`)
- Test: `packages/webgl/src/renderer.browser.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing tests**

Append a new top-level describe block to `packages/webgl/src/renderer.browser.test.ts` (add `decodePickColor` to the existing top imports: `import { clipFromView } from "./transform.js";` becomes two imports — also `import { decodePickColor } from "./palette.js";`):

```ts
describe("GroupRenderer picking", () => {
  it("encodes drawableId per pixel and decodes back to the right drawable", async () => {
    const { device, framebuffer } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
    renderer.renderPick(pass);
    pass.end();
    device.submit();

    const a = pixel(device, framebuffer, 16, 32);
    const b = pixel(device, framebuffer, 48, 32);
    expect(decodePickColor(a[0], a[1], a[2])).toBe(0); // drawable "a" -> id 0
    expect(decodePickColor(b[0], b[1], b[2])).toBe(1); // drawable "b" -> id 1

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });

  it("decodes the cleared background to -1 (no drawable)", async () => {
    const { device, framebuffer } = await setup();
    const scene = new Scene();
    scene.group("cells", (g) => g.drawable("s", (ctx) => ctx.rect(0, 0, 8, 8)));
    scene.setFill("cells", "s", "#ff0000");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
    renderer.renderPick(pass);
    pass.end();
    device.submit();

    // far corner is empty
    const empty = pixel(device, framebuffer, 60, 4);
    expect(decodePickColor(empty[0], empty[1], empty[2])).toBe(-1);

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm@9 --filter @d3gl/webgl exec vitest run --config vitest.config.ts`
Expected: FAIL — `renderer.renderPick is not a function`.

- [ ] **Step 3: Implement `renderPick`**

In `packages/webgl/src/renderer.ts`, add this method to `GroupRenderer` (after `render`):

```ts
  /**
   * Draw the fill geometry with each drawable's id encoded as an RGB color, for
   * GPU color-picking. Render this into a dedicated offscreen pass, then read the
   * pixel under the cursor and decode it with decodePickColor().
   */
  renderPick(renderPass: RenderPass): void {
    if (this.fill) this.fill.pickModel.draw(renderPass);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm@9 --filter @d3gl/webgl exec vitest run --config vitest.config.ts`
Expected: PASS — picking decodes 0, 1, and -1 correctly.

- [ ] **Step 5: Run the full Node suite + typecheck (no regressions)**

Run: `corepack pnpm@9 test`
Expected: 58 Node tests pass (browser tests excluded from the Node runner).
Run: `corepack pnpm@9 -r exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/webgl/src/renderer.ts packages/webgl/src/renderer.browser.test.ts
git -c user.name="Daniel Edler" -c user.email="daniel.edler@umu.se" commit -m "feat(webgl): add GPU color-picking pass"
```

---

## Self-Review

**Spec coverage (this plan's slice):**
- luma.gl Device/Buffer/Model/Texture from `GroupBuffers` → Task 3. ✓
- Vertex shader applies `mat3` transform uniform → Task 1 (matrix) + Task 3 (shader/uniform) + Task 5 (proven). ✓
- Fragment reads color via `drawableId` (palette texture) + visible flag → Task 3 (color) + Task 4 (flag). ✓
- Recolor = single texture update, geometry untouched → Task 4 (verified by re-render after `updateColors`). ✓
- Transform-only pan/zoom (no reprojection) → Task 5 (square moves via transform alone). ✓
- GPU color-picking → Task 6. ✓
- Browser-mode (Playwright) render + recolor tests → Tasks 3–6 (real WebGL2 pixel readback). ✓

**Deferred (documented in Scope boundary):** SDF stroke AA (needs a distance attribute `expandStroke` does not emit yet), MSAA, alpha blending of overlaps, interleaved attributes; project-once/geo/zoom wiring, quadtree, globe (Plan 4); SVG, labels, React, example, perf CI gate (Plans 4–5).

**Placeholder scan:** No TBD/TODO. The two "if the API differs, adjust and report" notes (Task 3 `setUniforms`, Task 4 `writeData` options) are not placeholders — they are exact spike-verified calls with a documented fallback should this luma.gl patch differ; the code as written is the confirmed form.

**Type/name consistency:** `clipFromView(ViewTransform, width, height) -> Float32Array(9)` (Task 1) used in every browser test. `paletteDimensions`/`padPalette`/`padFlags`/`encodePickColor`/`decodePickColor` (Task 2) used by `renderer.ts` (Tasks 3–6) and `decodePickColor` in Task 6 tests. Shader attribute names `a_position`/`a_drawableId` and uniforms `u_transform`/`u_colorTable`/`u_flags` (Task 3 `shaders.ts`) match the `bufferLayout`/`attributes`/`bindings`/`uniforms` keys in `renderer.ts`. `GroupBuffers` fields (`fillVertices`/`fillIndices`/`fillColors`/`strokeVertices`/`strokeIndices`/`strokeColors`/`flags`) are the Plan 2 core output, consumed unchanged. `GroupRenderer` methods (`setTransform`/`render`/`updateColors`/`renderPick`/`destroy`) are introduced and used consistently across tasks.

---

## Next plans

- **Plan 4 — Geo + export (`@d3gl/svg`, `@d3gl/geo`):** SVG path-string backend; project-once with any d3-geo projection feeding `Scene` reference coordinates; `d3-zoom` → `clipFromView` transform; quadtree hit-testing (CPU) with `renderPick` as the fallback; orthographic globe mode (a); PNG (readback) / SVG export.
- **Plan 5 — Product (`@d3gl/labels`, `@d3gl/react`):** HTML LabelLayer with culling; `<D3GL>`/`<Layer>`/`<Tooltip>`; bioregions map example; performance-budget CI gate (recolor = texture write; pan/zoom = uniform).
