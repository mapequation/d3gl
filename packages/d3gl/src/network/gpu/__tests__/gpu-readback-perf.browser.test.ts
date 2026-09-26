/**
 * Per-frame guard for the GPU layout's position readback formats (#351).
 *
 * Every streamed GPU frame reads all N positions back (`GpuForceLayout.readPositions`). Where
 * `RG/FLOAT` is not the implementation read format, it reads `RGBA/FLOAT` into a retained scratch and
 * compacts it: twice the bytes plus an O(N) loop over all layout nodes. That path is new per-frame work
 * on those devices, so this guard bounds it at a realistic N (AGENTS lifecycle §5) and pins its
 * deterministic signature: exact positions, and no texture/framebuffer created per readback.
 *
 * The layout solver reads every node back whatever the LOD state, so the LOD on/off split does not
 * apply to this path (as for `gpu-frame-budget-perf`).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Device, Framebuffer, Texture } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { packPositionsTexture, readbackFloatFboReuse } from "../textures.js";
import { readsRG } from "../device-probe.js";
import { perfBudget, perfN } from "../../../__tests__/perf-budget.js";

const LOCAL_N = 1_000_000; // the N the ceilings below were calibrated at
// Capped: one rg32f atlas plus the RGBA scratch is 24 B/node; 4M nodes is ~100 MB of test fixture.
const N = perfN(LOCAL_N, { max: 4_000_000 });
const REPEATS = 5;

describe("GPU position readback per frame (#351)", () => {
  let device: Device;
  let texture: Texture;
  let fbo: Framebuffer;
  let positions: Float32Array;
  let width = 0;
  let height = 0;

  beforeAll(async () => {
    device = await makeTestDevice();
    positions = new Float32Array(N * 2);
    let s = 0x5eed >>> 0;
    for (let i = 0; i < positions.length; i++) {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      positions[i] = (s / 0x100000000 - 0.5) * 36_000; // web-NotreDame's layout extent
    }
    const packed = packPositionsTexture(device, positions);
    texture = packed.texture;
    width = packed.width;
    height = packed.height;
    fbo = device.createFramebuffer({ width, height, colorAttachments: [texture] });
  });

  afterAll(() => {
    fbo.destroy();
    texture.destroy();
    device.destroy();
  });

  /** Min-of-REPEATS wall time of one readback after a warm-up, and the last result. */
  function time(read: () => Float32Array): { ms: number; out: Float32Array } {
    let out = read(); // warm-up
    let ms = Infinity;
    for (let r = 0; r < REPEATS; r++) {
      const t0 = performance.now();
      out = read();
      ms = Math.min(ms, performance.now() - t0);
    }
    return { ms, out };
  }

  it("the RGBA/FLOAT fallback stays within its per-frame budget and returns exact positions", () => {
    const rgba = new Float32Array(width * height * 4); // retained, as GpuForceLayout keeps it
    const fboSpy = vi.spyOn(device, "createFramebuffer");
    const texSpy = vi.spyOn(device, "createTexture");
    const viaRgba = time(() => readbackFloatFboReuse(device, fbo, width, N, rgba));
    // Deterministic signature: nothing allocated on the GPU per readback.
    expect(fboSpy).toHaveBeenCalledTimes(0);
    expect(texSpy).toHaveBeenCalledTimes(0);
    fboSpy.mockRestore();
    texSpy.mockRestore();
    expect(viaRgba.out.length).toBe(N * 2);
    let mismatches = 0;
    for (let i = 0; i < N * 2; i++) if (viaRgba.out[i] !== positions[i]) mismatches++;
    expect(mismatches).toBe(0);

    let rgNote = "RG/FLOAT not the read format on this device";
    if (readsRG(device, fbo)) {
      const viaRg = time(() => readbackFloatFboReuse(device, fbo, width, N));
      rgNote = `RG/FLOAT min-of-${REPEATS}=${viaRg.ms.toFixed(1)}ms`;
    }
    // Calibrated at 1M on M1 Max / ANGLE Metal (headless Chromium): RGBA 6.4-6.6 ms, RG 4.2-5.0 ms. ~9×
    // headroom, split into a constant (the synchronous readPixels round trip) and a linear term (bytes
    // moved + the compaction loop), so a per-call scratch allocation or a slow per-element path trips it.
    const CEILING_MS = perfBudget(5 + 55 * (N / LOCAL_N));
    console.log(`  GPU readback: N=${N} RGBA/FLOAT min-of-${REPEATS}=${viaRgba.ms.toFixed(1)}ms (ceiling ${CEILING_MS.toFixed(0)}ms); ${rgNote}`);
    expect(viaRgba.ms).toBeLessThan(CEILING_MS);
  });
});
