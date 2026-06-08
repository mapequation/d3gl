# Pass-through Rendering — Phase 2: WebGL backend (points)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the WebGL backend the same pass-through contract the Canvas backend already implements, so huge point sets render with zero per-point retention on the GPU — and so `auto` mode upgrades Canvas→WebGL with pass-through layers intact.

**Architecture:** Each pass-through layer's points are rasterized into a viewport-sized **offscreen accumulation FBO** (which persists across frames, unlike the default framebuffer). Points are quad-expanded into a **reused scratch buffer** with **per-point color as a vertex attribute** (no per-drawable color texture → no WebGL texture cliff). The FBO is composited onto the screen after the retained layers via a **full-screen textured quad (blit)**. During interaction the blit applies the delta between the transform the FBO was drawn at and the live transform (snapshot-pan) — so the base map stays crisp and only the points are a stale raster until settle. The engine already drives `drawPassThrough`/`snapshotPassThrough`/`setTransform` + time-slicing + install-replay (Phase 1); this phase only implements the WebGL side of the backend contract.

**Tech Stack:** TypeScript, luma.gl (WebGL2: `Device`, `Model`, `Framebuffer`, `RenderPass`), Vitest browser mode (Playwright/Chromium) with GPU pixel readback.

---

## Spec & prior work

- Design: [docs/superpowers/specs/2026-06-08-pass-through-point-rendering-design.md](../specs/2026-06-08-pass-through-point-rendering-design.md)
- Phase 1 (engine + Canvas, points): PR #31, branch `feat/passthrough-points`. This phase stacks on it (`feat/passthrough-webgl`).

### Contract already in place (do NOT reimplement)
- `Backend` (core) optional members: `setPassThroughLayer?(layer)`, `removePassThroughLayer?(name)`, `drawPassThrough?(name, batch: PointBatch, mode: "replace-first"|"replace-rest"|"append")`, `snapshotPassThrough?()`, `readonly supportsPassThrough?`.
- `PointBatch = { positions: Float32Array /* [x,y] world coords */, radii: Float32Array, colors: Uint8Array /* rgba/point */, count }`.
- Engine: time-slices repaints into ≤500k-point batches (so each `drawPassThrough` call is already a bounded chunk); first chunk `"replace-first"`, rest `"replace-rest"`, incremental `"append"`. On install/swap it re-registers pass-through layers and repaints. On gesture start it calls `snapshotPassThrough()`; during the gesture it calls `setTransform(t)` + `render()` each frame and does NOT repaint pass-through; on settle it repaints.
- **Phase 1 auto-mode guard:** `upgradeToWebGL` currently ABORTS the Canvas→WebGL upgrade when pass-through layers exist and WebGL lacks `supportsPassThrough`. Once this phase sets `supportsPassThrough = true` on the WebGL backend, that guard stops firing and the upgrade proceeds + re-registers PT layers (engine `installBackend` replay). Task 4/5 verify this.

### Key existing code to mirror (read before coding)
- `packages/d3gl/src/webgl/renderer.ts`: `GrowBuffer` (ctor `(device, Float32Array|Uint32Array, data, isIndex?)`, `.append(data) → boolean realloc`, `.buffer`), `GroupRenderer.expandPoints(pc, vertexBase)` (stride-4 `[x,y,r,id]` → `{center,corner,radius,pointId,index}`), `buildPointPass` (Model construction), `POINT_CORNERS`.
- `packages/d3gl/src/webgl/shaders.ts`: `POINT_VS`/`POINT_FS` (POINT_FS is reusable as-is — it only uses `v_color` + `v_local`).
- `packages/d3gl/src/webgl/webgl-backend.ts`: `drawInto(fb)` (the main retained render pass), `setTransform`, `render()` (`getDefaultCanvasContext().getCurrentFramebuffer(...)`), `globe.ts` FBO creation (`createFramebuffer({width,height,colorAttachments:["rgba8unorm"],...})`), `this.width/height/viewTransform/clipMatrix`.
- `packages/d3gl/src/webgl/transform.ts`: `clipFromView(t, w, h) → Float32Array(9)` column-major mat3.
- `packages/d3gl/src/webgl/renderer.browser.test.ts`: the device+framebuffer+`readPixels` test pattern to mirror.

## Testing
Browser/GPU tests run via `pnpm --filter @mapequation/d3gl test:browser <file>` (watchdog runner; ~25s full, works reliably). Node: `npx vitest run`. Per-package typecheck: `pnpm --filter @mapequation/d3gl exec tsc -b` (root typecheck is known-broken — don't use it).

---

## File structure (Phase 2)

| File | Responsibility | Create/Modify |
|---|---|---|
| `packages/d3gl/src/webgl/shaders.ts` | Add `PT_POINT_VS` (color-as-attribute point VS) and `BLIT_VS`/`BLIT_FS` (full-screen textured quad). | Modify |
| `packages/d3gl/src/webgl/passthrough-gl.ts` | `PassThroughGL`: owns the accumulation FBO + reused scratch buffers + PT point Model + blit Model; `draw(batch, transform, clear)`, `composite(targetFb, fromTransform, toTransform)`, `destroy()`. | Create |
| `packages/d3gl/src/webgl/__tests__/passthrough-gl.browser.test.ts` | GPU test: draw a batch into the FBO, composite to a target FBO, readPixels to verify color-attribute rendering + blit delta. | Create |
| `packages/d3gl/src/webgl/webgl-backend.ts` | `supportsPassThrough=true`; `setPassThroughLayer`/`removePassThroughLayer`/`drawPassThrough`/`snapshotPassThrough`; composite PT FBO in `drawInto` after retained; track `ptFboTransform`. | Modify |
| `packages/d3gl/src/map/passthrough.browser.test.ts` | Flip the Phase-1 "auto stays canvas" expectation (now upgrades to WebGL with PT intact); add WebGL-backend pass-through assertions. | Modify |

---

## Task 1: Pass-through point shader (color attribute) + blit shader

**Files:** Modify `packages/d3gl/src/webgl/shaders.ts`

The existing `POINT_VS` reads color from `u_colorTable` indexed by `a_pointId` (the per-drawable texture = the cliff). Pass-through instead carries color per vertex.

- [ ] **Step 1: Add `PT_POINT_VS`** (mirrors POINT_VS geometry, but `a_color` attribute instead of texture lookup; no flags):

```glsl
export const PT_POINT_VS = `#version 300 es
precision highp float;
uniform mat3 u_transform;
uniform float u_pointScreen;
uniform vec2 u_viewport;
in vec2 a_center;
in vec2 a_corner;
in float a_radius;
in vec4 a_color;
out vec4 v_color;
out vec2 v_local;
void main() {
  v_color = a_color;
  v_local = a_corner;
  vec3 c = u_transform * vec3(a_center, 1.0);
  vec2 off = (u_pointScreen > 0.5)
    ? a_corner * a_radius * vec2(2.0 / u_viewport.x, -2.0 / u_viewport.y)
    : (u_transform * vec3(a_center + a_corner * a_radius, 1.0)).xy - c.xy;
  gl_Position = vec4(c.xy + off, 0.0, 1.0);
}`;
```
(`POINT_FS` is reused unchanged — it only consumes `v_color`/`v_local`.)

- [ ] **Step 2: Add `BLIT_VS`/`BLIT_FS`** (full-screen textured quad; `u_blit` mat3 maps the quad in clip space for snapshot-pan; identity = 1:1 composite):

```glsl
export const BLIT_VS = `#version 300 es
precision highp float;
uniform mat3 u_blit;        // clip-space transform of the quad (identity for 1:1)
in vec2 a_pos;              // clip-space quad corner (-1..1)
in vec2 a_uv;               // 0..1
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  vec3 p = u_blit * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

export const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 fragColor;
void main() { fragColor = texture(u_tex, v_uv); }`;
```

- [ ] **Step 3: Typecheck** — `pnpm --filter @mapequation/d3gl exec tsc -b` → clean (string constants only).
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(webgl): add pass-through point + blit shaders"` (no co-author).

(No standalone test for shader strings; they are exercised by Task 3's GPU test.)

---

## Task 2: Blit clip-space matrix helper

**Files:** Modify `packages/d3gl/src/webgl/transform.ts`; Test `packages/d3gl/src/webgl/__tests__/transform.test.ts` (create or extend if one exists).

The FBO holds points rasterized at transform `s` (screen px). To composite onto a target at transform `t`, the quad must map so FBO texel for world point `w` lands at `t.k*w + t.off`. A world point is at FBO pixel `p = s.k*w + s.off`; the full-screen quad's uv=p/viewport. We need a clip-space mat3 applied to the standard full-screen quad.

- [ ] **Step 1: Write failing test** (node) for `blitMatrix`:

```ts
import { describe, it, expect } from "vitest";
import { blitMatrix } from "../transform.js";

describe("blitMatrix", () => {
  const s = { k: 1, x: 0, y: 0 };
  it("is identity when from==to (1:1 composite)", () => {
    const m = blitMatrix(s, s, 100, 100);
    // identity mat3 (column-major)
    expect(Array.from(m)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
  it("scales about the viewport for a pure zoom delta", () => {
    // from k=1 to k=2: the quad must scale by 2 about screen origin → in clip space,
    // a 2x screen scale maps clip x' = 2*x + 1 (origin at top-left in screen terms).
    const m = blitMatrix({ k: 1, x: 0, y: 0 }, { k: 2, x: 0, y: 0 }, 100, 100);
    // assert the scale components correspond to a=2 (exact values per derivation below)
    expect(m[0]).toBeCloseTo(2);   // sx
    expect(m[4]).toBeCloseTo(2);   // sy
  });
});
```
(The implementer must DERIVE the exact translate terms and tighten these assertions to exact expected values — see Step 3. Adjust the test to the derived closed form.)

- [ ] **Step 2: Run → fail** (`blitMatrix` undefined).

- [ ] **Step 3: Implement `blitMatrix`.** Derivation: screen→clip is `clip = (2*px/W - 1, 1 - 2*py/H)`. The full-screen quad spans clip [-1,1] with uv∈[0,1] (uv = (clip.x+1)/2, (1-clip.y)/2 → screen px p = uv*[W,H]). A point at FBO px `p` (drawn at transform `s`, so `p = s.k*w + s.off`) must render at screen px `p' = t.k*w + t.off = (t.k/s.k)*(p - s.off) + t.off`. Convert `p` and `p'` to clip and compose into a mat3 that pre-multiplies `a_pos` (clip). Implement and return column-major `Float32Array(9)`, consistent with `clipFromView`. Provide a focused comment with the derivation.

```ts
export function blitMatrix(from: ViewTransform, to: ViewTransform, width: number, height: number): Float32Array {
  // a = to.k/from.k; in screen px: p' = a*(p - from.off) + to.off.
  // Map screen-px affine into clip space for the [-1,1] full-screen quad.
  // ...derive sx, sy, tx, ty and return [sx,0,0, 0,sy,0, tx,ty,1].
}
```

- [ ] **Step 4: Run → pass** (with exact expected values).
- [ ] **Step 5: Commit** — `feat(webgl): blitMatrix for pass-through snapshot-pan composite`.

---

## Task 3: `PassThroughGL` — FBO accumulation + draw + composite

**Files:** Create `packages/d3gl/src/webgl/passthrough-gl.ts`; Test `packages/d3gl/src/webgl/__tests__/passthrough-gl.browser.test.ts`.

Encapsulates one pass-through accumulation surface for the WebGL backend.

- [ ] **Step 1: Write the failing GPU test** (mirror `renderer.browser.test.ts` device/framebuffer setup):

```ts
// passthrough-gl.browser.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { PassThroughGL } from "../passthrough-gl.js";

async function makeDevice(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const device = await luma.createDevice({ adapters: [webgl2Adapter], type: "webgl",
    createCanvasContext: { canvas, useDevicePixels: false }, webgl: { stencil: true } });
  return device;
}

describe("PassThroughGL", () => {
  it("rasterizes a point batch with per-point color into its FBO and composites it", async () => {
    const W = 64, H = 64;
    const device = await makeDevice(W, H);
    const target = device.createFramebuffer({ width: W, height: H, colorAttachments: ["rgba8unorm"], depthStencilAttachment: "depth24plus-stencil8" });
    const pt = new PassThroughGL(device, W, H);
    const t = { k: 1, x: 0, y: 0 };
    // one red point at world (32,32), radius 8
    const batch = { positions: new Float32Array([32, 32]), radii: new Float32Array([8]), colors: new Uint8Array([255, 0, 0, 255]), count: 1 };
    pt.draw(batch, t, /* clear */ true);
    // composite FBO → target at identity (from==to)
    const pass = device.beginRenderPass({ framebuffer: target, clearColor: [0, 0, 0, 0] });
    pt.composite(pass, t, t);
    pass.end(); device.submit();
    // read center pixel
    const gl = device.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.handle ?? null);
    const px = new Uint8Array(4);
    gl.readPixels(32, H - 1 - 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    expect(px[0]).toBeGreaterThan(200); // red
    pt.destroy(); target.destroy(); device.destroy();
  });
});
```
(Adapt `readPixels`/framebuffer-handle access to match exactly what `renderer.browser.test.ts` and `webgl-backend.ts:234` do.)

- [ ] **Step 2: Run → fail** (no `PassThroughGL`).

- [ ] **Step 3: Implement `PassThroughGL`:**
  - Constructor `(device, width, height)`: create the accumulation FBO (`device.createFramebuffer({width,height,colorAttachments:["rgba8unorm"]})`); create reused scratch `GrowBuffer`s (`a_center` f32x2, `a_corner` f32x2, `a_radius` f32, `a_color` **unorm8x4**, `index` u32) seeded empty/small; build one `Model` with `PT_POINT_VS`/`POINT_FS`, `bufferLayout` `PT_POINT_LAYOUT` (add it: `a_center float32x2, a_corner float32x2, a_radius float32, a_color unorm8x4`), `topology:"triangle-list"`, uniforms `{u_transform, u_pointScreen:0, u_viewport:[w,h]}`; build the blit `Model` (`BLIT_VS`/`BLIT_FS`) with a static full-screen quad (a_pos/a_uv) + binding `u_tex` = the FBO color texture + uniform `u_blit`.
  - `draw(batch, transform, clear)`: expand `batch` (positions/radii/colors) to quad attributes — reuse the `expandPoints` corner/index pattern but write `a_color` (4 bytes/vertex, repeated per the 4 corners) instead of `a_pointId`. (Factor a local `expandPtPoints(batch)` or extend the existing expander; keep it in this file — do NOT entangle `GroupRenderer`.) Append into the scratch GrowBuffers (rebind Model attributes if any reallocated), set vertex count. Begin a render pass on the FBO with `clearColor:[0,0,0,0]` only when `clear` is true (else load/preserve), set `u_transform = clipFromView(transform, w, h)`, `model.draw(pass)`, `pass.end()`, `device.submit()`. Record `this.fboTransform = transform` when `clear` is true (the FBO's reference transform).
  - `composite(renderPass, fromTransform, toTransform)`: set blit `u_blit = blitMatrix(fromTransform, toTransform, w, h)`, bind FBO color texture, `blitModel.draw(renderPass)`.
  - `clearFbo()` helper if needed; `destroy()`: destroy FBO, buffers, models.
  - **luma API caveat:** confirm the exact way to (a) preserve FBO contents across `beginRenderPass` when `clear` is false (clearColor omitted vs a `loadOp`), and (b) read the FBO color texture for binding — match how `globe.ts` samples its bake texture (`u_map: this.colorTexture()`). If preserving contents across passes proves unsupported in this luma version, keep the FBO bound and draw multiple batches within behavior equivalent to accumulation; document the approach chosen.

- [ ] **Step 4: Run → pass.** `pnpm --filter @mapequation/d3gl test:browser src/webgl/__tests__/passthrough-gl.browser.test.ts`. Add a second test asserting the blit delta: draw at `s={k:1}`, composite with `to={k:2}`, and assert the red lands at the zoomed position.
- [ ] **Step 5: Typecheck + commit** — `feat(webgl): PassThroughGL accumulation FBO + composite`.

---

## Task 4: Wire `PassThroughGL` into `WebGLBackend`

**Files:** Modify `packages/d3gl/src/webgl/webgl-backend.ts`.

- [ ] **Step 1: Add state + contract methods.**
  - `readonly supportsPassThrough = true;`
  - `private pt: PassThroughGL | null = null;` (single shared accumulation surface — matches the single-PT-layer support level of Phase 1/Canvas), `private ptNames = new Set<string>();`, `private ptFboTransform: ViewTransform | null = null;`
  - `setPassThroughLayer(layer)`: `this.ptNames.add(layer.name); this.pt ??= new PassThroughGL(this.device, this.width, this.height);`
  - `removePassThroughLayer(name)`: `this.ptNames.delete(name); if (this.ptNames.size===0){ this.pt?.destroy(); this.pt=null; this.ptFboTransform=null; }`
  - `drawPassThrough(name, batch, mode)`: `if(!this.pt) return; const clear = mode === "replace-first"; this.pt.draw(batch, this.viewTransform, clear); if (clear) this.ptFboTransform = { ...this.viewTransform };` then `this.render()` so the new content is composited (mirror how the canvas backend makes appends visible; the engine does not call render after drawPassThrough).
  - `snapshotPassThrough()`: no-op (the FBO persists and `ptFboTransform` already records the reference transform — document why; keep the method so the engine's optional-chaining call is satisfied).

- [ ] **Step 2: Composite in `drawInto`.** After the retained `pass.end()` for the existing layers, if `this.pt && this.ptNames.size>0`, composite the PT FBO onto the same target framebuffer in a follow-up render pass that PRESERVES the retained pixels (no clear): `const pass2 = device.beginRenderPass({ framebuffer, /* no clearColor → preserve */ }); this.pt.composite(pass2, this.ptFboTransform ?? this.viewTransform, this.viewTransform); pass2.end(); device.submit();`. Verify the no-clear/preserve semantics against luma (same caveat as Task 3) — the retained content drawn moments earlier must survive. During interaction, `this.viewTransform` differs from `ptFboTransform`, so the blit applies the snapshot-pan delta automatically; the base map is re-rendered crisp by the retained pass.

- [ ] **Step 3: `setTransform` / interaction.** The engine already calls `setTransform(t)` + `render()` each interaction frame. `setTransform` updates `this.viewTransform`/`clipMatrix` (existing). No PT-specific change needed beyond the composite reading `ptFboTransform` vs `viewTransform`. Confirm `render()`→`drawInto` runs the composite. On settle, the engine repaints → `drawPassThrough("replace-first")` redraws the FBO at the new transform and resets `ptFboTransform`, so the blit returns to identity (crisp).

- [ ] **Step 4: Typecheck + node suite** — `pnpm --filter @mapequation/d3gl exec tsc -b` clean; `npx vitest run` green (no node behavior change).
- [ ] **Step 5: Commit** — `feat(webgl): wire pass-through accumulation + composite into backend`.

---

## Task 5: Integration — auto-upgrade + WebGL pass-through browser tests

**Files:** Modify `packages/d3gl/src/map/passthrough.browser.test.ts`.

- [ ] **Step 1: Flip the Phase-1 auto-stays-canvas test.** With WebGL now supporting pass-through, the auto upgrade should PROCEED to WebGL and the PT layer should re-register + render there. Update that test (or replace the stub) so: `backend:"auto"` + PT layer → after the upgrade completes, the live backend is `"webgl"` AND the pass-through point is still visible (`getImageData` on the real canvas). Keep a separate explicit-`svg` rejection test (unchanged).

- [ ] **Step 2: Add explicit `backend:"webgl"` pass-through tests:** (a) a point renders at its projected pixel; (b) `handle.append(batch)` adds a point incrementally (the FBO accumulates — first point survives); (c) color comes through per-point (two points, two colors); (d) snapshot-pan: drive the backend's interaction sequence (`snapshotPassThrough` then `setTransform` deltas then `render`) and assert the point blits to the panned/zoomed location, then settle repaint restores crisp position. Mirror the canvas tests' structure.

- [ ] **Step 3: Run** `pnpm --filter @mapequation/d3gl test:browser src/map/passthrough.browser.test.ts` → green. Then the FULL browser suite `pnpm --filter @mapequation/d3gl test:browser` → green.
- [ ] **Step 4: Commit** — `test(map): WebGL pass-through + auto-upgrade coverage`.

---

## Task 6: Phase 2 verification

- [ ] **Step 1:** `pnpm --filter @mapequation/d3gl exec tsc -b` → clean.
- [ ] **Step 2:** `npx vitest run` → node green.
- [ ] **Step 3:** `pnpm --filter @mapequation/d3gl test:browser` → full browser suite green.
- [ ] **Step 4:** Update the spec status (Phase 2 done) + commit.

## Out of scope (Phase 3+)
- Generic GeoJSON geometry (polygons/lines) — Phase 3.
- Multiple simultaneous pass-through layers compositing independently (single shared FBO here, matching Phase 1's single-PT-layer support).
- Instanced point rendering (quad-expansion reused; instancing is a later optimization).
- Website docs + streaming example — Phase 4.
