// WORKING CONFIGURATION (locked by spike, Task 4 / Task 5 depend on this):
//   parameters: { depthWriteEnabled: true, depthCompare: "less-equal", cullMode: "back" }
//   clearDepth: 1 on beginRenderPass, depthStencilAttachment: "depth24plus" on framebuffer.
//   Shaders: GLOBE_VS / GLOBE_FS as specified (no changes needed).
//   clip-space mapping: px → clip via (px / viewport * 2 - 1) / (1 - py / viewport * 2).
//   UV mapping: v_uv = (lon/360+0.5, 0.5 - lat/180) — standard equirect, no flip needed.
//   Back-hemisphere culling: front/back winding with cullMode:"back" correctly hides back.
import { describe, it, expect } from "vitest";
import { luma, Buffer } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Model } from "@luma.gl/engine";
import { buildSphereMesh } from "./sphere-mesh.js";
import { GLOBE_VS, GLOBE_FS } from "./shaders.js";

const W = 128, H = 128;
async function makeDevice() {
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  document.body.appendChild(canvas);
  const dev = await luma.createDevice({ adapters: [webgl2Adapter], type: "webgl", createCanvasContext: { canvas, useDevicePixels: false } });
  return { dev, canvas };
}

describe("globe spike", () => {
  it("samples an equirect texture on a sphere (front hemisphere only)", async () => {
    const { dev } = await makeDevice();
    const texW = 8, texH = 4;
    const data = new Uint8Array(texW * texH * 4);
    for (let y = 0; y < texH; y++) for (let x = 0; x < texW; x++) {
      const o = (y * texW + x) * 4; const red = x < texW / 2;
      data[o] = red ? 255 : 0; data[o + 1] = 0; data[o + 2] = red ? 0 : 255; data[o + 3] = 255;
    }
    const map = dev.createTexture({ data, width: texW, height: texH, format: "rgba8unorm", mipLevels: 1, sampler: { minFilter: "linear", magFilter: "linear" } });
    const fb = dev.createFramebuffer({ width: W, height: H, colorAttachments: ["rgba8unorm"], depthStencilAttachment: "depth24plus" });
    const mesh = buildSphereMesh(64, 32);
    const lonLat = dev.createBuffer({ data: mesh.lonLat });
    const indexBuffer = dev.createBuffer({ data: mesh.indices, usage: Buffer.INDEX, indexType: "uint32" });
    const identity3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const model = new Model(dev, {
      vs: GLOBE_VS, fs: GLOBE_FS,
      bufferLayout: [{ name: "a_lonLat", format: "float32x2" }],
      attributes: { a_lonLat: lonLat },
      indexBuffer, topology: "triangle-list", vertexCount: mesh.indices.length,
      bindings: { u_map: map },
      uniforms: { u_rotation: identity3, u_scale: W * 0.45, u_center: new Float32Array([W / 2, H / 2]), u_viewport: new Float32Array([W, H]) },
      parameters: { depthWriteEnabled: true, depthCompare: "less-equal", cullMode: "back" },
    });
    const pass = dev.beginRenderPass({ framebuffer: fb, clearColor: [0, 0, 0, 0], clearDepth: 1 });
    model.draw(pass); pass.end(); dev.submit();

    const center = dev.readPixelsToArrayWebGL(fb, { sourceX: W / 2, sourceY: H / 2, sourceWidth: 1, sourceHeight: 1 });
    expect(center[3]).toBeGreaterThan(200);                 // opaque: sphere is here
    expect(center[0] + center[2]).toBeGreaterThan(150);     // red or blue, not black/clear
    const corner = dev.readPixelsToArrayWebGL(fb, { sourceX: 2, sourceY: 2, sourceWidth: 1, sourceHeight: 1 });
    expect(corner[3]).toBeLessThan(40);                     // outside the disc: clear
    dev.destroy();
  });
});
