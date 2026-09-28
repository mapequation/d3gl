/**
 * Per-frame guard for the GPU layout's position readback (#351).
 *
 * Every streamed GPU frame reads all N positions back through `GpuForceLayout.readPositions` (the call
 * the GPU transport's frame loop makes). Where `RG/FLOAT` is not the implementation read format, it reads
 * `RGBA/FLOAT` into a retained scratch and compacts it: twice the bytes plus an O(N) loop over all layout
 * nodes. That path is new per-frame work on those devices, so this guard drives the real call at a
 * realistic N on a device that reads `rg32f` only as `RGBA/FLOAT` (`makeRgbaReadDevice`), and on a plain
 * device for the `RG/FLOAT` path the measured hardware takes (AGENTS lifecycle §5). It pins the
 * deterministic signature on both: exact positions, no texture or framebuffer created per readback, one
 * `readPixels` per readback, and on the `RGBA/FLOAT` path the same retained scratch every time and no
 * `RG/FLOAT` read attempted.
 *
 * The layout solver reads every node back whatever the LOD state, so the LOD on/off split does not
 * apply to this path (as for `gpu-frame-budget-perf`).
 */
import { describe, it, expect, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { makeRgbaReadDevice } from "./_rgba-read-device.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { DEFAULT_FORCE, type LayoutGraph } from "../../force.js";
import { perfBudget, perfN } from "../../../__tests__/perf-budget.js";

const LOCAL_N = 1_000_000; // the N the ceilings below were calibrated at
// Capped: the per-node GPU textures (45 B) plus the JS seed, positions, output and RGBA scratch (40 B) are
// ~85 B/node; 4M nodes is ~340 MB.
const N = perfN(LOCAL_N, { max: 4_000_000 });
const REPEATS = 5;

/** web-NotreDame-extent positions from a fixed LCG. */
function seedPositions(): Float32Array {
  const positions = new Float32Array(N * 2);
  let s = 0x5eed >>> 0;
  for (let i = 0; i < positions.length; i++) {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    positions[i] = (s / 0x100000000 - 0.5) * 36_000;
  }
  return positions;
}

interface Readback {
  /** Min-of-REPEATS wall time of one `readPositions`, after a warm-up. */
  ms: number;
  /** The `target` each `readPixelsToArrayWebGL` call wrote into (undefined: luma allocated one). */
  targets: (ArrayBufferView | undefined)[];
}

/**
 * Build an edge-less N-node GpuForceLayout on `device` (its read side is the uploaded seed), time
 * `readPositions` and check the signature every path shares.
 */
function measure(device: Device, seed: Float32Array): Readback {
  const graph: LayoutGraph = {
    nodeCount: N,
    edgeCount: 0,
    source: new Uint32Array(0),
    target: new Uint32Array(0),
    positions: seed.slice(),
  };
  const layout = new GpuForceLayout(device, graph, DEFAULT_FORCE);
  const out = new Float32Array(N * 2);
  const fboSpy = vi.spyOn(device, "createFramebuffer");
  const texSpy = vi.spyOn(device, "createTexture");
  const readSpy = vi.spyOn(device, "readPixelsToArrayWebGL");
  layout.readPositions(out); // warm-up
  let ms = Infinity;
  for (let r = 0; r < REPEATS; r++) {
    out.fill(0);
    const t0 = performance.now();
    layout.readPositions(out);
    ms = Math.min(ms, performance.now() - t0);
  }
  const targets = readSpy.mock.calls.map((call) => call[1]?.target);
  // Deterministic signature: nothing allocated on the GPU, one readPixels per readback.
  expect(fboSpy).toHaveBeenCalledTimes(0);
  expect(texSpy).toHaveBeenCalledTimes(0);
  expect(readSpy).toHaveBeenCalledTimes(REPEATS + 1);
  fboSpy.mockRestore();
  texSpy.mockRestore();
  readSpy.mockRestore();
  let mismatches = 0;
  for (let i = 0; i < N * 2; i++) if (out[i] !== seed[i]) mismatches++;
  expect(mismatches).toBe(0);
  layout.destroy();
  return { ms, targets };
}

describe("GPU position readback per frame (#351)", () => {
  // Calibrated at 1M on M1 Max / ANGLE Metal (headless Chromium), readPositions min-of-5: RGBA/FLOAT
  // 5.0-5.3 ms, RG/FLOAT 1.8-2.0 ms. The ceiling (the original ~9× over the RGBA path) is split into a
  // constant (the synchronous readPixels round trip) and a linear term (bytes moved + the compaction
  // loop), so a slow per-element path trips it; the scratch-identity assertion catches a per-call allocation.
  const CEILING_MS = perfBudget(5 + 55 * (N / LOCAL_N));

  it("RGBA/FLOAT: GpuForceLayout.readPositions stays within budget through one retained scratch", async () => {
    const seed = seedPositions();
    const rgba = await makeRgbaReadDevice();
    try {
      const { ms, targets } = measure(rgba.device, seed);
      expect(rgba.rejectedRgReads()).toBe(0); // never asked for RG/FLOAT
      // One scratch, allocated at construction and reused by every readback.
      const scratch = targets[0];
      expect(scratch).toBeInstanceOf(Float32Array);
      expect(targets.every((t) => t === scratch)).toBe(true);
      console.log(`  GPU readback: N=${N} RGBA/FLOAT readPositions min-of-${REPEATS}=${ms.toFixed(1)}ms (ceiling ${CEILING_MS.toFixed(0)}ms)`);
      expect(ms).toBeLessThan(CEILING_MS);
    } finally {
      rgba.device.destroy();
      rgba.restore();
    }
  }, 60_000);

  it("RG/FLOAT: GpuForceLayout.readPositions stays within budget on a device that reads RG", async () => {
    const seed = seedPositions();
    const device = await makeTestDevice();
    try {
      const { ms } = measure(device, seed);
      console.log(`  GPU readback: N=${N} RG/FLOAT readPositions min-of-${REPEATS}=${ms.toFixed(1)}ms (ceiling ${CEILING_MS.toFixed(0)}ms)`);
      expect(ms).toBeLessThan(CEILING_MS);
    } finally {
      device.destroy();
    }
  }, 60_000);
});
