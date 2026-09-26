import { describe, it, expect } from "vitest";
import { gpuLayoutNeed, gpuLayoutSupport, type GpuCaps } from "../device-caps.js";

/**
 * The GPU layout's capability matrix (#351): a pure decision over a typed {@link GpuCaps} record, so
 * every failure mode is testable without faking a luma `Device`. The browser leg
 * (`device-probe.browser.test.ts`) checks that a real device extracts into this record.
 */

/** A desktop-class device that runs the GPU layout (M1 Max / ANGLE Metal reports these). */
const FULL: GpuCaps = {
  type: "webgl",
  floatRenderable: true,
  floatBlend: true,
  maxTextureDimension2D: 16384,
  readRG: true,
  blendProbe: true,
};

/** web-NotreDame, the Navigator's large graph. */
const NOTRE_DAME = gpuLayoutNeed(325_729, 1_497_134);

describe("gpuLayoutNeed", () => {
  it("sizes every texture the layout allocates for the graph", () => {
    // Position atlas ⌈√N⌉, spring (CSR) atlas ⌈√2E⌉ — buildCSR stores every edge in both directions —
    // and the grid pyramid's finest level, next power of two ≥ √N clamped to [16, 1024].
    expect(NOTRE_DAME.positionSide).toBe(571);
    expect(NOTRE_DAME.springSide).toBe(1731);
    expect(NOTRE_DAME.pyramidSide).toBe(1024);
  });

  it("keeps a 1×1 spring atlas for an edge-less graph", () => {
    const need = gpuLayoutNeed(10, 0);
    expect(need.springSide).toBe(1);
    expect(need.positionSide).toBe(4);
    expect(need.pyramidSide).toBe(16);
  });
});

describe("gpuLayoutSupport", () => {
  it("accepts a device with every capability", () => {
    expect(gpuLayoutSupport(FULL, NOTRE_DAME)).toEqual({ ok: true });
  });

  it("rejects a missing device (Canvas/SVG render backend, SSR)", () => {
    const r = gpuLayoutSupport(null, NOTRE_DAME);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no WebGL device/);
  });

  it("rejects a non-WebGL device", () => {
    const r = gpuLayoutSupport({ ...FULL, type: "webgpu" }, NOTRE_DAME);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/webgpu/);
  });

  it("rejects a device without float render targets", () => {
    const r = gpuLayoutSupport({ ...FULL, floatRenderable: false, floatBlend: false, readRG: false, blendProbe: null }, NOTRE_DAME);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/EXT_color_buffer_float/);
  });

  it("rejects a device with float render targets but no float blending (the #351 gap)", () => {
    // The old check passed this device, which then drew with additive blending into rg32f targets:
    // a GL error per pass or silently wrong forces.
    const r = gpuLayoutSupport({ ...FULL, floatBlend: false, blendProbe: null }, NOTRE_DAME);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/EXT_float_blend/);
  });

  it("rejects a device whose float blending fails the functional probe", () => {
    const r = gpuLayoutSupport({ ...FULL, blendProbe: false }, NOTRE_DAME);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/functional probe/);
  });

  it("accepts a device whose functional probe did not run", () => {
    expect(gpuLayoutSupport({ ...FULL, blendProbe: null }, NOTRE_DAME)).toEqual({ ok: true });
  });

  it("rejects a graph whose spring atlas exceeds the texture limit", () => {
    // 1M nodes at web density: 2E ≈ 9.2M half-edges → a 3034-texel spring atlas, past WebGL2's
    // guaranteed 2048.
    const need = gpuLayoutNeed(1_000_000, 4_600_000);
    expect(need.springSide).toBe(3034);
    const r = gpuLayoutSupport({ ...FULL, maxTextureDimension2D: 2048 }, need);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/spring/);
      expect(r.reason).toMatch(/3034/);
      expect(r.reason).toMatch(/2048/);
    }
    // The same graph fits a desktop limit.
    expect(gpuLayoutSupport(FULL, need)).toEqual({ ok: true });
  });

  it("rejects a graph whose position atlas exceeds the texture limit", () => {
    const need = gpuLayoutNeed(5_000_000, 0);
    const r = gpuLayoutSupport({ ...FULL, maxTextureDimension2D: 2048 }, need);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/position/);
  });

  it("accepts web-NotreDame at WebGL2's guaranteed minimum texture size", () => {
    expect(gpuLayoutSupport({ ...FULL, maxTextureDimension2D: 2048 }, NOTRE_DAME)).toEqual({ ok: true });
  });

  it("does not depend on the readback format (RGBA/FLOAT is the guaranteed fallback)", () => {
    expect(gpuLayoutSupport({ ...FULL, readRG: false }, NOTRE_DAME)).toEqual({ ok: true });
  });
});
