# GPU globe mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make orthographic-globe rotation fast on the WebGL backend by baking the map into an equirectangular texture once and spinning a textured 3D sphere, instead of re-projecting + re-tessellating per frame. Canvas/SVG and non-orthographic projections keep the CPU path. Activation is automatic; no new public API. Also unify `enableZoom` to auto-dispatch rotation for spherical projections.

**Architecture:** `GeoMap.enableZoom(extent)` dispatches on `projection.clipAngle() > 0`: spherical → `enableRotation`, flat → affine d3-zoom. `enableRotation`, when the backend is WebGL **and** the projection is orthographic (numeric probe, cached), drives a new WebGL "globe mode": the backend renders the layers into an offscreen equirectangular framebuffer (the bake) and draws a UV-sphere sampling that texture; versor drag updates a rotation uniform (free), wheel zoom scales the sphere and re-bakes only when it crosses a power-of-2 texture level (debounced). Everything else falls back to the existing CPU re-projection.

**Tech Stack:** TypeScript, luma.gl v9 (`@luma.gl/core` + `@luma.gl/engine`, WebGL2), d3-geo, vitest (node + headless-Chromium browser), Astro Starlight docs.

**Spec:** `docs/superpowers/specs/2026-06-07-gpu-globe-mode-design.md`

---

## File Structure

**Library (`packages/d3gl/`):**
- Modify: `src/map/geo-map.ts` — `enableZoom` auto-dispatch; orthographic detection (cached); GPU globe orchestration (bake geometry via internal equirect projection, drive `setGlobeRotation`, manage texture level + re-bake debounce, `hideOnInteraction` no-op when GPU live).
- Create: `src/geo/orthographic.ts` — `isOrthographic(projection)` numeric probe.
- Create: `src/geo/__tests__/orthographic.test.ts`.
- Create: `src/webgl/sphere-mesh.ts` — UV-sphere vertex/index builder (lon/lat per vertex).
- Modify: `src/webgl/shaders.ts` — add `GLOBE_VS` / `GLOBE_FS`.
- Create: `src/webgl/globe.ts` — `GlobeRenderer`: the equirect FBO bake target + textured-sphere model + rotation/view uniforms.
- Modify: `src/webgl/webgl-backend.ts` — globe mode: `setGlobeMode`, `setGlobeRotation`, bake-dirty tracking, render the sphere when active.
- Create: `src/webgl/globe.browser.test.ts` — spike + behavior tests.
- Modify: `src/core/index.ts` / `src/webgl/index.ts` if new exports are needed (internal only).

**Website (`website/`):**
- Modify: `src/examples/map-projections/draw.ts` — replace the `if (entry.spherical)` branch with a single `map.enableZoom([1, 8])`.

**Release:**
- Create: `.changeset/gpu-globe-mode.md` — minor.

---

## Task 1: Unify `enableZoom` to auto-dispatch rotation for spherical projections

**Files:**
- Modify: `packages/d3gl/src/map/geo-map.ts`
- Test: `packages/d3gl/src/map/geo-map-globe.browser.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (append to `geo-map-globe.browser.test.ts`)

```ts
import { geoMercator } from "d3-geo"; // add to existing imports

it("enableZoom dispatches: rotation for spherical, affine zoom for flat", async () => {
  const host = mount();
  // Spherical (orthographic): enableZoom should attach the rotation wheel handler
  // (wheel changes projection.scale), not d3-zoom.
  const globe = geoMap(host, { width: 200, height: 200, projection: geoOrthographic().fitSize([200, 200], sphere), backend: "canvas" });
  await globe.whenReady();
  globe.layer("land", [land()], { fill: "rgb(0,128,0)" });
  globe.enableZoom([0.5, 8]);
  const s0 = (globe as any).projection.scale();
  host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
  expect((globe as any).projection.scale()).toBeGreaterThan(s0); // rotation path scales the projection
  globe.destroy();

  // Flat (mercator): enableZoom should attach d3-zoom (affine transform changes), projection.scale fixed.
  const host2 = mount();
  const flat = geoMap(host2, { width: 200, height: 200, projection: geoMercator().fitSize([200, 200], sphere), backend: "canvas" });
  await flat.whenReady();
  flat.layer("land", [land()], { fill: "rgb(0,128,0)" });
  flat.enableZoom([1, 8]);
  const fs0 = (flat as any).projection.scale();
  // d3-zoom seeds the transform; a programmatic check: the affine transform path leaves projection.scale unchanged.
  expect((flat as any).projection.scale()).toBe(fs0);
  flat.destroy();
});
```

Run: `cd packages/d3gl && pnpm exec vitest run src/map/geo-map-globe.browser.test.ts` → FAIL (enableZoom not overridden on GeoMap yet; spherical wheel won't change scale because BaseEngine.enableZoom is affine).

- [ ] **Step 2: Implement the override in `GeoMap`**

Add an `enableZoom` override (place it just above `enableRotation`). It dispatches on the cached spherical flag:

```ts
  /** One entry point for both projection kinds: a spherical (azimuthal) projection
   *  gets versor rotation (drag) + wheel-zoom bounded by `extent`; a flat projection
   *  gets d3-zoom affine pan/zoom. `extent` sets the zoom limits for both. */
  override enableZoom(extent: [number, number] = [1, 100], onTransform?: (t: ViewTransform) => void): this {
    if (this.isSpherical()) return this.enableRotation({ scaleExtent: extent });
    return super.enableZoom(extent, onTransform);
  }

  /** Azimuthal projections report a positive clipAngle (orthographic 90, stereographic
   *  142, azimuthal* ~180, gnomonic 60); cylindrical/conic report 0. Cached per projection. */
  private isSpherical(): boolean {
    const ca = this.projection.clipAngle();
    return ca != null && ca > 0;
  }
```

Add the `ViewTransform` type import at the top:

```ts
import { BaseEngine, type HoverHit, type LayerSpec } from "./base-engine.js";
import type { ViewTransform } from "../core/index.js";
```

(Confirm `ViewTransform` is exported from `../core/index.js`; it is used by `BaseEngine.enableZoom`'s signature. If it is re-exported from `./base-engine.js` instead, import it from there.)

- [ ] **Step 3: Run the test** → PASS. Then `pnpm exec tsc -b` clean and the full suite green (`cd ../.. && pnpm test`).

- [ ] **Step 4: Commit**

```bash
git add packages/d3gl/src/map/geo-map.ts packages/d3gl/src/map/geo-map-globe.browser.test.ts
git commit -m "feat(map): enableZoom auto-dispatches rotation for spherical projections"
```

---

## Task 2: Orthographic detection probe

**Files:**
- Create: `packages/d3gl/src/geo/orthographic.ts`
- Test: `packages/d3gl/src/geo/__tests__/orthographic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/d3gl/src/geo/__tests__/orthographic.test.ts
import { describe, it, expect } from "vitest";
import { geoOrthographic, geoStereographic, geoGnomonic, geoMercator, geoAzimuthalEqualArea } from "d3-geo";
import { isOrthographic } from "../orthographic.js";

describe("isOrthographic", () => {
  it("is true for geoOrthographic at any scale/translate/rotate", () => {
    expect(isOrthographic(geoOrthographic())).toBe(true);
    expect(isOrthographic(geoOrthographic().scale(120).translate([200, 150]).rotate([30, -20, 5]))).toBe(true);
  });
  it("is false for other spherical projections", () => {
    expect(isOrthographic(geoStereographic())).toBe(false);
    expect(isOrthographic(geoGnomonic())).toBe(false);
    expect(isOrthographic(geoAzimuthalEqualArea())).toBe(false);
  });
  it("is false for flat projections", () => {
    expect(isOrthographic(geoMercator())).toBe(false);
  });
});
```

Run → FAIL (module missing).

- [ ] **Step 2: Implement the probe**

```ts
// packages/d3gl/src/geo/orthographic.ts
import { geoOrthographic } from "d3-geo";
import type { GeoProjection } from "d3-geo";

// Sample lon/lat points spread across a hemisphere; orthographic must agree with a
// reference geoOrthographic carrying the same scale/translate/rotate/clipAngle at all
// of them (within epsilon). Non-orthographic azimuthals diverge in their radial profile.
const SAMPLES: [number, number][] = [[0, 0], [20, 35], [-40, 10], [15, -25]];
const EPS = 1e-3;

/** True if `p` behaves like d3.geoOrthographic (so the GPU globe path can drive it). */
export function isOrthographic(p: GeoProjection): boolean {
  const ref = geoOrthographic()
    .scale(p.scale())
    .translate(p.translate())
    .rotate(p.rotate())
    .clipAngle(p.clipAngle());
  // precision() may differ; align it if present.
  if (typeof (p as { precision?: () => number }).precision === "function") {
    ref.precision((p as unknown as { precision: () => number }).precision());
  }
  for (const s of SAMPLES) {
    const a = p(s);
    const b = ref(s);
    if (!a || !b) {
      if (Boolean(a) !== Boolean(b)) return false; // one clipped the point, the other didn't
      continue;
    }
    if (Math.abs(a[0] - b[0]) > EPS || Math.abs(a[1] - b[1]) > EPS) return false;
  }
  return true;
}
```

- [ ] **Step 3: Run** → PASS. `pnpm exec tsc -b` clean.

- [ ] **Step 4: Commit**

```bash
git add packages/d3gl/src/geo/orthographic.ts packages/d3gl/src/geo/__tests__/orthographic.test.ts
git commit -m "feat(geo): isOrthographic probe for GPU globe activation"
```

---

## Task 3: Spike — bake a layer into an equirect FBO and sample it on a sphere

**Files:**
- Create: `packages/d3gl/src/webgl/sphere-mesh.ts`
- Modify: `packages/d3gl/src/webgl/shaders.ts`
- Create: `packages/d3gl/src/webgl/globe.browser.test.ts`

Goal: prove the FBO-bake → textured-sphere pipeline end-to-end in isolation (headless WebGL2 via luma.gl) before integrating into the backend. This de-risks the luma.gl specifics (sampling a framebuffer's color texture, back-face culling, depth).

- [ ] **Step 1: Sphere mesh builder**

```ts
// packages/d3gl/src/webgl/sphere-mesh.ts
/** A UV-sphere as parallel arrays. Each vertex carries its lon/lat (degrees) so the
 *  globe shader can both place it (lon/lat → 3D direction → rotate → orthographic)
 *  and sample the equirectangular texture (lon/lat → uv). Unit radius. */
export interface SphereMesh {
  /** Stride 2: [lonDeg, latDeg] per vertex. */
  lonLat: Float32Array;
  indices: Uint32Array;
}

export function buildSphereMesh(lonSegments = 96, latSegments = 48): SphereMesh {
  const lonLat: number[] = [];
  for (let j = 0; j <= latSegments; j++) {
    const lat = 90 - (180 * j) / latSegments; // +90 → -90
    for (let i = 0; i <= lonSegments; i++) {
      const lon = -180 + (360 * i) / lonSegments; // -180 → 180
      lonLat.push(lon, lat);
    }
  }
  const idx: number[] = [];
  const row = lonSegments + 1;
  for (let j = 0; j < latSegments; j++) {
    for (let i = 0; i < lonSegments; i++) {
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return { lonLat: new Float32Array(lonLat), indices: new Uint32Array(idx) };
}
```

- [ ] **Step 2: Globe shaders** (append to `shaders.ts`)

```glsl
// GLOBE_VS / GLOBE_FS — render a UV-sphere, sampling an equirectangular map texture.
// Uniforms: u_rotation (mat3, applied to the surface direction), u_scale (px radius),
// u_center (px), u_viewport (px). Attribute a_lonLat (degrees).
export const GLOBE_VS = `#version 300 es
precision highp float;
in vec2 a_lonLat;
uniform mat3 u_rotation;
uniform float u_scale;
uniform vec2 u_center;
uniform vec2 u_viewport;
out vec2 v_uv;
out float v_front;
const float PI = 3.141592653589793;
void main() {
  float lon = radians(a_lonLat.x);
  float lat = radians(a_lonLat.y);
  // Surface direction on the unit sphere (z toward viewer after rotation).
  vec3 dir = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  vec3 r = u_rotation * dir;
  v_front = r.z;                       // > 0 ⇒ front hemisphere
  // Orthographic placement to clip space (y up). Match the affine pixel convention.
  vec2 px = u_center + vec2(r.x, -r.y) * u_scale;
  vec2 clip = vec2(px.x / u_viewport.x * 2.0 - 1.0, 1.0 - px.y / u_viewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = vec2(a_lonLat.x / 360.0 + 0.5, 0.5 - a_lonLat.y / 180.0);
}`;

export const GLOBE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_front;
uniform sampler2D u_map;
out vec4 fragColor;
void main() {
  if (v_front <= 0.0) discard;          // back hemisphere → exact limb
  fragColor = texture(u_map, v_uv);
}`;
```

(Back-hemisphere `discard` plus depth/cull. The spike will confirm whether `discard` alone suffices or whether `cullMode: "back"` / depth test is also needed; adjust the Model parameters accordingly.)

- [ ] **Step 3: Spike test — render a half-red/half-blue equirect texture, sphere shows red at centre**

```ts
// packages/d3gl/src/webgl/globe.browser.test.ts
import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Model } from "@luma.gl/engine";
import { Buffer } from "@luma.gl/core";
import { buildSphereMesh } from "./sphere-mesh.js";
import { GLOBE_VS, GLOBE_FS } from "./shaders.js";

const W = 128, H = 128;

async function device() {
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  document.body.appendChild(canvas);
  const dev = await luma.createDevice({ adapters: [webgl2Adapter], type: "webgl", createCanvasContext: { canvas, useDevicePixels: false } });
  return { dev, canvas };
}

describe("globe spike", () => {
  it("samples an equirect texture on a sphere (front hemisphere only)", async () => {
    const { dev } = await device();
    // Equirect source: left half (lon < 0) red, right half blue.
    const texW = 8, texH = 4;
    const data = new Uint8Array(texW * texH * 4);
    for (let y = 0; y < texH; y++) for (let x = 0; x < texW; x++) {
      const o = (y * texW + x) * 4;
      const red = x < texW / 2;
      data[o] = red ? 255 : 0; data[o + 1] = 0; data[o + 2] = red ? 0 : 255; data[o + 3] = 255;
    }
    const map = dev.createTexture({ data, width: texW, height: texH, format: "rgba8unorm", mipLevels: 1, sampler: { minFilter: "linear", magFilter: "linear" } });

    const fb = dev.createFramebuffer({ width: W, height: H, colorAttachments: ["rgba8unorm"], depthStencilAttachment: "depth24plus" });
    const mesh = buildSphereMesh(64, 32);
    const lonLat = dev.createBuffer({ data: mesh.lonLat });
    const indexBuffer = dev.createBuffer({ data: mesh.indices, usage: Buffer.INDEX, indexType: "uint32" });
    const identity3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const model = new Model(dev, {
      vs: GLOBE_VS, fs: GLOBE_FS,
      bufferLayout: [{ name: "a_lonLat", format: "float32x2" }],
      attributes: { a_lonLat: lonLat },
      indexBuffer, topology: "triangle-list", vertexCount: mesh.indices.length,
      bindings: { u_map: map },
      uniforms: { u_rotation: identity3, u_scale: W * 0.45, u_center: new Float32Array([W / 2, H / 2]), u_viewport: new Float32Array([W, H]) },
      parameters: { depthWriteEnabled: true, depthCompare: "less-equal", cullMode: "back" },
    });
    const pass = dev.beginRenderPass({ framebuffer: fb, clearColor: [0, 0, 0, 0], clearDepth: 1 });
    model.draw(pass); pass.end(); dev.submit();

    const center = dev.readPixelsToArrayWebGL(fb, { sourceX: W / 2, sourceY: H / 2, sourceWidth: 1, sourceHeight: 1 });
    // Identity rotation, centre of disc = lon/lat ~[0,0] which sits at the texture seam
    // between red and blue; assert it's opaque and one of the two source colors, not clear.
    expect(center[3]).toBeGreaterThan(200);                    // opaque (sphere is here)
    expect(center[0] + center[2]).toBeGreaterThan(150);        // red or blue, not black/clear
    // A corner well outside the disc must be clear (back/empty).
    const corner = dev.readPixelsToArrayWebGL(fb, { sourceX: 2, sourceY: 2, sourceWidth: 1, sourceHeight: 1 });
    expect(corner[3]).toBeLessThan(40);
    dev.destroy();
  });
});
```

- [ ] **Step 4: Run the spike**

Run: `cd packages/d3gl && pnpm exec vitest run src/webgl/globe.browser.test.ts`
Expected: PASS. If the sphere renders empty or the corner isn't clear, iterate on the Model `parameters` (cull/depth) and the clip-space mapping in `GLOBE_VS` until the assertions hold. **Record in the test file what parameter set worked** (it informs Task 5).

- [ ] **Step 5: Commit**

```bash
git add packages/d3gl/src/webgl/sphere-mesh.ts packages/d3gl/src/webgl/shaders.ts packages/d3gl/src/webgl/globe.browser.test.ts
git commit -m "feat(webgl): sphere mesh + globe shaders + bake/sample spike"
```

---

## Task 4: `GlobeRenderer` — equirect bake target + textured sphere

**Files:**
- Create: `packages/d3gl/src/webgl/globe.ts`
- Test: `packages/d3gl/src/webgl/globe.browser.test.ts` (extend)

Encapsulate the spike into a reusable renderer the backend drives.

- [ ] **Step 1: Implement `GlobeRenderer`**

```ts
// packages/d3gl/src/webgl/globe.ts
import { Buffer } from "@luma.gl/core";
import type { Device, Framebuffer, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { buildSphereMesh } from "./sphere-mesh.js";
import { GLOBE_VS, GLOBE_FS } from "./shaders.js";

const identity3 = (): Float32Array => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** Owns the equirectangular bake framebuffer and the textured-sphere model. The
 *  backend renders the map layers into `bakeTarget()` (the FBO), then calls
 *  `draw()` to paint the sphere sampling that texture under the current view. */
export class GlobeRenderer {
  private fbo: Framebuffer;
  private model: Model;
  private rotation = identity3();
  private indexCount: number;

  constructor(private device: Device, private texW: number, private texH: number, private viewportW: number, private viewportH: number) {
    this.fbo = device.createFramebuffer({ width: texW, height: texH, colorAttachments: ["rgba8unorm"], depthStencilAttachment: "depth24plus-stencil8" });
    const mesh = buildSphereMesh();
    this.indexCount = mesh.indices.length;
    const lonLat = device.createBuffer({ data: mesh.lonLat });
    const indexBuffer = device.createBuffer({ data: mesh.indices, usage: Buffer.INDEX, indexType: "uint32" });
    this.model = new Model(device, {
      vs: GLOBE_VS, fs: GLOBE_FS,
      bufferLayout: [{ name: "a_lonLat", format: "float32x2" as const }],
      attributes: { a_lonLat: lonLat },
      indexBuffer, topology: "triangle-list" as const, vertexCount: this.indexCount,
      bindings: { u_map: this.colorTexture() },
      uniforms: { u_rotation: this.rotation, u_scale: 0, u_center: new Float32Array([0, 0]), u_viewport: new Float32Array([viewportW, viewportH]) },
      parameters: { depthWriteEnabled: true, depthCompare: "less-equal", cullMode: "back" }, // per spike findings
    });
  }

  /** The framebuffer the backend bakes the equirect map into. */
  bakeTarget(): Framebuffer { return this.fbo; }
  private colorTexture() { return this.fbo.colorAttachments[0]; } // luma v9: FBO color attachment is a Texture(View)

  /** Resize the bake texture (power-of-2 level change). Recreates the FBO + rebinds. */
  setTextureSize(texW: number, texH: number): void {
    if (texW === this.texW && texH === this.texH) return;
    this.fbo.destroy();
    this.texW = texW; this.texH = texH;
    this.fbo = this.device.createFramebuffer({ width: texW, height: texH, colorAttachments: ["rgba8unorm"], depthStencilAttachment: "depth24plus-stencil8" });
    this.model.setBindings({ u_map: this.colorTexture() });
  }

  setRotation(m: Float32Array): void { this.rotation = m; this.model.setUniforms({ u_rotation: m }); }

  /** Draw the sphere into an open pass. `scale` = globe radius in px, `center` = px. */
  draw(pass: RenderPass, scale: number, center: [number, number]): void {
    this.model.setUniforms({ u_scale: scale, u_center: new Float32Array(center) });
    this.model.draw(pass);
  }

  destroy(): void { this.fbo.destroy(); this.model.destroy(); }
}
```

(Confirm the luma v9 API for the FBO color texture binding — `fbo.colorAttachments[0]` — and `Model.setBindings`/`setUniforms` during the spike; adjust if the accessor differs.)

- [ ] **Step 2: Test — rotation changes pixels without re-creating the FBO**

Add to `globe.browser.test.ts`: build a `GlobeRenderer`, manually write a known pattern into its `bakeTarget()` (clear it to a color via a render pass), `draw()` into an output FBO, read centre pixel; then `setRotation` to a 180° Y rotation, `draw()` again, read centre — assert the centre color changed (different hemisphere shown). Assert no exception on `setTextureSize` to a larger size.

- [ ] **Step 3: Run** → PASS. `pnpm exec tsc -b` clean.

- [ ] **Step 4: Commit**

```bash
git add packages/d3gl/src/webgl/globe.ts packages/d3gl/src/webgl/globe.browser.test.ts
git commit -m "feat(webgl): GlobeRenderer (equirect bake FBO + textured sphere)"
```

---

## Task 5: WebGLBackend globe mode

**Files:**
- Modify: `packages/d3gl/src/webgl/webgl-backend.ts`
- Test: `packages/d3gl/src/webgl/webgl-backend.browser.test.ts` (extend)

- [ ] **Step 1: Add globe-mode state + API**

Add fields and methods to `WebGLBackend`:

```ts
  private globe: GlobeRenderer | null = null;   // non-null ⇒ globe mode active
  private bakeDirty = true;

  /** Enter/leave globe mode. texW/texH = current equirect bake size. */
  setGlobeMode(on: boolean, texW = 2048, texH = 1024): void {
    if (on && !this.globe) this.globe = new GlobeRenderer(this.device, texW, texH, this.width, this.height);
    else if (on && this.globe) this.globe.setTextureSize(texW, texH);
    else if (!on && this.globe) { this.globe.destroy(); this.globe = null; }
    this.bakeDirty = true;
  }
  setGlobeRotation(m: Float32Array): void { this.globe?.setRotation(m); this.render(); }
```

In `setLayers` and `updateLayer`, set `this.bakeDirty = true;` (the baked texture is stale when layers change).

- [ ] **Step 2: Route `render()`/`drawInto` through the globe when active**

When `this.globe` is set, `render()` must (a) if `bakeDirty`, render all layers into `globe.bakeTarget()` using the EXISTING per-layer draw loop (the layers were built with an equirect projection at the texture size, identity transform), then clear the dirty flag; (b) draw the sphere into the canvas default framebuffer with the current view transform's scale (`viewTransform.k * baseRadius`) and center.

Refactor `drawInto(framebuffer)` so the existing layer loop can target an arbitrary framebuffer (it already takes one). Add:

```ts
  render(): void {
    if (this.globe) { this.renderGlobe(); return; }
    const cc = this.device.getDefaultCanvasContext();
    const fb = cc.getCurrentFramebuffer({ depthStencilFormat: "depth24plus-stencil8" });
    this.drawInto(fb);
  }

  private renderGlobe(): void {
    const g = this.globe!;
    if (this.bakeDirty) {
      // Bake: render the equirect-projected layers into the globe FBO at identity scale.
      // The layers' geometry already spans the texture rect (GeoMap built them with an
      // equirectangular projection fitted to [texW, texH]); use an identity clip matrix
      // sized to the texture, NOT this.clipMatrix (which is sized to the canvas).
      this.drawIntoTexture(g.bakeTarget());
      this.bakeDirty = false;
    }
    const cc = this.device.getDefaultCanvasContext();
    const out = cc.getCurrentFramebuffer({ depthStencilFormat: "depth24plus-stencil8" });
    const pass = this.device.beginRenderPass({ framebuffer: out, clearColor: [0, 0, 0, 0], clearDepth: 1 });
    const baseRadius = Math.min(this.width, this.height) * 0.45; // fits the sphere; tune to match fitSize
    const k = this.viewTransform.k;
    g.draw(pass, baseRadius * k, [this.width / 2 + this.viewTransform.x, this.height / 2 + this.viewTransform.y]);
    pass.end();
    this.device.submit();
  }
```

`drawIntoTexture(fb)`: same as the body of `drawInto` but builds an identity clip matrix from the texture size (`clipFromView({k:1,x:0,y:0}, texW, texH)`) and sets it on each renderer for the bake pass, then restores `this.clipMatrix`. Keep this localized; the per-layer stencil/sizeMode loop is reused.

(Detail to settle during implementation: the renderers' transform is shared via `setTransform`. For the bake pass, set each renderer's transform to the texture-sized identity matrix, draw, then the on-screen sphere path doesn't use renderer transforms. Since globe mode never draws layers to screen, this is safe.)

- [ ] **Step 3: Test — globe mode bakes and the sphere renders; rotation updates pixels**

Extend `webgl-backend.browser.test.ts`: create a backend, `setLayers` with one full-sphere ocean rect (an equirect-filling layer), `setGlobeMode(true, 256, 128)`, `render()`, then `readScreenPixel(center)` is opaque and the corner is clear. `setGlobeRotation(<180° Y>)` then re-read — no throw; pixel stays opaque (still ocean). `setGlobeMode(false)` returns to the flat path.

- [ ] **Step 4: Run + tsc** → PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add packages/d3gl/src/webgl/webgl-backend.ts packages/d3gl/src/webgl/webgl-backend.browser.test.ts
git commit -m "feat(webgl): backend globe mode (bake to FBO, draw textured sphere)"
```

---

## Task 6: GeoMap globe orchestration

**Files:**
- Modify: `packages/d3gl/src/map/geo-map.ts`
- Test: `packages/d3gl/src/map/geo-map-globe.browser.test.ts` (extend)

- [ ] **Step 1: Detect + cache the GPU-globe condition**

Add to `GeoMap`:

```ts
  private gpuGlobe = false; // backend webgl AND projection orthographic (cached)

  private evalGpuGlobe(): void {
    // backendType() — add a protected getter on BaseEngine returning the active BackendType.
    this.gpuGlobe = this.backendType() === "webgl" && isOrthographic(this.projection);
  }
```

Call `evalGpuGlobe()` in the constructor (after `whenReady`/first backend), in `setProjection`, and in `setBackend` (override to call super then re-eval + re-apply mode). Import `isOrthographic` from `../geo/orthographic.js`. Add `protected backendType(): BackendType` to `BaseEngine` returning the current backend type (store it when swapping).

- [ ] **Step 2: GPU path in `enableRotation`**

When `this.gpuGlobe`, `enableRotation` must: (a) tell the backend to enter globe mode at the current texture level; (b) build the baked geometry with an internal equirectangular projection at `texW×texH` (a new private `bakeEquirect()` that rebuilds all layers via `geoEquirectangular().fitSize([texW, texH], {type:"Sphere"})` instead of `this.projection`); (c) wire the versor handlers to call `backend.setGlobeRotation(rotationMatrixFrom(this.projection.rotate()))` instead of re-projecting; (d) wheel zoom adjusts the view scale and, on a power-of-2 level change, rebuilds the bake geometry at the new size + `setGlobeMode(true, newW, newH)` (debounced). The CPU branch (non-GPU) stays exactly as today.

Sketch:

```ts
  enableRotation(opts: RotationOptions = {}): this {
    this.disableInteraction();
    if (this.gpuGlobe) return this.enableGpuGlobe(opts);
    /* ...existing CPU versor implementation unchanged... */
  }
```

`enableGpuGlobe`:
- `this.bakeLevel = 0; this.applyBake();` — build equirect geometry at base size and `backend.setGlobeMode(true, texW, texH)`.
- versor drag (same trackball math) → on move, `this.projection.rotate(rot)` (to keep state) then `backend.setGlobeRotation(mat3FromRotation(rot))`; NO `rebuildLayers`.
- wheel → update an internal `viewScale` (clamped to `extent`), push it to the backend via `setTransform({k: viewScale, x:0, y:0})`; compute `level = clamp(floor(log2(viewScale)), 0, maxLevel)`; if changed, debounce `applyBake()` at the new size.
- register cleanup that removes listeners, clears the debounce timer, and `backend.setGlobeMode(false)`.

Add helpers: `mat3FromRotation([λ,φ,γ])` (compose the same 3D rotation d3 applies — reuse versor: a rotation matrix equivalent, or derive from Euler angles); `applyBake()` (rebuild layers with the equirect projection sized to the current level, then `setGlobeMode(true, w, h)` + mark bake dirty via `setLayers`).

(The exact `mat3FromRotation` must match d3's rotate convention so the texture lands correctly; verify against the spike by comparing a rotated globe pixel to a CPU `geoOrthographic().rotate(...)` projection of a known point.)

- [ ] **Step 3: `hideOnInteraction` no-op while GPU globe is live**

In `enableGpuGlobe`, do NOT set `this.interacting` (rotation is free; nothing to hide). Add a guard so `setInteracting` is never driven from the GPU path. The CPU path keeps today's behavior. Document it.

- [ ] **Step 4: Tests**

Extend `geo-map-globe.browser.test.ts`:
- On `backend: "webgl"` + orthographic, after `enableZoom([0.5,8])`, the engine reports `gpuGlobe === true` and a drag calls the backend's globe rotation (spy/assert `projection.rotate()` changed but layers were NOT rebuilt — e.g. assert the scene group's drawable buffers are identity-stable, or assert a re-tessellation counter didn't increment; simplest: assert `(map as any).gpuGlobe` is true and rotating does not throw and the projection rotation changed).
- On `backend: "canvas"` + orthographic, `gpuGlobe === false` and rotation uses the CPU path (drawables rebuild — existing behavior).
- Switching projection to a flat one re-evaluates `gpuGlobe` to false.

- [ ] **Step 5: Run full suite + tsc** → green/clean.

- [ ] **Step 6: Commit**

```bash
git add packages/d3gl/src/map/geo-map.ts packages/d3gl/src/map/base-engine.ts packages/d3gl/src/map/geo-map-globe.browser.test.ts
git commit -m "feat(map): GeoMap GPU-globe orchestration (bake geometry, drive rotation uniform)"
```

---

## Task 7: Export + edge cases

**Files:**
- Modify: `packages/d3gl/src/webgl/webgl-backend.ts`
- Test: `packages/d3gl/src/webgl/webgl-backend.browser.test.ts`

- [ ] **Step 1: `toPNG` in globe mode** captures the sphere view. Route `toPNG()` through `renderGlobe()` into the offscreen framebuffer (instead of `drawInto(offscreen)`) when `this.globe` is set, then read it back as today.

- [ ] **Step 2: `toSVG` in globe mode** cannot draw the 3D sphere. Return the existing CPU snapshot: `svgFromLayers(...)` with the layers re-projected by `geoOrthographic` at the current rotation (the SVG backend is the CPU path; for the WebGL backend's `toSVG` in globe mode, document it falls back to a flat orthographic snapshot — acceptable since SVG export is normally taken on the SVG backend, which never enters globe mode).

- [ ] **Step 3: Test** — `toPNG()` in globe mode returns a `data:image/png` string and is non-empty; `toSVG()` returns a string without throwing.

- [ ] **Step 4: Commit**

```bash
git add packages/d3gl/src/webgl/webgl-backend.ts packages/d3gl/src/webgl/webgl-backend.browser.test.ts
git commit -m "feat(webgl): globe-mode PNG export + SVG fallback"
```

---

## Task 8: Example simplification + changeset

**Files:**
- Modify: `website/src/examples/map-projections/draw.ts`
- Create: `.changeset/gpu-globe-mode.md`

- [ ] **Step 1: Simplify the example dispatch**

In `render(options)`, replace:

```ts
      if (entry.spherical) map.enableRotation();
      else map.enableZoom([1, 8]);
```

with a single call (the engine now auto-dispatches):

```ts
      map.enableZoom([1, 8]);
```

(Leave the `PROJECTIONS` registry's `spherical` field as-is — it still documents intent and is harmless; or drop it if unused elsewhere. Verify no other reference before removing.)

- [ ] **Step 2: Build the website** — `cd website && pnpm build` succeeds.

- [ ] **Step 3: Changeset**

```md
---
"@mapequation/d3gl": minor
---

GPU-accelerate orthographic-globe rotation on the WebGL backend: the map is baked
into an equirectangular texture and drawn on a spinning 3D sphere, so rotation and
zoom are uniform updates instead of per-frame re-projection. Activation is
automatic (WebGL + orthographic); canvas/SVG and other projections are unchanged.
`GeoMap.enableZoom(extent)` now auto-dispatches: versor rotation for spherical
projections (azimuthal, `clipAngle > 0`), affine pan/zoom for flat ones.
```

- [ ] **Step 4: Commit**

```bash
git add website/src/examples/map-projections/draw.ts .changeset/gpu-globe-mode.md
git commit -m "feat(website): single enableZoom for all projections; changeset for GPU globe"
```

---

## Final review

- [ ] `pnpm test` (node) — all pass.
- [ ] Full browser suite (`cd packages/d3gl && pnpm exec vitest run`) — all pass, no screenshot regressions.
- [ ] `pnpm typecheck`, `pnpm build:lib`, `pnpm --filter @d3gl/website build`.
- [ ] Manual / Playwright: on the map-projections page (WebGL, Orthographic) the globe rotates smoothly with the dense grid visible (no per-frame stall); zoom stays crisp across a couple of power-of-2 levels; switching to a non-orthographic spherical projection still rotates (CPU) and honors the Features toggle; flat projections pan/zoom; canvas/SVG unchanged; export works.
- [ ] Compare GPU vs CPU globe visually for parity (land/cells/region/points positions at a few rotations).
- [ ] Dispatch a final code reviewer over the whole diff, then use superpowers:finishing-a-development-branch.

## Notes for the implementer

- Tasks 3–5 are the GPU core and carry the most unknowns; the Task 3 spike exists to lock down the luma.gl v9 specifics (FBO color-texture binding, `cullMode`/depth parameters, clip-space mapping) **before** the integration tasks. Record what worked in the spike test.
- If `mat3FromRotation` proves fiddly, an alternative is to pass the Euler angles `[λ,φ,γ]` as a uniform and build the rotation in the vertex shader (matching d3's rotate order: rotate by −λ about Y, then −φ about X, then −γ about Z, or per d3-geo's convention — verify against a CPU reference point).
- Keep the flat/CPU paths untouched; globe mode is strictly additive and gated by `gpuGlobe`.
