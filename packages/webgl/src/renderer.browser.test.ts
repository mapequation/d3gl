import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Scene } from "@d3gl/core";
import { GroupRenderer } from "./renderer.js";
import { clipFromView } from "./transform.js";

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
  const framebuffer = device.createFramebuffer({
    width: W,
    height: H,
    colorAttachments: ["rgba8unorm"],
  });
  return { device, framebuffer, canvas };
}

/** Read the RGBA byte tuple at a framebuffer pixel (origin bottom-left). */
function pixel(device: any, framebuffer: any, x: number, y: number): number[] {
  const p = device.readPixelsToArrayWebGL(framebuffer, { sourceX: x, sourceY: y });
  return [p[0], p[1], p[2], p[3]];
}

/** Two rectangles: cell "a" left half, cell "b" right half of the WxH pixel space. */
function twoHalves() {
  const scene = new Scene();
  scene.group("cells", (g) => {
    g.drawable("a", (ctx) => ctx.rect(0, 0, W / 2, H));
    g.drawable("b", (ctx) => ctx.rect(W / 2, 0, W / 2, H));
  });
  return scene;
}

describe("GroupRenderer fill", () => {
  it("renders each drawable in its palette-table color", async () => {
    const { device, framebuffer } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000"); // red
    scene.setFill("cells", "b", "#0000ff"); // blue

    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
    renderer.render(pass);
    pass.end();
    device.submit();

    const left = pixel(device, framebuffer, 16, 32);
    const right = pixel(device, framebuffer, 48, 32);
    expect(left[0]).toBeGreaterThan(200); // red
    expect(left[2]).toBeLessThan(40);
    expect(right[2]).toBeGreaterThan(200); // blue
    expect(right[0]).toBeLessThan(40);

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });

  it("recolors via a texture update without recreating geometry", async () => {
    const { device, framebuffer } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const draw = () => {
      const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
      renderer.render(pass);
      pass.end();
      device.submit();
    };
    draw();
    expect(pixel(device, framebuffer, 16, 32)[0]).toBeGreaterThan(200); // a is red

    // Recolor a -> green and push only the color table.
    scene.setFill("cells", "a", "#00ff00");
    renderer.updateColors(scene.buffers("cells"));
    draw();
    const a = pixel(device, framebuffer, 16, 32);
    expect(a[1]).toBeGreaterThan(200); // now green
    expect(a[0]).toBeLessThan(40);

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });

  it("hides a drawable when its visible flag is cleared", async () => {
    const { device, framebuffer } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    scene.setFlag("cells", "a", 0); // hide a
    renderer.updateColors(scene.buffers("cells"));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
    renderer.render(pass);
    pass.end();
    device.submit();

    const a = pixel(device, framebuffer, 16, 32);
    expect(a[0]).toBeLessThan(40); // a's region shows the clear color, not red
    expect(pixel(device, framebuffer, 48, 32)[2]).toBeGreaterThan(200); // b still blue

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });
});

describe("GroupRenderer stroke + transform", () => {
  it("renders stroke geometry in the stroke color", async () => {
    const { device, framebuffer } = await setup();
    const scene = new Scene();
    // a centered box with a thick border; fill transparent (default), stroke green
    scene.group("cells", (g) => {
      g.drawable("box", (ctx) => ctx.rect(16, 16, 32, 32), { lineWidth: 8 });
    });
    scene.setStroke("cells", "box", "#00ff00");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));

    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
    renderer.render(pass);
    pass.end();
    device.submit();

    // a pixel on the top edge of the box (pixel-y≈16, readback y≈H-16) should be green stroke
    const edge = pixel(device, framebuffer, 32, H - 16);
    expect(edge[1]).toBeGreaterThan(150);
    // the box center should be clear (fill is transparent default)
    const center = pixel(device, framebuffer, 32, H - 32);
    expect(center[1]).toBeLessThan(80);

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });

  it("moves geometry by changing only the transform uniform", async () => {
    const { device, framebuffer } = await setup();
    const scene = new Scene();
    // a small square in the top-left pixel region [0,16]x[0,16]
    scene.group("cells", (g) => g.drawable("s", (ctx) => ctx.rect(0, 0, 16, 16)));
    scene.setFill("cells", "s", "#ff0000");
    const renderer = new GroupRenderer(device, scene.buffers("cells"));

    const draw = () => {
      const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
      renderer.render(pass);
      pass.end();
      device.submit();
    };

    // Identity: square occupies top-left pixels (readback y is bottom-up).
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
    draw();
    expect(pixel(device, framebuffer, 8, H - 8)[0]).toBeGreaterThan(200); // present top-left
    expect(pixel(device, framebuffer, 40, H - 8)[0]).toBeLessThan(40); // absent to the right

    // Pan right by 32px: square should now be at x≈32..48 (only transform changed).
    renderer.setTransform(clipFromView({ k: 1, x: 32, y: 0 }, W, H));
    draw();
    expect(pixel(device, framebuffer, 8, H - 8)[0]).toBeLessThan(40); // gone from top-left
    expect(pixel(device, framebuffer, 40, H - 8)[0]).toBeGreaterThan(200); // moved right

    renderer.destroy();
    framebuffer.destroy();
    device.destroy();
  });
});
