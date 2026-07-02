import { describe, it, expect, beforeAll } from "vitest";
import type { Device } from "@luma.gl/core";
import { makeTestDevice } from "./_device.js";
import { packPositionsTexture, readbackFloatFbo } from "../textures.js";

describe("float RTT", () => {
  let device: Device;
  beforeAll(async () => { device = await makeTestDevice(); });

  it("packs positions into an rg32float texture and reads them back unchanged", () => {
    const positions = new Float32Array([1.5, -2.25, 3.0, 4.0, -5.5, 6.5]); // 3 nodes
    const { texture, width, count } = packPositionsTexture(device, positions);
    const out = readbackFloatFbo(device, texture, width, count);
    expect(Array.from(out)).toEqual(Array.from(positions));
  });
});
