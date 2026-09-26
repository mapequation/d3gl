/**
 * `gpuCaps` against real WebGL2 devices (#351): the extraction into the typed record that
 * `gpuLayoutSupport` decides on (`device-caps.test.ts` covers the matrix), the read-format and
 * functional probes, and the `RGBA/FLOAT` readback fallback round trip.
 *
 * A device without float blending is made by hiding `EXT_float_blend` from `getExtension` while luma
 * creates the device (luma probes every feature at creation), which is what such a device reports.
 */
import { describe, it, expect, vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { gpuCaps, probeFloatBlend, readsRG } from "../device-probe.js";
import { gpuLayoutNeed, gpuLayoutSupport } from "../device-caps.js";
import { packPositionsTexture, readbackFloatFboReuse } from "../textures.js";

/** A WebGL2 device created while `EXT_float_blend` is hidden, as on a device without it. */
async function makeDeviceWithoutFloatBlend(): Promise<Device> {
  const original = WebGL2RenderingContext.prototype.getExtension;
  const spy = vi.spyOn(WebGL2RenderingContext.prototype, "getExtension").mockImplementation(
    function (this: WebGL2RenderingContext, name: string) {
      return name === "EXT_float_blend" ? null : original.call(this, name);
    },
  );
  try {
    return await makeTestDevice();
  } finally {
    spy.mockRestore();
  }
}

describe("gpuCaps (#351)", () => {
  it("reports a desktop device's features, limits and passing probes, once per device", async () => {
    const device = await makeTestDevice();
    const t0 = performance.now();
    const caps = gpuCaps(device);
    const probeMs = performance.now() - t0;
    expect(caps).not.toBeNull();
    if (!caps) return;
    expect(caps.type).toBe("webgl");
    expect(caps.floatRenderable).toBe(true);
    expect(caps.floatBlend).toBe(true);
    expect(caps.blendProbe).toBe(true);
    expect(caps.maxTextureDimension2D).toBeGreaterThanOrEqual(2048);
    expect(gpuLayoutSupport(caps, gpuLayoutNeed(325_729, 1_497_134))).toEqual({ ok: true });
    // Cached: the probes run once per device.
    const t1 = performance.now();
    expect(gpuCaps(device)).toBe(caps);
    const cachedMs = performance.now() - t1;
    console.log(`[gpuCaps] first call ${probeMs.toFixed(2)} ms (probes), cached ${cachedMs.toFixed(3)} ms; readRG=${caps.readRG}`);
    device.destroy();
  });

  it("is null without a device", () => {
    expect(gpuCaps(null)).toBeNull();
    expect(gpuCaps(undefined)).toBeNull();
  });

  it("reports a device without EXT_float_blend as unsupported, naming the extension", async () => {
    const device = await makeDeviceWithoutFloatBlend();
    const caps = gpuCaps(device);
    expect(caps).not.toBeNull();
    if (!caps) return;
    expect(caps.floatRenderable).toBe(true); // the device the old check accepted
    expect(caps.floatBlend).toBe(false);
    expect(caps.blendProbe).toBeNull(); // the probe needs the extension; the check above reports it
    const verdict = gpuLayoutSupport(caps, gpuLayoutNeed(1000, 2000));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/EXT_float_blend/);
    device.destroy();
  });

  it("the functional probe passes where float blending works", async () => {
    const device = await makeTestDevice();
    const texture = device.createTexture({ width: 2, height: 1, format: "rg32float", mipLevels: 1 });
    const fbo = device.createFramebuffer({ width: 2, height: 1, colorAttachments: [texture] });
    expect(probeFloatBlend(device, fbo)).toBe(true);
    // Repeatable on the same target (it clears first).
    expect(probeFloatBlend(device, fbo)).toBe(true);
    fbo.destroy();
    texture.destroy();
    device.destroy();
  });
});

describe("position readback formats (#351)", () => {
  it("RG/FLOAT is reported only when it is the implementation read format", async () => {
    const device = await makeTestDevice();
    const { texture } = packPositionsTexture(device, new Float32Array([1, 2, 3, 4]));
    const fbo = device.createFramebuffer({ width: texture.width, height: texture.height, colorAttachments: [texture] });
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    expect(gl).not.toBeNull();
    if (!gl) return;
    // Cross-check against a raw context's own query for an rg32f attachment.
    expect(gl.getExtension("EXT_color_buffer_float")).not.toBeNull();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG32F, 2, 1);
    const raw = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, raw);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const rawRG = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RG
      && gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.FLOAT;
    expect(readsRG(device, fbo)).toBe(rawRG);
    fbo.destroy();
    texture.destroy();
    device.destroy();
  });

  it("the RGBA/FLOAT fallback round-trips positions exactly, like the RG/FLOAT path", async () => {
    const device = await makeTestDevice();
    // 7 nodes → a 3×3 atlas with 2 padded texels, so the compaction must skip the padding correctly.
    const positions = new Float32Array([
      0, 0, 1.5, -2.25, -1e6, 3e5, 123.456, -0.001, 7, 8, -9.75, 10.5, 1e-7, -1e7,
    ]);
    const { texture, width, height, count } = packPositionsTexture(device, positions);
    const fbo = device.createFramebuffer({ width, height, colorAttachments: [texture] });
    const rgba = new Float32Array(width * height * 4);
    const viaRgba = readbackFloatFboReuse(device, fbo, width, count, rgba);
    expect(Array.from(viaRgba)).toEqual(Array.from(positions));
    if (readsRG(device, fbo)) {
      const viaRg = readbackFloatFboReuse(device, fbo, width, count);
      expect(Array.from(viaRg)).toEqual(Array.from(positions));
    }
    fbo.destroy();
    texture.destroy();
    device.destroy();
  });
});
