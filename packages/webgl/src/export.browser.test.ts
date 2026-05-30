import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Scene } from "@d3gl/core";
import { GroupRenderer } from "./renderer.js";
import { clipFromView } from "./transform.js";
import { pickAt } from "./pick.js";
import { toPNG } from "./png.js";

const W = 64;
const H = 64;

async function setup() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  const device = await luma.createDevice({
    adapters: [webgl2Adapter],
    type: "webgl",
    createCanvasContext: { canvas, useDevicePixels: false },
  });
  const framebuffer = device.createFramebuffer({ width: W, height: H, colorAttachments: ["rgba8unorm"] });
  return { device, framebuffer };
}

function twoHalves() {
  const scene = new Scene();
  scene.group("cells", (g) => {
    g.drawable("a", (ctx) => ctx.rect(0, 0, W / 2, H));
    g.drawable("b", (ctx) => ctx.rect(W / 2, 0, W / 2, H));
  });
  return scene;
}

describe("pickAt", () => {
  it("returns the drawableId under a top-left-origin screen pixel", async () => {
    const { device, framebuffer } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    expect(pickAt(device, renderer, framebuffer, 16, 32, H)).toBe(0); // left -> "a"
    expect(pickAt(device, renderer, framebuffer, 48, 32, H)).toBe(1); // right -> "b"
    expect(pickAt(device, renderer, framebuffer, 16, 2, H)).toBe(0); // still over a near top

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });
});

describe("toPNG", () => {
  it("produces a PNG data URL from the rendered framebuffer", async () => {
    const { device, framebuffer } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
    renderer.render(pass);
    pass.end();
    device.submit();

    const url = toPNG(device, framebuffer, W, H);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(url.length).toBeGreaterThan(100);

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });
});
