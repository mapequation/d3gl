/**
 * `gpuCaps` against real WebGL2 devices (#351): the extraction into the typed record that
 * `gpuLayoutSupport` decides on (`device-caps.test.ts` covers the matrix), the read-format and
 * functional probes and their failure handling, and the `RGBA/FLOAT` readback fallback, both on its
 * own and through `GpuForceLayout`.
 *
 * A device without float blending is made by hiding `EXT_float_blend` from `getExtension` while luma
 * creates the device (luma probes every feature at creation), which is what such a device reports. A
 * device that reads `rg32f` only as `RGBA/FLOAT` comes from `makeRgbaReadDevice`.
 */
import { describe, it, expect, vi } from "vitest";
import type { Device, Texture } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { makeRgbaReadDevice } from "./_rgba-read-device.js";
import { deviceReadsRG, gpuCaps, probeFloatBlend, readsRG } from "../device-probe.js";
import { gpuLayoutNeed, gpuLayoutSupport } from "../device-caps.js";
import { packPositionsTexture } from "../textures.js";
import { PositionReadback } from "../position-readback.js";
import { GpuForceLayout } from "../gpu-force-layout.js";
import { DEFAULT_FORCE, type LayoutGraph } from "../../force.js";

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
    expect(caps.blendProbe).toBe("pass");
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
    expect(probeFloatBlend(device, fbo)).toBe("pass");
    // Repeatable on the same target (it clears first).
    expect(probeFloatBlend(device, fbo)).toBe("pass");
    fbo.destroy();
    texture.destroy();
    device.destroy();
  });

  it("the functional probe rejects a blend that cannot hold the float32 sum", async () => {
    // A half-float target stands in for a driver that blends at half precision: 1048576.5 overflows a
    // half float (max 65504), so the probe must report a wrong sum rather than pass.
    const device = await makeTestDevice();
    const texture = device.createTexture({ width: 2, height: 1, format: "rg16float", mipLevels: 1 });
    const fbo = device.createFramebuffer({ width: 2, height: 1, colorAttachments: [texture] });
    expect(probeFloatBlend(device, fbo)).toBe("wrong-sum");
    fbo.destroy();
    texture.destroy();
    device.destroy();
  });

  it("a probe that throws gets its own cached verdict and frees its target", async () => {
    const device = await makeTestDevice();
    const created: Texture[] = [];
    const createTexture = device.createTexture.bind(device);
    const texSpy = vi.spyOn(device, "createTexture").mockImplementation((props) => {
      const texture = createTexture(props);
      created.push(texture);
      return texture;
    });
    const fboSpy = vi.spyOn(device, "createFramebuffer").mockImplementation(() => {
      throw new Error("framebuffer incomplete");
    });
    const caps = gpuCaps(device);
    expect(caps?.blendProbe).toBe("error");
    expect(created.length).toBe(1);
    expect(created.every((t) => t.destroyed)).toBe(true); // no leaked probe texture
    if (caps) {
      const verdict = gpuLayoutSupport(caps, gpuLayoutNeed(1000, 2000));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.reason).toMatch(/could not run/);
        expect(verdict.reason).not.toMatch(/driver bug/);
      }
    }
    // Cached: a later layout neither probes again nor throws.
    expect(gpuCaps(device)).toBe(caps);
    expect(fboSpy).toHaveBeenCalledTimes(1);
    texSpy.mockRestore();
    fboSpy.mockRestore();
    device.destroy();
  });

  it("a lost context is not cached, so a live one probes again", async () => {
    const device = await makeTestDevice();
    const lost = vi.spyOn(device, "isLost", "get").mockReturnValue(true);
    const whileLost = gpuCaps(device);
    expect(whileLost?.blendProbe).toBe("error");
    lost.mockRestore();
    const live = gpuCaps(device);
    expect(live).not.toBe(whileLost);
    expect(live?.blendProbe).toBe("pass");
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

  it("the device's read format is probed once and matches the raw query", async () => {
    const device = await makeTestDevice();
    const { texture } = packPositionsTexture(device, new Float32Array([1, 2]));
    const fbo = device.createFramebuffer({ width: texture.width, height: texture.height, colorAttachments: [texture] });
    expect(deviceReadsRG(device)).toBe(readsRG(device, fbo));
    expect(gpuCaps(device)?.readRG).toBe(deviceReadsRG(device)); // one source of truth
    fbo.destroy();
    texture.destroy();
    device.destroy();

    const rgba = await makeRgbaReadDevice();
    try {
      expect(deviceReadsRG(rgba.device)).toBe(false);
      expect(gpuCaps(rgba.device)?.readRG).toBe(false);
    } finally {
      rgba.device.destroy();
      rgba.restore();
    }
  });

  it("PositionReadback round-trips positions exactly on RG/FLOAT and RGBA/FLOAT devices, skipping the atlas padding", async () => {
    // 7 nodes → a 3×3 atlas with 2 padded texels, so the compaction must skip the padding correctly.
    const positions = new Float32Array([
      0, 0, 1.5, -2.25, -1e6, 3e5, 123.456, -0.001, 7, 8, -9.75, 10.5, 1e-7, -1e7,
    ]);
    const roundTrip = (device: Device): number[] => {
      const { texture, width, height, count } = packPositionsTexture(device, positions);
      const fbo = device.createFramebuffer({ width, height, colorAttachments: [texture] });
      const out = new Float32Array(count * 2).fill(NaN);
      new PositionReadback(device, width, height).read(fbo, count, out);
      fbo.destroy();
      texture.destroy();
      return Array.from(out);
    };
    const device = await makeTestDevice();
    expect(roundTrip(device)).toEqual(Array.from(positions));
    device.destroy();
    const rgba = await makeRgbaReadDevice();
    try {
      expect(roundTrip(rgba.device)).toEqual(Array.from(positions));
      expect(rgba.rejectedRgReads()).toBe(0);
    } finally {
      rgba.device.destroy();
      rgba.restore();
    }
  });

  it("GpuForceLayout reads positions back through RGBA/FLOAT exactly as through RG/FLOAT, on both parities", async () => {
    // 7 nodes on a path → a 3×3 atlas with 2 padded texels.
    const seed = new Float32Array([0, 0, 30, 5, 60, -10, 90, 20, 120, 0, 150, -25, 180, 10]);
    const graph = (): LayoutGraph => ({
      nodeCount: 7,
      edgeCount: 6,
      source: Uint32Array.of(0, 1, 2, 3, 4, 5),
      target: Uint32Array.of(1, 2, 3, 4, 5, 6),
      positions: seed.slice(),
    });
    const rgDevice = await makeTestDevice();
    const rgLayout = new GpuForceLayout(rgDevice, graph(), DEFAULT_FORCE);
    rgLayout.runFrame(3); // an odd tick count leaves the read side on the other parity
    const expected = new Float32Array(14);
    rgLayout.readPositions(expected);
    rgLayout.destroy();
    rgDevice.destroy();

    const rgba = await makeRgbaReadDevice();
    try {
      const layout = new GpuForceLayout(rgba.device, graph(), DEFAULT_FORCE);
      const out = new Float32Array(14);
      layout.readPositions(out); // parity 0: the uploaded seed
      expect(Array.from(out)).toEqual(Array.from(seed));
      layout.runFrame(3);
      layout.readPositions(out); // parity 1
      expect(Array.from(out)).toEqual(Array.from(expected));
      expect(Array.from(out)).not.toEqual(Array.from(seed)); // the layout moved
      expect(rgba.rejectedRgReads()).toBe(0);
      layout.destroy();
    } finally {
      rgba.device.destroy();
      rgba.restore();
    }
  });
});
