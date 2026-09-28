/**
 * Read GPU layout positions (an `rg32float` atlas, one (x, y) texel per node) back to the CPU in a format
 * the device supports (#351, spec §6.5.2). Every `rg32f` readback in the layout goes through here, so no
 * caller picks the format itself.
 *
 * - Where `RG/FLOAT` is the implementation read format (`deviceReadsRG`; ANGLE Metal), it reads that: 8
 *   bytes per atlas texel, and the first `count` texels are the positions (the padding is at the end).
 * - Elsewhere it reads `RGBA/FLOAT`, the format WebGL2 guarantees for float colour buffers, into a scratch
 *   of `width × height × 4` floats allocated once per reader, then compacts (x, y) out of each texel: 16
 *   bytes per texel plus an O(count) loop. Reading `RG/FLOAT` there is an INVALID_OPERATION that writes
 *   nothing, so the positions would silently stay zero.
 *
 * Both paths write straight into the caller's array (no per-call output array, no second copy). The
 * `RG/FLOAT` path still lets luma allocate its `width × height × 2` read buffer per call, as before #351.
 */
import type { Device, Framebuffer } from "@luma.gl/core";
import { deviceReadsRG } from "./device-probe.js";

/** GL enums for the float readback every `EXT_color_buffer_float` device supports. */
const GL_RGBA = 0x1908;
const GL_FLOAT = 0x1406;

export class PositionReadback {
  private readonly device: Device;
  private readonly width: number;
  private readonly height: number;
  /** `RGBA/FLOAT` scratch (`width × height × 4` floats), or `null` where `RG/FLOAT` is the read format. */
  private readonly rgba: Float32Array | null;

  /** A reader for `width × height` `rg32float` atlases on `device`. The read format is probed once per device. */
  constructor(device: Device, width: number, height: number) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.rgba = deviceReadsRG(device) ? null : new Float32Array(width * height * 4);
  }

  /**
   * Read the first `count` (x, y) pairs of the atlas attached to `fbo` into `out[0 .. 2·count)`. `fbo` must
   * wrap a `width × height` `rg32float` texture, and `out` must hold at least `2 · count` floats.
   */
  read(fbo: Framebuffer, count: number, out: Float32Array): void {
    const { device, width, height, rgba } = this;
    if (rgba) {
      device.readPixelsToArrayWebGL(fbo, {
        sourceX: 0,
        sourceY: 0,
        sourceWidth: width,
        sourceHeight: height,
        sourceFormat: GL_RGBA,
        sourceType: GL_FLOAT,
        target: rgba,
      });
      for (let i = 0; i < count; i++) {
        out[i * 2] = rgba[i * 4] ?? 0;
        out[i * 2 + 1] = rgba[i * 4 + 1] ?? 0;
      }
      return;
    }
    // Format and type default to the texture's own (RG, FLOAT for rg32float).
    const pixels = device.readPixelsToArrayWebGL(fbo, { sourceX: 0, sourceY: 0, sourceWidth: width, sourceHeight: height });
    if (!(pixels instanceof Float32Array)) throw new Error("PositionReadback: expected an rg32float attachment");
    out.set(pixels.subarray(0, count * 2));
  }
}
