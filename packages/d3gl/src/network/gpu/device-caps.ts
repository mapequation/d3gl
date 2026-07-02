import type { Device } from "@luma.gl/core";

/** GPU layout needs WebGL2 + float-renderable color (rg32float RTT). */
export function gpuLayoutSupported(device: Device | null | undefined): device is Device {
  if (!device) return false;
  return device.type === "webgl" && device.features.has("float32-renderable-webgl");
}
