import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import type { Device } from "@luma.gl/core";

/** Create a WebGL2 luma.gl device backed by a small offscreen canvas. */
export async function makeTestDevice(): Promise<Device> {
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  document.body.appendChild(canvas);
  return luma.createDevice({
    adapters: [webgl2Adapter],
    type: "webgl",
    createCanvasContext: { canvas, useDevicePixels: false },
  });
}
