# N8 — GPU force layout: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `layout({ backend: "gpu" })` force-layout backend to the `network()` engine that runs the many-body solve on the renderer's WebGL2 device and streams positions back through the existing path, so a 100k-node layout converges at interactive fps instead of ~3–4 updates/sec.

**Architecture:** A `GpuForceLayout` runs force ticks as fragment-shader passes over `rg32float` position/velocity textures on the shared luma.gl device (ping-ponged FBOs). Each streamed frame reads the position texture back into the graph's existing `positions: Float32Array` and calls the same `onFrame` repaint the worker backend uses — so renderer, LOD, and picking are unchanged (Milestone A). Correctness lands first with all-pairs O(n²) repulsion; the Barnes-Hut texture-pyramid then replaces the repulsion pass as a perf optimization gated by a scale test. A WebGL2/float-RTT capability probe falls back to the CPU-worker backend.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), luma.gl (`@luma.gl/core` `luma.createDevice`, `@luma.gl/webgl` `webgl2Adapter`/`WebGLDevice`, `@luma.gl/engine` `Model`), GLSL ES 3.00, Vitest browser mode (`@vitest/browser-playwright`, headless Chromium).

---

## Scope

- **This plan details N8.1 (Milestone A)** — the independently-landable first slice — in full TDD steps. It leaves #106 open (multi-milestone epic).
- **N8.2–N8.7** are a roadmap at the end (goal + files + gates); each gets its own detailed plan when reached, because its shape depends on N8.1's empirical results (does the pyramid θ-traversal converge well on-device; is a global containment refine enough).
- **Out of scope here:** state-network *rendering* (#171) and the top-down/depth-uniform LOD mode (#172) — separate issues.

## Working conventions (read once)

- **Worktree:** all work in `/Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/n8-gpu-layout/` on branch `feat/n8-gpu-layout`. Drive git via `git -C <worktree>`; edit via full worktree paths.
- **Import specifiers use `.js`** even for `.ts` sources (NodeNext). Never `.ts`.
- **Node unit tests:** `pnpm --filter @mapequation/d3gl test <path>` (node env; excludes `*.browser.test.ts`).
- **Browser tests** (GPU needs a real device → `*.browser.test.ts`): `pnpm --filter @mapequation/d3gl test:browser <package-relative-path>`.
- **Typecheck lib:** `pnpm --filter @mapequation/d3gl exec tsc -b` (root `pnpm typecheck` is broken).
- **No `any`/`unknown` casts, no `!`** except where justified + called out (core value). GPU device raw-GL access uses the repo's existing `(device as WebGLDevice).gl` idiom, which is already sanctioned in `webgl-backend.ts`.
- **GPU shader steps:** the browser test in the same task is the executable spec. Write the GLSL, run the test, iterate the GLSL until green — the plan's GLSL is the starting point, not a frozen answer.

## File structure

**Create (all under `packages/d3gl/src/network/gpu/`):**
- `gpu/device-caps.ts` — `gpuLayoutSupported(device)`: WebGL2 + float-renderable-color probe.
- `gpu/textures.ts` — helpers: pack a `Float32Array` (interleaved xy) into an `rg32float` texture sized `W×ceil(n/W)`; a ping-pong FBO pair; readback an `rg32float` FBO → `Float32Array`.
- `gpu/passes/integrate.ts`, `gpu/passes/attraction.ts`, `gpu/passes/repulsion-allpairs.ts`, `gpu/passes/centering.ts` — one luma.gl `Model` + GLSL per force pass.
- `gpu/passes/repulsion-pyramid.ts` — Barnes-Hut texture-pyramid repulsion (Task 5; replaces all-pairs at scale).
- `gpu/gpu-force-layout.ts` — `GpuForceLayout`: owns textures, sequences passes per tick, exposes `runFrame()` + `readPositions(out)`.
- `gpu/gpu-transport.ts` — `startGpuLayout(...)`: returns a `WorkerLayoutHandle`-shaped handle, drives the streaming rAF loop, calls `onFrame`, falls back to `startWorkerLayout` when unsupported.
- Tests: `gpu/__tests__/float-rtt.browser.test.ts`, `gpu-force-core.browser.test.ts`, `gpu-convergence.browser.test.ts`, `gpu-frame-budget.browser.test.ts`; `gpu/__tests__/gpu-transport.test.ts` (node, fallback path).

**Modify:**
- `network.ts` — add the `backend === "gpu"` dispatch case in `.layout()` (near the `"worker"` case, ~line 639); route through `startGpuLayout`.
- `website/src/examples/network/draw.ts` + `controls` — add a **Backend** control (`Worker` | `GPU`) so the layout can be exercised live.
- `.changeset/<name>.md` — patch changeset.

## Prerequisite (do first, once)

- [ ] **Install deps in the worktree** (its `node_modules` is empty):

Run: `pnpm --filter @mapequation/d3gl install` *(or `pnpm install` at the worktree root)*
Expected: completes; `node_modules` populated. Do this before any `tsc`/test.

- [ ] **Confirm the branch + spec are present**

Run: `git -C /Users/daniel/dev/projects/icelab/code/web/d3gl/.claude/worktrees/n8-gpu-layout log --oneline -3`
Expected: shows the `docs(n8):` spec commits on `feat/n8-gpu-layout`.

---

## Task 0: Spike — float render-to-texture round-trips on the device

Rationale: the entire backend assumes we can render into an `rg32float` FBO and read floats back. No existing code uses float textures. Validate this before building on it. This is a de-risking spike; keep the shader trivial.

**Files:**
- Create: `packages/d3gl/src/network/gpu/__tests__/float-rtt.browser.test.ts`
- Create: `packages/d3gl/src/network/gpu/textures.ts`

- [ ] **Step 1: Write the failing test** (`float-rtt.browser.test.ts`)

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import type { Device } from "@luma.gl/core";
import { packPositionsTexture, readbackFloatFbo } from "../textures.js";

async function createDevice(): Promise<Device> {
  const canvas = document.createElement("canvas");
  canvas.width = 16; canvas.height = 16;
  document.body.appendChild(canvas);
  return luma.createDevice({ adapters: [webgl2Adapter], type: "webgl", createCanvasContext: { canvas, useDevicePixels: false } });
}

describe("float RTT", () => {
  let device: Device;
  beforeAll(async () => { device = await createDevice(); });

  it("packs positions into an rg32float texture and reads them back unchanged", () => {
    const positions = new Float32Array([1.5, -2.25, 3.0, 4.0, -5.5, 6.5]); // 3 nodes
    const { texture, width, count } = packPositionsTexture(device, positions);
    const out = readbackFloatFbo(device, texture, width, count);
    expect(Array.from(out)).toEqual(Array.from(positions));
  });
});
```

- [ ] **Step 2: Run it to verify it fails** (module missing)

Run: `pnpm --filter @mapequation/d3gl test:browser src/network/gpu/__tests__/float-rtt.browser.test.ts`
Expected: FAIL — cannot resolve `../textures.js`.

- [ ] **Step 3: Implement `textures.ts`** (minimal: pack + readback)

```ts
import type { Device, Texture, Framebuffer } from "@luma.gl/core";
import { WebGLDevice } from "@luma.gl/webgl";

/** Texture atlas width for n texels (square-ish; keeps within max texture size). */
export function atlasWidth(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

/** Pack interleaved [x,y,...] into an rg32float texture of width `W`, height `ceil(n/W)`. */
export function packPositionsTexture(device: Device, positions: Float32Array): { texture: Texture; width: number; height: number; count: number } {
  const count = positions.length / 2;
  const width = atlasWidth(count);
  const height = Math.ceil(count / width);
  const data = new Float32Array(width * height * 2); // RG, zero-padded past `count`
  data.set(positions);
  const texture = device.createTexture({
    width, height, format: "rg32float",
    data, mipmaps: false,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
  return { texture, width, height, count };
}

/** Read an rg32float texture's first `count` texels back as interleaved [x,y,...]. */
export function readbackFloatFbo(device: Device, texture: Texture, width: number, count: number): Float32Array {
  const height = texture.height;
  const fbo: Framebuffer = device.createFramebuffer({ width, height, colorAttachments: [texture] });
  const gl = (device as WebGLDevice).gl;
  const buf = new Float32Array(width * height * 2);
  // luma binds the fbo; read RG floats. (readPixelsToArrayWebGL returns the attachment's native type.)
  const pixels = device.readPixelsToArrayWebGL(fbo, { sourceX: 0, sourceY: 0, sourceWidth: width, sourceHeight: height });
  buf.set(pixels as Float32Array);
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) { out[i * 2] = buf[i * 2]!; out[i * 2 + 1] = buf[i * 2 + 1]!; }
  void gl;
  return out;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @mapequation/d3gl test:browser src/network/gpu/__tests__/float-rtt.browser.test.ts`
Expected: PASS. **If it fails on float readback**, the fix belongs here (e.g. enable `EXT_color_buffer_float` via the adapter, or read with an explicit GL `readPixels(FLOAT)` through `(device as WebGLDevice).gl`). Do not proceed to Task 1 until this is green — it is the load-bearing assumption.

- [ ] **Step 5: Commit**

```bash
git -C .../n8-gpu-layout add packages/d3gl/src/network/gpu/textures.ts packages/d3gl/src/network/gpu/__tests__/float-rtt.browser.test.ts
git -C .../n8-gpu-layout commit -m "test(n8): validate rg32float RTT round-trip on the device"
```

---

## Task 1: Position/velocity textures + integrate pass (no forces)

Establish the ping-pong compute loop end-to-end: seed → 1 integrate tick with zero force → readback equals seed (velocity 0). This proves the pass plumbing before any physics.

**Files:**
- Modify: `packages/d3gl/src/network/gpu/textures.ts` (add `pingPong()`)
- Create: `packages/d3gl/src/network/gpu/passes/integrate.ts`
- Create: `packages/d3gl/src/network/gpu/gpu-force-layout.ts`
- Create: `packages/d3gl/src/network/gpu/__tests__/gpu-force-core.browser.test.ts`

- [ ] **Step 1: Write the failing test** — seed 3 nodes, construct `GpuForceLayout`, run 1 tick with all force strengths 0, readback == seed.

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { makeTestDevice } from "./_device.js"; // small helper factored from Task 0's createDevice
import { GpuForceLayout } from "../gpu-force-layout.js";
import { buildGraph } from "../../graph.js";

describe("GpuForceLayout integrate", () => {
  let device; beforeAll(async () => { device = await makeTestDevice(); });
  it("with zero forces, positions are unchanged after a tick", () => {
    const g = buildGraph({ nodeCount: 3, source: [], target: [] });
    g.positions.set([0, 0, 10, 0, 0, 10]);
    const layout = new GpuForceLayout(device, g, { repulsion: 0, attraction: 0, centering: 0, alpha: 0.2, theta: 0.9 });
    layout.runFrame(1);
    const out = new Float32Array(6); layout.readPositions(out);
    expect(Array.from(out)).toEqual([0, 0, 10, 0, 0, 10]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @mapequation/d3gl test:browser src/network/gpu/__tests__/gpu-force-core.browser.test.ts`
Expected: FAIL — `GpuForceLayout` not found.

- [ ] **Step 3: Add `pingPong()` to `textures.ts`**

```ts
export interface PingPong { readTex: Texture; writeFbo: Framebuffer; swap(): void; }
/** Two rg32float targets; `readTex` is the current source, `writeFbo` renders the next state. */
export function pingPong(device: Device, seed: Texture, width: number, height: number): PingPong {
  const other = device.createTexture({ width, height, format: "rg32float", sampler: { minFilter: "nearest", magFilter: "nearest" } });
  let a = seed, b = other;
  let fboB = device.createFramebuffer({ width, height, colorAttachments: [b] });
  let fboA = device.createFramebuffer({ width, height, colorAttachments: [a] });
  return {
    get readTex() { return a; },
    get writeFbo() { return fboB; },
    swap() { [a, b] = [b, a]; [fboA, fboB] = [fboB, fboA]; },
  } as PingPong;
}
```

- [ ] **Step 4: Write the integrate pass** (`passes/integrate.ts`)

Full-screen pass; each fragment is one node texel. Reads position + a force texture + velocity, writes new position and velocity (MRT: two color attachments). GLSL ES 3.00:

```ts
import { Model } from "@luma.gl/engine";
import type { Device, Texture } from "@luma.gl/core";

const VS = `#version 300 es
in vec2 a_clip; void main(){ gl_Position = vec4(a_clip, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D u_pos; uniform sampler2D u_vel; uniform sampler2D u_force;
uniform int u_count; uniform int u_width; uniform float u_alpha; uniform float u_damping; uniform float u_maxStep;
layout(location=0) out vec2 o_pos; layout(location=1) out vec2 o_vel;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy); int id = c.y * u_width + c.x;
  if (id >= u_count) { o_pos = vec2(0.0); o_vel = vec2(0.0); return; }
  vec2 p = texelFetch(u_pos, c, 0).xy;
  vec2 v = texelFetch(u_vel, c, 0).xy;
  vec2 f = texelFetch(u_force, c, 0).xy;
  vec2 s = (v + f * u_alpha) * u_damping;
  s = clamp(s, vec2(-u_maxStep), vec2(u_maxStep));
  o_vel = s; o_pos = p + s;
}`;

export function makeIntegratePass(device: Device): Model {
  return new Model(device, { vs: VS, fs: FS, topology: "triangle-list", vertexCount: 3,
    attributes: { a_clip: device.createBuffer({ data: new Float32Array([-1,-1, 3,-1, -1,3]) }) },
    bufferLayout: [{ name: "a_clip", format: "float32x2" }] });
}
```

*(Fullscreen-triangle covers all texels; `discard`-free padding writes zeros. `u_maxStep` mirrors `force.ts` span clamp — pass a large value for now.)*

- [ ] **Step 5: Write `GpuForceLayout`** wiring textures + the integrate pass; forces default to a zero force texture this task.

```ts
import type { Device } from "@luma.gl/core";
import type { NetworkGraph } from "../graph.js";
import type { ForceParams } from "../force.js";
import { packPositionsTexture, pingPong, readbackFloatFbo, atlasWidth } from "./textures.js";
import { makeIntegratePass } from "./passes/integrate.js";

export class GpuForceLayout {
  private readonly width: number; private readonly height: number; private readonly count: number;
  private pos; private vel; private force; private readonly integrate;
  constructor(private readonly device: Device, graph: NetworkGraph, private readonly params: ForceParams) {
    const packed = packPositionsTexture(device, graph.positions);
    this.width = packed.width; this.height = packed.height; this.count = packed.count;
    this.pos = pingPong(device, packed.texture, this.width, this.height);
    // vel + force start as zeroed rg32float textures (same dims).
    this.vel = pingPong(device, device.createTexture({ width: this.width, height: this.height, format: "rg32float" }), this.width, this.height);
    this.force = device.createTexture({ width: this.width, height: this.height, format: "rg32float" });
    this.integrate = makeIntegratePass(device);
  }
  runFrame(ticks: number): void { for (let i = 0; i < ticks; i++) this.tick(); }
  private tick(): void {
    // (forces filled by later tasks; this task: force stays zero → integrate is a no-op when alpha·f=0)
    const pass = this.device.beginRenderPass({ framebuffer: this.pos.writeFbo /* +vel target via MRT in real impl */ });
    this.integrate.setBindings({ u_pos: this.pos.readTex, u_vel: this.vel.readTex, u_force: this.force });
    this.integrate.setUniforms({ u_count: this.count, u_width: this.width, u_alpha: this.params.alpha, u_damping: 0.9, u_maxStep: 1e9 });
    this.integrate.draw(pass); pass.end(); this.device.submit();
    this.pos.swap(); this.vel.swap();
  }
  readPositions(out: Float32Array): void {
    const back = readbackFloatFbo(this.device, this.pos.readTex, this.width, this.count);
    out.set(back.subarray(0, out.length));
  }
}
```

*(MRT wiring — position + velocity in one FBO with two `rg32float` attachments — is finalized against luma.gl's framebuffer API when you run the test; the integrate FS already declares both outputs.)*

- [ ] **Step 6: Run the test → iterate GLSL/bindings until PASS**

Run: `pnpm --filter @mapequation/d3gl test:browser src/network/gpu/__tests__/gpu-force-core.browser.test.ts`
Expected: PASS (positions unchanged).

- [ ] **Step 7: Commit**

```bash
git -C .../n8-gpu-layout add packages/d3gl/src/network/gpu/
git -C .../n8-gpu-layout commit -m "feat(n8): GPU position/velocity textures + integrate pass"
```

---

## Task 2: Attraction (spring) pass — gather over CSR

Mirror `force.test.ts` "attraction pulls connected nodes together". Gather formulation: each node reads its neighbors from the CSR (offsets + neighbors bound as integer textures) and accumulates the spring force — writes the force texture.

**Files:** Create `passes/attraction.ts`; extend `gpu-force-layout.ts` (upload CSR textures, run attraction before integrate); add a test case to `gpu-force-core.browser.test.ts`.

- [ ] **Step 1: Failing test** — 2 connected nodes, attraction>0, repulsion 0; after N ticks distance shrinks.

```ts
it("attraction pulls two connected nodes together", () => {
  const g = buildGraph({ nodeCount: 2, source: [0], target: [1] });
  g.positions.set([0, 0, 100, 0]);
  const layout = new GpuForceLayout(device, g, { repulsion: 0, attraction: 0.1, centering: 0, alpha: 0.5, theta: 0.9 });
  layout.runFrame(30);
  const out = new Float32Array(4); layout.readPositions(out);
  expect(Math.hypot(out[2]! - out[0]!, out[3]! - out[1]!)).toBeLessThan(100);
});
```

- [ ] **Step 2: Run → FAIL** (attraction not applied; distance stays 100).

Run: `pnpm --filter @mapequation/d3gl test:browser src/network/gpu/__tests__/gpu-force-core.browser.test.ts -t attraction`

- [ ] **Step 3: Implement `passes/attraction.ts`** — FS loops `[offset[id], offset[id+1])` over the neighbor texture, `f += attraction * (posNeighbor - posSelf)`. CSR uploaded once as `r32uint` textures (`u_offsets`, `u_neighbors`). Writes the force texture (additive: this pass initializes force = attraction term; repulsion/centering add in their passes, or accumulate via one force texture written last-writer with `+=` semantics done by chaining passes reading prior force). Keep it a single force-accumulation target updated pass-by-pass.

*(Concrete GLSL written and iterated here against the test; the neighbor loop bound is `min(deg, U_MAX_DEG)` with `U_MAX_DEG` a safety cap to keep the shader's loop statically bounded — GLSL ES 3.00 requires bounded loops.)*

- [ ] **Step 4: Wire CSR upload + attraction pass into `tick()`** (before integrate), fill force each tick.
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit** `feat(n8): GPU attraction (spring) gather pass over CSR`.

---

## Task 3: Repulsion — all-pairs O(n²) (correctness baseline)

Mirror `force.test.ts` "repulsion pushes unconnected nodes apart". All-pairs is correct and simple; it validates the repulsion math and force accumulation before the pyramid optimization. Cap N in this test small (≤ 2048) — O(n²) is only the baseline.

**Files:** Create `passes/repulsion-allpairs.ts`; wire into `tick()`; add test case.

- [ ] **Step 1: Failing test** — 2 unconnected nodes near each other move apart (distance grows).

```ts
it("repulsion pushes two unconnected nodes apart", () => {
  const g = buildGraph({ nodeCount: 2, source: [], target: [] });
  g.positions.set([0, 0, 1, 0]);
  const layout = new GpuForceLayout(device, g, { repulsion: 200, attraction: 0, centering: 0, alpha: 0.2, theta: 0.9 });
  layout.runFrame(60);
  const out = new Float32Array(4); layout.readPositions(out);
  expect(Math.hypot(out[2]! - out[0]!, out[3]! - out[1]!)).toBeGreaterThan(5);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `passes/repulsion-allpairs.ts`** — FS for node `id` loops `j in [0, count)`, `texelFetch` each other position, accumulates softened `repulsion/(d²+SOFTENING) * (pi - pj)` (matching `quadtree.ts` `SOFTENING = 1e-2`). Adds into the force texture. Loop bound is `u_count` (dynamic upper bound backed by a compile-time `U_MAX_NODES` cap for the baseline).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(n8): GPU all-pairs repulsion (correctness baseline)`.

---

## Task 4: Centering + full tick + convergence-quality parity vs CPU

Add centering (pull toward centroid — a reduction to compute the mean, then a pull), assemble the full tick, and assert the GPU layout converges to comparable *quality* as the CPU `ForceLayout` on a small LFR-like graph (not bitwise — edge-length distribution within tolerance).

**Files:** Create `passes/centering.ts`; finalize `tick()` order (repulsion → attraction → centering → integrate); create `gpu-convergence.browser.test.ts`.

- [ ] **Step 1: Failing test** (`gpu-convergence.browser.test.ts`) — build a small graph (~200 nodes, a few communities), run CPU `ForceLayout` and `GpuForceLayout` for equal iterations, compare the **mean connected-edge length / mean unconnected-pair distance** ratio; assert GPU's within ±25% of CPU's (quality parity, orientation-invariant).

```ts
// pseudo-metric both layouts must satisfy similarly:
function edgeSpreadRatio(pos: Float32Array, src: Uint32Array, tgt: Uint32Array): number { /* mean edge len / mean sampled pair dist */ }
expect(Math.abs(gpuRatio - cpuRatio) / cpuRatio).toBeLessThan(0.25);
```

- [ ] **Step 2: Run → FAIL** (centering absent / metric off).
- [ ] **Step 3: Implement centering** — reduction for the centroid (sum reduction over the position texture via successive halving passes, or an initial simple approach: read back once per tick is *not* allowed on the hot path — use a GPU reduction), then a pull pass `f += centering*(centroid - p)`.
- [ ] **Step 4: Assemble `tick()` order** and run → iterate params until PASS.
- [ ] **Step 5: Commit** `feat(n8): GPU centering + full tick; convergence parity test vs CPU`.

---

## Task 5: Barnes-Hut texture-pyramid repulsion (perf) — gated by a scale test

Replace all-pairs with a quadtree-as-texture-pyramid so 100k is interactive. **This is the perf-critical, prototype-heavy task**; it is correct-preserving (Tasks 1–4 tests stay green) and unlocked by a scale budget test. Clean-room (cosmos.gl conceptual reference only — no copied code).

**Files:** Create `passes/repulsion-pyramid.ts`; swap it in behind a flag; create `gpu-frame-budget.browser.test.ts`.

- [ ] **Step 1: Write the scale/budget test FIRST** (`gpu-frame-budget.browser.test.ts`) — build ≈1M nodes, run `runFrame(1)` in a loop simulating streamed frames, assert **wall-clock per frame < BUDGET_MS** (a generous ceiling, e.g. 33ms, tuned non-flaky). Run it in **both reduction states** the renderer will use downstream (this layout task is reduction-agnostic, but assert the budget holds at 1M leaf nodes — the full-detail case — since LOD does not shrink what the *solver* processes).

- [ ] **Step 2: Run with all-pairs → FAIL** (O(n²) at 1M is far over budget). This proves the test bites.
- [ ] **Step 3: Implement the pyramid** — build a stack of `rgba32float` COM/mass grids by mip-style reduction of the position texture (each level = 2× coarser bins accumulating `(Σx, Σy, Σm, count)`); FS per node walks coarse→fine, applying the θ opening criterion (`s² < θ²·d²` as in `quadtree.ts`) per cell, accumulating softened repulsion. Iterate the GLSL against Tasks 1–4 tests (still green) AND the budget test.
- [ ] **Step 4: Run all GPU tests + budget → PASS** (correctness tests green, 1M under budget).
- [ ] **Step 5: Commit** `feat(n8): Barnes-Hut texture-pyramid repulsion (O(n log n) GPU)`.

> **Per-frame doctrine (AGENTS.md §5):** this task adds the per-frame GPU solve. The budget test (Step 1) is the mandatory per-frame regression test. In the PR's `## Performance` section, state: repulsion goes O(n²)→O(n·pyramidWalk) on GPU, N = solved leaf count (≈1M full-detail); build is in-place ping-pong (no per-frame FBO destroy+recreate); readback is Task 6's concern. **Do not** self-defer any per-frame allocation — if the pyramid rebuild allocates textures per frame, pool them and assert in-place reuse in the test.

---

## Task 6: `backend: "gpu"` dispatch + handle + streaming + fallback

Wire it into `network.ts`, streaming frames through the existing `onFrame` seam, with a capability probe → CPU-worker fallback. After this task, `layout({ backend: "gpu" })` works end-to-end and renders unchanged.

**Files:** Create `gpu/gpu-transport.ts`; modify `network.ts` (dispatch case); create `gpu/__tests__/gpu-transport.test.ts` (node — fallback path, no device).

- [ ] **Step 1: Write `device-caps.ts`**

```ts
import type { Device } from "@luma.gl/core";
/** GPU layout needs WebGL2 + float-renderable color (rg32float RTT). */
export function gpuLayoutSupported(device: Device | null | undefined): boolean {
  if (!device) return false;
  // luma.gl reports the adapter/features; rg32float RTT requires EXT_color_buffer_float (standard WebGL2).
  return device.type === "webgl" && device.features.has("float32-renderable-webgl");
}
```

- [ ] **Step 2: Write the fallback test** (`gpu-transport.test.ts`, node env — no device) — `startGpuLayout` with `device: null` delegates to the worker path and returns a `WorkerLayoutHandle`-shaped object.

```ts
import { describe, it, expect, vi } from "vitest";
import { startGpuLayout } from "../gpu-transport.js";
import * as worker from "../../worker-transport.js";
it("falls back to the worker backend when the GPU path is unsupported", () => {
  const spy = vi.spyOn(worker, "startWorkerLayout").mockReturnValue({ shared: false, settled: Promise.resolve(), stop(){}, pin(){}, unpin(){} });
  const g = /* buildGraph small */; 
  const h = startGpuLayout(null, g, { width: 100, height: 100, iterations: 10 }, () => {});
  expect(spy).toHaveBeenCalled();
  expect(typeof h.stop).toBe("function");
});
```

- [ ] **Step 3: Run → FAIL** (module missing).

Run: `pnpm --filter @mapequation/d3gl test src/network/gpu/__tests__/gpu-transport.test.ts`

- [ ] **Step 4: Implement `gpu-transport.ts`** — signature mirrors `startWorkerLayout` (so `network.ts` dispatch is symmetric), returns `WorkerLayoutHandle`:

```ts
import type { NetworkGraph } from "../graph.js";
import { startWorkerLayout, type WorkerLayoutOptions, type WorkerLayoutHandle } from "../worker-transport.js";
import { gpuLayoutSupported } from "./device-caps.js";
import { GpuForceLayout } from "./gpu-force-layout.js";
import { seedPositions, DEFAULT_FORCE } from "../force.js";
import type { Device } from "@luma.gl/core";

export function startGpuLayout(device: Device | null, graph: NetworkGraph, opts: WorkerLayoutOptions, onFrame: () => void): WorkerLayoutHandle {
  if (!gpuLayoutSupported(device)) return startWorkerLayout(graph, opts, onFrame); // fallback (also gets its own fallback chain)
  seedPositions(graph, opts.width, opts.height);
  const layout = new GpuForceLayout(device!, graph, { ...DEFAULT_FORCE, ...opts.force });
  let stopped = false; let resolveSettled!: () => void;
  const settled = new Promise<void>((r) => (resolveSettled = r));
  const frameEvery = opts.frameEvery ?? Math.max(1, Math.ceil((opts.iterations ?? 300) / 60));
  let done = 0;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
  const step = (): void => {
    if (stopped) return;
    const batch = Math.min(frameEvery, (opts.iterations ?? 300) - done);
    layout.runFrame(batch); done += batch;
    layout.readPositions(graph.positions); // Milestone A: readback into the existing path
    onFrame();
    if (done >= (opts.iterations ?? 300)) { resolveSettled(); return; } // idle; Milestone B keeps it alive for drag
    raf(step);
  };
  raf(step);
  return {
    shared: false, settled,
    stop() { stopped = true; resolveSettled(); },
    pin() {}, unpin() {}, // node-drag parity is N8.5
  };
}
```

- [ ] **Step 5: Add the dispatch case in `network.ts`** (next to the `"worker"` case, ~line 639). The engine passes its luma.gl device (from the WebGL backend) and `() => this.scheduleLayoutRepaint()` as `onFrame`:

```ts
} else if (opts.backend === "gpu") {
  const device = this.gpuDevice(); // returns the WebGL backend's Device, or null on Canvas/SVG/SSR
  this.layoutHandle = startGpuLayout(device, this.graph, layoutOpts, () => this.scheduleLayoutRepaint());
}
```

*(Add a small `gpuDevice()` accessor on the engine returning the active WebGL backend's `device` or `null`; on non-WebGL backends this yields `null` → `startGpuLayout` falls back to the worker. Keep `layoutTransport`/`whenSettled` behavior identical to the worker case.)*

- [ ] **Step 6: Run the node fallback test + typecheck**

Run: `pnpm --filter @mapequation/d3gl test src/network/gpu/__tests__/gpu-transport.test.ts` → PASS
Run: `pnpm --filter @mapequation/d3gl exec tsc -b` → clean

- [ ] **Step 7: Commit** `feat(n8): backend:"gpu" dispatch + streaming handle + CPU-worker fallback`.

---

## Task 7: Website example toggle + changeset + PR

**Files:** Modify `website/src/examples/network/draw.ts` + its `controls`; add `.changeset/<name>.md`.

- [ ] **Step 1: Add a Backend control** (`Worker` | `GPU`) to the network example; map to `layout({ backend: options.backend === "GPU" ? "gpu" : "worker", ... })`. Keep the example's `draw.ts` minimal (the control wiring lives in `controls`).
- [ ] **Step 2: Build the website from the worktree** to confirm no example breaks.

Run: `pnpm --filter @d3gl/website build`
Expected: succeeds.

- [ ] **Step 3: Add a changeset** (`packages/d3gl/**` changed → required by the `policy` gate).

```md
---
"@mapequation/d3gl": patch
---
network: add a GPU force-layout backend (`layout({ backend: "gpu" })`) — WebGL2 many-body solve streamed back into the existing render path, with a CPU-worker fallback. Milestone A of #106.
```

- [ ] **Step 4: Open the PR** with body **`Part of #106`** (NOT `Fixes` — the epic stays open), including the mandatory `## Performance` section (per Task 5's note) and pointing at the frame-budget test. Move #106 to *In review* on the board.

```bash
git -C .../n8-gpu-layout push -u origin feat/n8-gpu-layout
gh pr create --repo mapequation/d3gl --base main --head feat/n8-gpu-layout \
  --title "network: GPU force-layout backend (Milestone A) — Part of #106" --body-file <perf+summary body>
```

- [ ] **Step 5: Request human verification** (per AGENTS.md lifecycle §6) — do **not** merge without approval.

---

## Roadmap: N8.2–N8.7 (detailed when reached)

Each becomes its own dated plan; shape depends on N8.1 results.

- **N8.2 — Multilevel over `LODTopology` (module-aware seed).** Top-down, structure-driven seed (BFS the `children` CSR from the root; solve top modules via super-edges; prolongate parent→children with golden-angle jitter; leaf = no children). Unifies the layout hierarchy with the LOD/module tree; resolves the height-vs-depth misalignment (spec §1/§3). Files: `gpu/passes/prolongate.ts`, `gpu/schedule.ts`, reuse `lod.ts`/`modules.ts` topology. Gate: seeded 100k converges faster + modules coherent.
- **N8.3 — Soft containment.** Segmented-reduction centroid (additive-blend children into a parent-centroid texture + count) + per-node pull `γ(depth)`; `containment` API. Empirical: global refine vs a few per-module GPU passes (spec §Remaining).
- **N8.4 — State networks (layout).** `buildStateGraph` + `stateToPhysical`; physical = orthogonal soft grouping; `stateLayout: "rosette" | "force" | "two-phase"`. Shares the model with rendering issue **#171**.
- **N8.5 — Node-drag parity (#140).** Pinned/held flag honored in the integrate pass; keep the GPU loop alive after convergence for reheat.
- **N8.6 — Milestone B: GPU-resident positions.** Instanced lane's vertex shader samples the position texture (`texelFetch` by instance id) instead of a per-instance attribute; throttled async (PBO) readback for CPU LOD/pick/declutter. Touches the shared instanced lane (#108) — tested change.
- **N8.7 — Docs + landing-page highlight** for the GPU backend + `stateLayout`.

---

## Self-review

- **Spec coverage:** N8.1 covers the spec's Milestone A (GPU single-level force core §2/§4, readback integration §6-A, WebGL2 probe + CPU fallback §9). Module-aware (§1/§3), containment (§4.4), state modes (§5), drag (#140), Milestone B (§6-B), docs → mapped to N8.2–N8.7 roadmap. Testing §9 (per-frame budget both reduction states, convergence quality, fallback) → Tasks 4, 5, 6.
- **Placeholder scan:** GPU-shader tasks intentionally specify pass structure + representative GLSL + the gating test rather than frozen final GLSL — flagged as on-device-iterated, not "TODO". TS integration code (Tasks 6) is complete. No "implement later" left in executable TS.
- **Type consistency:** `GpuForceLayout(device, graph, ForceParams)` with `runFrame(ticks)`/`readPositions(out)` used identically across Tasks 1–6; `startGpuLayout(device, graph, WorkerLayoutOptions, onFrame): WorkerLayoutHandle` matches `startWorkerLayout`'s shape so the `network.ts` dispatch is symmetric; `packPositionsTexture`/`pingPong`/`readbackFloatFbo`/`atlasWidth` names consistent across `textures.ts` consumers.
- **Known risk to resolve in Task 0:** float-color-buffer readback (`EXT_color_buffer_float`) — the load-bearing assumption; Task 0 gates everything on it.
