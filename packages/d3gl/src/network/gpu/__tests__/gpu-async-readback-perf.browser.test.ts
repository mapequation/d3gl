/**
 * Per-frame guard for the streaming layout's position readback (#352, spec §6.5.2).
 *
 * The GPU transport copies all N positions into one raw `STREAM_READ` PBO in one frame and harvests them
 * into `graph.positions` in a later frame, once a fence after the copy has signalled. This drives that
 * exact pair (`AsyncPositionReadback.issue` → fence → `harvest`) at a realistic N on both read formats: a
 * device that reads `rg32f` as `RG/FLOAT` (the copy reads the position texture itself) and one that reads
 * it only as `RGBA/FLOAT` (the pack pass writes a staging texture first). It pins the deterministic
 * signature: exact positions and stats, the PBO's usage is `STREAM_READ`, every `readPixels` of the
 * copy targets the bound PBO (a numeric offset, never a CPU array), no GPU object is created per readback,
 * and a non-finite layout leaves the last positions untouched. Wall-clock ceilings bound the main thread
 * of the copy (it must not wait for the GPU) and of the harvest (a memcpy of 8·N bytes).
 *
 * The layout reads every node back whatever the LOD state, so the LOD on/off split does not apply here.
 */
import { describe, it, expect, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { WebGLDevice } from "@luma.gl/webgl";
import { makeTestDevice } from "./_device.js";
import { makeRgbaReadDevice } from "./_rgba-read-device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { AsyncPositionReadback, READBACK_STATS_FLOATS } from "../async-readback.js";
import { DEFAULT_FORCE, type LayoutGraph } from "../../force.js";
import { deleteSync, insertSync, pollSync } from "../../../webgl/fence.js";
import { perfBudget, perfN } from "../../../__tests__/perf-budget.js";

const LOCAL_N = 1_000_000; // the N the ceilings below were calibrated at
// Capped as the synchronous readback guard: ~85 B/node of GPU textures and JS arrays.
const N = perfN(LOCAL_N, { max: 4_000_000 });
const REPEATS = 5;

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** web-NotreDame-extent positions from a fixed LCG. */
function seedPositions(n: number): Float32Array {
  const positions = new Float32Array(n * 2);
  let s = 0x5eed >>> 0;
  for (let i = 0; i < positions.length; i++) {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    positions[i] = (s / 0x100000000 - 0.5) * 36_000;
  }
  return positions;
}

function edgeless(positions: Float32Array): LayoutGraph {
  return { nodeCount: positions.length / 2, edgeCount: 0, source: new Uint32Array(0), target: new Uint32Array(0), positions };
}

/**
 * Every `readPixels` on `gl` while installed: whether a PBO offset (a number) was its destination. Wraps
 * whatever `readPixels` is installed now (the RGBA device's own spy included) and puts it back after.
 */
function readPixelsSpy(gl: WebGL2RenderingContext) {
  const proto = WebGL2RenderingContext.prototype;
  const installed = proto.readPixels;
  const toPbo: boolean[] = [];
  Object.defineProperty(proto, "readPixels", {
    configurable: true,
    writable: true,
    value: function (this: WebGL2RenderingContext, ...args: unknown[]) {
      if (this === gl) toPbo.push(typeof args[6] === "number");
      Reflect.apply(installed, this, args);
    },
  });
  return {
    toPbo,
    restore: () => Object.defineProperty(proto, "readPixels", { configurable: true, writable: true, value: installed }),
  };
}

/** Wait (over animation frames) until `sync` has signalled; fails after 300 frames. */
async function waitSync(gl: WebGL2RenderingContext, sync: WebGLSync | null): Promise<void> {
  for (let f = 0; f < 300; f++) {
    await nextFrame();
    const status = pollSync(gl, sync);
    if (status === "signaled") return;
    expect(status).not.toBe("lost");
  }
  throw new Error("fence never signalled");
}

interface Measured {
  issueMs: number;
  harvestMs: number;
}

/**
 * A GpuForceLayout over the seed (edge-less, so its read side is the uploaded seed), one `beginTick` so
 * the segment table holds the seed's stats, then REPEATS readbacks through one AsyncPositionReadback.
 */
async function measure(device: Device, seed: Float32Array): Promise<Measured> {
  if (!(device instanceof WebGLDevice)) throw new Error("expected a WebGL2 device");
  const gl = device.gl;
  const n = seed.length / 2;
  const layout = new GpuForceLayout(device, edgeless(seed.slice()), DEFAULT_FORCE);
  layout.beginTick(); // stats (Σx, Σy, Σ|v|, count) and box of the seed, as a streamed tick leaves them
  const readback = new AsyncPositionReadback(device, layout);

  // Warm-up readback (first-use costs: the pack program, the first transfer).
  readback.issue(layout);
  const sync0 = insertSync(gl);
  await waitSync(gl, sync0);
  deleteSync(gl, sync0);
  const stats = new Float32Array(READBACK_STATS_FLOATS);
  expect(readback.harvest(new Float32Array(n * 2), stats)).toBe(true);

  const createTexture = vi.spyOn(device, "createTexture");
  const createFramebuffer = vi.spyOn(device, "createFramebuffer");
  const createBuffer = vi.spyOn(WebGL2RenderingContext.prototype, "createBuffer");
  const reads = readPixelsSpy(gl);
  const out = new Float32Array(n * 2);
  let issueMs = Infinity;
  let harvestMs = Infinity;
  try {
    for (let r = 0; r < REPEATS; r++) {
      out.fill(0);
      const t0 = performance.now();
      readback.issue(layout);
      issueMs = Math.min(issueMs, performance.now() - t0);
      expect(readback.pending).toBe(true);
      const sync = insertSync(gl);
      await waitSync(gl, sync);
      deleteSync(gl, sync);
      const t1 = performance.now();
      expect(readback.harvest(out, stats)).toBe(true);
      harvestMs = Math.min(harvestMs, performance.now() - t1);
      expect(readback.pending).toBe(false);
    }
    // Deterministic signature: nothing created per readback; every copy lands in the PBO.
    expect(createTexture).toHaveBeenCalledTimes(0);
    expect(createFramebuffer).toHaveBeenCalledTimes(0);
    expect(createBuffer).toHaveBeenCalledTimes(0);
    // One readPixels per PBO per copy (positions; the stats pair) — Chrome keeps its readback shadow
    // copy only for a buffer written once before its fence.
    expect(reads.toPbo.length).toBe(REPEATS * 2);
    expect(reads.toPbo.every(Boolean)).toBe(true);
  } finally {
    createTexture.mockRestore();
    createFramebuffer.mockRestore();
    createBuffer.mockRestore();
    reads.restore();
  }

  // Exact positions, in node order.
  let mismatches = 0;
  for (let i = 0; i < n * 2; i++) if (out[i] !== seed[i]) mismatches++;
  expect(mismatches).toBe(0);
  // The stats tail: count exactly, the box exactly (min/max are exact), the sums within float32 rounding.
  let sx = 0, sy = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = seed[i * 2] ?? 0, y = seed[i * 2 + 1] ?? 0;
    sx += x; sy += y;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  expect(stats[3]).toBe(n);
  expect(stats[2]).toBe(0); // no tick integrated yet: every velocity is zero
  expect([stats[4], stats[5], stats[6], stats[7]]).toEqual([maxX, maxY, -minX, -minY]);
  const sumTol = 1e-4 * n * 18_000; // ≫ the tree's D·ε·Σ|x| bound, ≪ one node's contribution × n
  expect(Math.abs((stats[0] ?? 0) - sx)).toBeLessThan(sumTol);
  expect(Math.abs((stats[1] ?? 0) - sy)).toBeLessThan(sumTol);

  readback.destroy();
  layout.destroy();
  return { issueMs, harvestMs };
}

describe("GPU streaming readback per frame (#352)", () => {
  // Calibrated at 1M on M1 Max (local headless Chromium), min-of-5: issue 0.0-0.1 ms on both paths,
  // harvest 0.6-0.8 ms. The synchronous readback it replaces took 1.8-2.0 ms (RG) / 5.0-5.3 ms (RGBA) at
  // 1M with an idle GPU — and in a streamed frame it also waits for every queued tick. The copy only
  // records a GPU → PBO transfer, so its ceiling is constant-dominant and below the synchronous 1M read;
  // the harvest is a memcpy of 8 B per node, so its ceiling is linear. The deterministic signature (PBO
  // destination, STREAM_READ, no allocation) is what pins the regression at any N.
  const ISSUE_CEILING_MS = perfBudget(1 + 0.5 * (N / LOCAL_N));
  const HARVEST_CEILING_MS = perfBudget(1 + 5 * (N / LOCAL_N));

  it("RG/FLOAT: copies the position texture into the PBO and harvests exact positions and stats", async () => {
    const seed = seedPositions(N);
    const device = await makeTestDevice();
    try {
      const { issueMs, harvestMs } = await measure(device, seed);
      console.log(`  GPU async readback: N=${N} RG/FLOAT issue ${issueMs.toFixed(2)}ms, harvest ${harvestMs.toFixed(2)}ms (min-of-${REPEATS})`);
      expect(issueMs).toBeLessThan(ISSUE_CEILING_MS);
      expect(harvestMs).toBeLessThan(HARVEST_CEILING_MS);
    } finally {
      device.destroy();
    }
  }, 120_000);

  it("RGBA/FLOAT: packs positions into node order first, never asks for RG/FLOAT", async () => {
    const seed = seedPositions(N);
    const rgba = await makeRgbaReadDevice();
    try {
      const { issueMs, harvestMs } = await measure(rgba.device, seed);
      expect(rgba.rejectedRgReads()).toBe(0);
      console.log(`  GPU async readback: N=${N} RGBA/FLOAT (packed) issue ${issueMs.toFixed(2)}ms, harvest ${harvestMs.toFixed(2)}ms (min-of-${REPEATS})`);
      expect(issueMs).toBeLessThan(ISSUE_CEILING_MS);
      expect(harvestMs).toBeLessThan(HARVEST_CEILING_MS);
    } finally {
      rgba.device.destroy();
      rgba.restore();
    }
  }, 120_000);

  it("creates its PBOs with STREAM_READ usage", async () => {
    const device = await makeTestDevice();
    if (!(device instanceof WebGLDevice)) throw new Error("expected a WebGL2 device");
    const gl = device.gl;
    const created: WebGLBuffer[] = [];
    const createBuffer = gl.createBuffer;
    const spy = vi.spyOn(WebGL2RenderingContext.prototype, "createBuffer").mockImplementation(function (this: WebGL2RenderingContext) {
      const buffer = createBuffer.call(this);
      if (this === gl && buffer) created.push(buffer);
      return buffer;
    });
    const layout = new GpuForceLayout(device, edgeless(seedPositions(1000)), DEFAULT_FORCE);
    created.length = 0; // the layout's own buffers are luma's; only the readback's is raw
    const readback = new AsyncPositionReadback(device, layout);
    spy.mockRestore();
    readback.issue(layout); // the first copy sizes the storage, in the same fence window as its write
    try {
      expect(created.length).toBe(2); // the position PBO and the 32-byte stats PBO
      for (const pbo of created) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        expect(gl.getBufferParameter(gl.PIXEL_PACK_BUFFER, gl.BUFFER_USAGE)).toBe(gl.STREAM_READ);
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    } finally {
      readback.destroy();
      layout.destroy();
      device.destroy();
    }
  });

  it("refuses a non-finite layout without touching the positions", async () => {
    const device = await makeTestDevice();
    if (!(device instanceof WebGLDevice)) throw new Error("expected a WebGL2 device");
    const gl = device.gl;
    const seed = seedPositions(1000);
    const layout = new GpuForceLayout(device, edgeless(seed.slice()), DEFAULT_FORCE);
    layout.setHeldPositions(Uint32Array.of(17), new Float32Array([Number.NaN, 0]));
    layout.beginTick(); // Σx is now NaN
    const readback = new AsyncPositionReadback(device, layout);
    try {
      readback.issue(layout);
      const sync = insertSync(gl);
      await waitSync(gl, sync);
      deleteSync(gl, sync);
      const out = new Float32Array(2000).fill(7);
      const stats = new Float32Array(READBACK_STATS_FLOATS);
      expect(readback.harvest(out, stats)).toBe(false);
      expect(Number.isNaN(stats[0] ?? 0)).toBe(true);
      expect(out.every((v) => v === 7)).toBe(true);
      expect(readback.pending).toBe(false);
    } finally {
      readback.destroy();
      layout.destroy();
      device.destroy();
    }
  });
});
