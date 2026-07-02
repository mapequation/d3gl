import { describe, it, expect, beforeAll } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import type { Device } from "@luma.gl/core";
import { packPositionsTexture, readbackFloatFbo } from "../textures.js";

async function createDevice(): Promise<Device> {
  const canvas = document.createElement("canvas");
  canvas.width = 16; canvas.height = 16;
  document.body.appendChild(canvas);
  return luma.createDevice({ adapters: [webgl2Adapter], type: "webgl", createCanvasContext: { canvas, useDevicePixels: false } });
}

describe("float RTT", () => {
  let device: Device;
  beforeAll(async () => { device = await createDevice(); });

  it("packs positions into an rg32float texture and reads them back unchanged", () => {
    const positions = new Float32Array([1.5, -2.25, 3.0, 4.0, -5.5, 6.5]); // 3 nodes
    const { texture, width, count } = packPositionsTexture(device, positions);
    const out = readbackFloatFbo(device, texture, width, count);
    expect(Array.from(out)).toEqual(Array.from(positions));
  });
});
