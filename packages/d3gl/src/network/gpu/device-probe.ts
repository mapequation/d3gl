/**
 * Extract the GPU layout's {@link GpuCaps} from a live luma `Device` (#351, spec §6.6). This is the one
 * place that reads device features and limits and runs the probes; the decision itself is the pure
 * `gpuLayoutSupport` in `device-caps.ts`.
 *
 * Two probes run once per device (cached in a `WeakMap`, so a device that goes away takes its entry
 * with it), both on one 2×1 `rg32float` target:
 * - **read format**: whether `RG/FLOAT` is the implementation read format of an `rg32f` attachment
 *   (`IMPLEMENTATION_COLOR_READ_FORMAT/TYPE`). WebGL2 guarantees only `RGBA/FLOAT`.
 * - **functional blend**: two points ADD-blended into one texel, read back as `RGBA/FLOAT`. It catches a
 *   driver that advertises `EXT_float_blend` but blends wrongly (or at half precision: the sum needs
 *   more than a half float's range and mantissa).
 */
import type { Device, Framebuffer, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { WebGLDevice, WEBGLFramebuffer } from "@luma.gl/webgl";
import type { GpuCaps } from "./device-caps.js";

/** GL enums for the guaranteed float readback (`EXT_color_buffer_float`). */
const GL_RGBA = 0x1908;
const GL_FLOAT = 0x1406;

/** Probe values: exact in float32, but the sum overflows a half float (max 65504) and needs 21 bits of
 *  mantissa, so a half-precision blend fails the probe. */
const PROBE_A: readonly [number, number] = [1048576.0, -0.375];
const PROBE_B: readonly [number, number] = [0.5, 3.0];

const PROBE_VS = /* glsl */ `\
#version 300 es
precision highp float;
flat out vec2 v_value;
void main() {
  // Both points land in texel 0 of the 2×1 target (clip x = -0.5 is its centre); texel 1 keeps the clear.
  v_value = gl_VertexID == 0 ? vec2(${PROBE_A[0].toFixed(3)}, ${PROBE_A[1].toFixed(3)})
                             : vec2(${PROBE_B[0].toFixed(3)}, ${PROBE_B[1].toFixed(3)});
  gl_Position = vec4(-0.5, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const PROBE_FS = /* glsl */ `\
#version 300 es
precision highp float;
flat in highp vec2 v_value;
out vec4 o_value;
void main() { o_value = vec4(v_value, 0.0, 0.0); }
`;

const caps = new WeakMap<Device, GpuCaps>();

/**
 * The GPU layout's view of `device`, or `null` when there is none. Cached per device: the probes cost
 * one tiny shader compile, one 2-point draw and one 2-texel synchronous readback, once.
 */
export function gpuCaps(device: Device | null | undefined): GpuCaps | null {
  if (!device) return null;
  const hit = caps.get(device);
  if (hit) return hit;
  const floatRenderable = device.features.has("float32-renderable-webgl");
  const floatBlend = device.features.has("texture-blend-float-webgl");
  let readRG = false;
  let blendProbe: boolean | null = null;
  // An rg32f target needs float render targets; the blend draw also needs float blending (without it the
  // draw is an INVALID_OPERATION, which the extension check already reports more clearly).
  if (device.type === "webgl" && floatRenderable) {
    const target = createProbeTarget(device);
    readRG = readsRG(device, target.fbo);
    if (floatBlend) blendProbe = probeFloatBlend(device, target.fbo);
    target.fbo.destroy();
    target.texture.destroy();
  }
  const result: GpuCaps = {
    type: device.type,
    floatRenderable,
    floatBlend,
    maxTextureDimension2D: device.limits.maxTextureDimension2D,
    readRG,
    blendProbe,
  };
  caps.set(device, result);
  return result;
}

/** A 2×1 `rg32float` target for the probes. */
function createProbeTarget(device: Device): { texture: Texture; fbo: Framebuffer } {
  const texture = device.createTexture({
    width: 2,
    height: 1,
    format: "rg32float",
    mipLevels: 1,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
  const fbo = device.createFramebuffer({ width: 2, height: 1, colorAttachments: [texture] });
  return { texture, fbo };
}

/**
 * Whether `fbo`'s colour attachment reads back as `RG/FLOAT` (the implementation read format), so a
 * position readback moves 8 bytes per node instead of `RGBA/FLOAT`'s 16. Two state queries and two
 * framebuffer binds; the previous read framebuffer is restored.
 */
export function readsRG(device: Device, fbo: Framebuffer): boolean {
  if (!(device instanceof WebGLDevice) || !(fbo instanceof WEBGLFramebuffer)) return false;
  const gl = device.gl;
  const previous: WebGLFramebuffer | null = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo.handle);
  const format: number = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT);
  const type: number = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous);
  return format === gl.RG && type === gl.FLOAT;
}

/**
 * Draw two ADD-blended points into texel 0 of the 2×1 `rg32float` target `fbo` and read both texels back
 * as `RGBA/FLOAT`: true when texel 0 holds the exact float32 sum and texel 1 the clear value. Uses the
 * blend state every force pass uses. Exported for the browser test; the layout reads it via {@link gpuCaps}.
 */
export function probeFloatBlend(device: Device, fbo: Framebuffer): boolean {
  let model: Model | null = null;
  try {
    model = new Model(device, {
      vs: PROBE_VS,
      fs: PROBE_FS,
      topology: "point-list",
      vertexCount: 2,
      parameters: {
        blend: true,
        blendColorSrcFactor: "one",
        blendColorDstFactor: "one",
        blendAlphaSrcFactor: "one",
        blendAlphaDstFactor: "one",
        blendColorOperation: "add",
        blendAlphaOperation: "add",
      },
    });
    const pass = device.beginRenderPass({ framebuffer: fbo, clearColor: [0, 0, 0, 0] });
    model.draw(pass);
    pass.end();
    device.submit();
    const px = device.readPixelsToArrayWebGL(fbo, { sourceFormat: GL_RGBA, sourceType: GL_FLOAT });
    if (!(px instanceof Float32Array) || px.length < 8) return false;
    const sumX = Math.fround(PROBE_A[0] + PROBE_B[0]);
    const sumY = Math.fround(PROBE_A[1] + PROBE_B[1]);
    return px[0] === sumX && px[1] === sumY && px[4] === 0 && px[5] === 0;
  } catch {
    return false; // the device could not even build or run the probe
  } finally {
    model?.destroy();
    drainGlErrors(device); // a rejected draw leaves INVALID_OPERATION set for the next unrelated check
  }
}

/** Clear WebGL's sticky error flags (a failed probe draw sets one). */
function drainGlErrors(device: Device): void {
  if (!(device instanceof WebGLDevice)) return;
  const gl = device.gl;
  for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++);
}
