import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Scene } from "@d3gl/core";
import { GroupRenderer } from "./renderer.js";
import { clipFromView } from "./transform.js";

const W = 64, H = 64;
describe("WebGL analytic points", () => {
  it("rasterizes a filled circle (center in, corner out)", async () => {
    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    document.body.appendChild(canvas);
    const device = await luma.createDevice({ adapters: [webgl2Adapter], type: "webgl", createCanvasContext: { canvas, useDevicePixels: false } });
    const fb = device.createFramebuffer({ width: W, height: H, colorAttachments: ["rgba8unorm"] });
    const scene = new Scene();
    scene.group("p", (b) => b.point("a", 32, 32, 12));
    scene.setFill("p", "a", "rgb(255,0,0)");
    const r = new GroupRenderer(device, scene.buffers("p"));
    r.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
    const pass = device.beginRenderPass({ framebuffer: fb, clearColor: [0, 0, 0, 1] });
    r.render(pass); pass.end(); device.submit();
    const px = (x: number, y: number) => device.readPixelsToArrayWebGL(fb, { sourceX: x, sourceY: H - 1 - y, sourceWidth: 1, sourceHeight: 1 });
    expect(px(32, 32)[0]).toBeGreaterThan(200);   // center -> red
    const corner = px(32 + 11, 32 + 11);          // ~ (r,r) diagonal ≈ 15.5 > 12 -> outside disc
    expect(corner[0]).toBeLessThan(40);
    r.destroy(); fb.destroy(); device.destroy();
  });
});
