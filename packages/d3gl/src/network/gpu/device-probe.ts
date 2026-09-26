/**
 * Extract the GPU layout's {@link GpuCaps} from a live luma `Device` (#351, spec §6.6). This is the one
 * place that reads device features and limits and runs the probes; the decision itself is the pure
 * `gpuLayoutSupport` in `device-caps.ts`.
 *
 * Two probes run once per device (cached in `WeakMap`s, so a device that goes away takes its entries
 * with it), both on one 2×1 `rg32float` target:
 * - **read format**: whether `RG/FLOAT` is the implementation read format of an `rg32f` attachment
 *   (`IMPLEMENTATION_COLOR_READ_FORMAT/TYPE`). WebGL2 guarantees only `RGBA/FLOAT`. `deviceReadsRG` is the
 *   one cached answer, read by both `gpuCaps` and every `PositionReadback`.
 * - **functional blend**: two points ADD-blended into one texel, read back as `RGBA/FLOAT`. It catches a
 *   driver that advertises `EXT_float_blend` but blends wrongly (or at half precision: the sum needs
 *   more than a half float's range and mantissa).
 *
 * A probe that throws is reported as `blendProbe: "error"` (its own reason, not "driver bug") and cached
 * like any verdict, so later layouts neither probe again nor throw. A lost context is the exception: its
 * record is not cached, because nothing it measured says anything about the device.
 */
import type { Device, Framebuffer, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { WebGLDevice, WEBGLFramebuffer } from "@luma.gl/webgl";
import type { BlendProbe, GpuCaps } from "./device-caps.js";

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
const readFormats = new WeakMap<Device, boolean>();

/**
 * The GPU layout's view of `device`, or `null` when there is none. Cached per device (except on a lost
 * context): the probes cost one tiny shader compile, one 2-point draw and one 2-texel synchronous
 * readback, once.
 */
export function gpuCaps(device: Device | null | undefined): GpuCaps | null {
  if (!device) return null;
  const hit = caps.get(device);
  if (hit) return hit;
  const floatRenderable = device.features.has("float32-renderable-webgl");
  const floatBlend = device.features.has("texture-blend-float-webgl");
  let readRG = false;
  let blendProbe: BlendProbe | null = null;
  // An rg32f target needs float render targets; the blend draw also needs float blending (without it the
  // draw is an INVALID_OPERATION, which the extension check already reports more clearly).
  if (device.type === "webgl" && floatRenderable) {
    const probed = withProbeTarget(device, (fbo) => ({
      readRG: cachedReadsRG(device, fbo),
      blendProbe: floatBlend ? probeFloatBlend(device, fbo) : null,
    }));
    readRG = probed?.readRG ?? false;
    blendProbe = probed ? probed.blendProbe : "error";
  }
  const lost = device.isLost;
  const result: GpuCaps = {
    type: device.type,
    floatRenderable,
    floatBlend,
    maxTextureDimension2D: device.limits.maxTextureDimension2D,
    readRG,
    blendProbe: lost ? "error" : blendProbe,
  };
  if (!lost) caps.set(device, result);
  return result;
}

/**
 * Whether `rg32f` attachments on `device` read back as `RG/FLOAT` (the implementation read format), so a
 * position readback moves 8 bytes per node instead of `RGBA/FLOAT`'s 16. Probed once per device on a 2×1
 * target (shared with {@link gpuCaps} when that runs first) and cached; false where the probe cannot run,
 * since `RGBA/FLOAT` is the format WebGL2 guarantees.
 */
export function deviceReadsRG(device: Device): boolean {
  const hit = readFormats.get(device);
  if (hit !== undefined) return hit;
  return withProbeTarget(device, (fbo) => cachedReadsRG(device, fbo)) ?? false;
}

/** {@link readsRG} for `device`, recorded as the device's read format unless its context is lost. */
function cachedReadsRG(device: Device, fbo: Framebuffer): boolean {
  const hit = readFormats.get(device);
  if (hit !== undefined) return hit;
  const rg = readsRG(device, fbo);
  if (!device.isLost) readFormats.set(device, rg);
  return rg;
}

/**
 * Run `probe` on a fresh 2×1 `rg32float` target and free the target whatever happens. `null` when
 * creating the target or running the probe threw; GL errors a failed probe leaves behind are cleared.
 */
function withProbeTarget<T>(device: Device, probe: (fbo: Framebuffer) => T): T | null {
  let texture: Texture | null = null;
  let fbo: Framebuffer | null = null;
  try {
    texture = device.createTexture({
      width: 2,
      height: 1,
      format: "rg32float",
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });
    fbo = device.createFramebuffer({ width: 2, height: 1, colorAttachments: [texture] });
    return probe(fbo);
  } catch {
    return null;
  } finally {
    fbo?.destroy();
    texture?.destroy();
    drainGlErrors(device);
  }
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
 * Draw two ADD-blended points into texel 0 of the 2×1 float target `fbo` and read both texels back as
 * `RGBA/FLOAT`: `"pass"` when texel 0 holds the exact float32 sum and texel 1 the clear value,
 * `"wrong-sum"` otherwise, `"error"` when the device could not build or run the probe. Uses the blend
 * state every force pass uses. Exported for the browser test; the layout reads it via {@link gpuCaps}.
 */
export function probeFloatBlend(device: Device, fbo: Framebuffer): BlendProbe {
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
    if (!(px instanceof Float32Array) || px.length < 8) return "error";
    const sumX = Math.fround(PROBE_A[0] + PROBE_B[0]);
    const sumY = Math.fround(PROBE_A[1] + PROBE_B[1]);
    return px[0] === sumX && px[1] === sumY && px[4] === 0 && px[5] === 0 ? "pass" : "wrong-sum";
  } catch {
    return "error"; // the device could not even build or run the probe
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
