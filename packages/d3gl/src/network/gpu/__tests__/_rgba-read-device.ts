import { vi } from "vitest";
import type { Device } from "@luma.gl/core";
import { WebGLDevice } from "@luma.gl/webgl";
import { makeTestDevice } from "./_device.js";

/** A test device that reads `rg32f` attachments only as `RGBA/FLOAT`, and how often it refused `RG`. */
export interface RgbaReadDevice {
  device: Device;
  /** `readPixels(…, RG, …)` calls this device refused. A real one raises INVALID_OPERATION and writes nothing. */
  rejectedRgReads(): number;
  /** Remove the prototype spies. Call it after the device is destroyed. */
  restore(): void;
}

/**
 * A WebGL2 device that behaves like one whose `rg32f` implementation read format is `RGBA/FLOAT` (#351),
 * on hardware that also reads `RG/FLOAT` (ANGLE Metal):
 * - `getParameter(IMPLEMENTATION_COLOR_READ_FORMAT)` reports `RGBA`, as such a device does;
 * - `readPixels` with format `RG` writes nothing, as INVALID_OPERATION does there, and is counted.
 *
 * Both spies sit on `WebGL2RenderingContext.prototype` and act only on this device's context. They are
 * installed before the device exists because luma binds `getParameter` when it creates the context
 * (its state tracker wraps it), so a spy installed later would never be called.
 */
export async function makeRgbaReadDevice(): Promise<RgbaReadDevice> {
  const proto = WebGL2RenderingContext.prototype;
  const getParameter = proto.getParameter;
  const readPixels = proto.readPixels;
  let target: WebGL2RenderingContext | null = null;
  let rejected = 0;
  const paramSpy = vi.spyOn(proto, "getParameter").mockImplementation(
    function (this: WebGL2RenderingContext, pname: number) {
      if (this === target && pname === this.IMPLEMENTATION_COLOR_READ_FORMAT) return this.RGBA;
      return getParameter.call(this, pname);
    },
  );
  const readSpy = vi.spyOn(proto, "readPixels").mockImplementation(
    function (this: WebGL2RenderingContext, ...args: unknown[]) {
      if (this === target && args[4] === this.RG) {
        rejected++;
        return;
      }
      Reflect.apply(readPixels, this, args);
    },
  );
  const restore = (): void => {
    paramSpy.mockRestore();
    readSpy.mockRestore();
  };
  try {
    const device = await makeTestDevice();
    if (!(device instanceof WebGLDevice)) throw new Error("expected a WebGL2 device");
    target = device.gl;
    return { device, rejectedRgReads: () => rejected, restore };
  } catch (error) {
    restore();
    throw error;
  }
}
