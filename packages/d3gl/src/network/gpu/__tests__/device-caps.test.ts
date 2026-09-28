import { describe, it, expect } from "vitest";
import { NESTED_MAX_SLOTS, gpuLayoutNeed, gpuLayoutSupport, gpuNestedSlotNeed, type GpuCaps, type GpuLayoutNeed } from "../device-caps.js";

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
  blendProbe: "pass",
};

/** web-NotreDame, the Navigator's large graph. */
const NOTRE_DAME = gpuLayoutNeed(325_729, 1_497_134);

describe("gpuLayoutNeed", () => {
  it("sizes every texture the layout allocates for the graph", () => {
    // Position atlas ⌈√N⌉, spring (CSR) atlas ⌈√2E⌉ — buildCSR stores every edge in both directions —
    // and the grid pyramid's finest level, next power of two ≥ √N clamped to [16, 1024].
    expect(NOTRE_DAME.positionSide).toBe(571);
    expect(NOTRE_DAME.offsetsSide).toBe(571);
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
    const r = gpuLayoutSupport({ ...FULL, blendProbe: "wrong-sum" }, NOTRE_DAME);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/wrong sum in the functional probe/);
  });

  it("names a probe that could not run apart from a wrong sum (no 'driver bug' for a thrown probe)", () => {
    const r = gpuLayoutSupport({ ...FULL, blendProbe: "error" }, NOTRE_DAME);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/could not run/);
      expect(r.reason).not.toMatch(/driver bug/);
    }
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

  it("rejects a graph whose CSR offsets atlas (N + 1 entries) exceeds the limit while its position atlas fits", () => {
    // N = limit²: the position atlas is exactly limit wide, but buildCSR's offsets hold N + 1 entries,
    // so packUintTexture sizes them ⌈√(N + 1)⌉ = limit + 1.
    const need = gpuLayoutNeed(2048 * 2048, 0);
    expect(need.positionSide).toBe(2048);
    expect(need.offsetsSide).toBe(2049);
    const r = gpuLayoutSupport({ ...FULL, maxTextureDimension2D: 2048 }, need);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/offsets/);
      expect(r.reason).toMatch(/2049/);
    }
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

describe("gpuLayoutSupport with a nested need (#355, #375)", () => {
  const atlasSide = (n: number): number => Math.ceil(Math.sqrt(n));
  /** A tree of web-NotreDame's directed Infomap tree's size (372,729 slots, 47,001 segments, 600,941 kept links) with a 1024-texel tile atlas. */
  const tree = (over: Partial<GpuLayoutNeed> = {}, nested: Partial<NonNullable<GpuLayoutNeed["nested"]>> = {}): GpuLayoutNeed => ({
    ...gpuLayoutNeed(372_729, 600_941),
    pyramidSide: 1024,
    ...over,
    nested: { slots: 372_729, collideSide: atlasSide(3 * 47_002), gridSide: 1024, ...nested },
  });

  it("accepts a tree whose every texture fits", () => {
    expect(gpuLayoutSupport(FULL, tree())).toEqual({ ok: true });
  });

  it("names the tile atlas, not a grid pyramid, when it is past the texture limit", () => {
    const r = gpuLayoutSupport({ ...FULL, maxTextureDimension2D: 4096 }, tree({ pyramidSide: 8192 }));
    expect(r).toEqual({ ok: false, reason: "the graph needs a 8192-texel tile atlas texture, past the device's 4096-texel limit" });
  });

  it("rejects a tile atlas past the 16-bit tile origin on a device that allocates it", () => {
    const r = gpuLayoutSupport({ ...FULL, maxTextureDimension2D: 1 << 17 }, tree({ pyramidSide: 1 << 17 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/131072-texel tile atlas, past the 65536 texels a tile origin addresses/);
  });

  it("rejects a collision table past the texture limit", () => {
    const r = gpuLayoutSupport({ ...FULL, maxTextureDimension2D: 2048 }, tree({}, { collideSide: 2049 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/2049-texel collision table/);
  });

  it("rejects a collision grid past the texture limit", () => {
    const r = gpuLayoutSupport({ ...FULL, maxTextureDimension2D: 2048 }, tree({}, { gridSide: 2049 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/2049-texel collision grid/);
  });

  it("rejects a tree past the slots float32 indexes exactly, whatever the device", () => {
    const r = gpuLayoutSupport(FULL, tree({}, { slots: NESTED_MAX_SLOTS }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/16777216 nodes below its root/);
    expect(gpuLayoutSupport(FULL, tree({}, { slots: NESTED_MAX_SLOTS - 1 }))).toEqual({ ok: true });
  });

  it("checks the device's capabilities first", () => {
    const r = gpuLayoutSupport({ ...FULL, floatBlend: false, blendProbe: null }, tree({}, { slots: NESTED_MAX_SLOTS }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/EXT_float_blend/);
  });
});

describe("gpuNestedSlotNeed: the nested check before the prep (#355, #375)", () => {
  it("rejects a tree past the slots float32 indexes exactly from its slot count alone", () => {
    const r = gpuLayoutSupport(FULL, gpuNestedSlotNeed(NESTED_MAX_SLOTS));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/16777216 nodes below its root/);
    expect(gpuLayoutSupport(FULL, gpuNestedSlotNeed(NESTED_MAX_SLOTS - 1))).toEqual({ ok: true });
  });

  it("sizes the slot atlas and the CSR offsets as the flat need does, and no grid pyramid", () => {
    const need = gpuNestedSlotNeed(372_729);
    const flat = gpuLayoutNeed(372_729, 0);
    expect([need.positionSide, need.offsetsSide]).toEqual([flat.positionSide, flat.offsetsSide]);
    // The nested solve allocates no grid pyramid; its tile atlas, springs, collision table and collision grid
    // wait for the prep.
    expect([need.pyramidSide, need.springSide, need.nested?.collideSide, need.nested?.gridSide]).toEqual([0, 0, 0, 0]);
    expect(need.nested?.slots).toBe(372_729);
  });

  it("accepts a tree the flat grid estimate would reject: 1,166 slots on a 60-texel device", () => {
    const caps = { ...FULL, maxTextureDimension2D: 60 };
    // ⌈√1166⌉ = 35 fits; the flat pyramid's next power of two ≥ √1166 is 64.
    expect(gpuLayoutSupport(caps, gpuLayoutNeed(1_166, 0))).toEqual({ ok: false, reason: "the graph needs a 64-texel grid pyramid texture, past the device's 60-texel limit" });
    expect(gpuLayoutSupport(caps, gpuNestedSlotNeed(1_166))).toEqual({ ok: true });
  });
});
