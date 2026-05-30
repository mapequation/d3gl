import { describe, it, expect } from "vitest";
import { Scene } from "@d3gl/core";
import { MapController } from "./controller.js";

const W = 64;
const H = 64;

function twoHalves() {
  const scene = new Scene();
  scene.group("cells", (g) => {
    g.drawable("a", (ctx) => ctx.rect(0, 0, W / 2, H));
    g.drawable("b", (ctx) => ctx.rect(W / 2, 0, W / 2, H));
  });
  return scene;
}

async function setup() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  const controller = await MapController.create(canvas, { width: W, height: H });
  return { controller, canvas };
}

describe("MapController", () => {
  it("renders a group's fill colors (via the offscreen framebuffer)", async () => {
    const { controller } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    controller.setGroup("cells", scene.buffers("cells"));
    controller.setTransform({ k: 1, x: 0, y: 0 });

    const left = controller.readPixel(16, 32);
    const right = controller.readPixel(48, 32);
    expect(left[0]).toBeGreaterThan(200);
    expect(right[2]).toBeGreaterThan(200);

    controller.destroy();
  });

  it("recolors via updateColors without a rebuild", async () => {
    const { controller } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    controller.setGroup("cells", scene.buffers("cells"));
    controller.setTransform({ k: 1, x: 0, y: 0 });
    expect(controller.readPixel(16, 32)[0]).toBeGreaterThan(200);

    scene.setFill("cells", "a", "#00ff00");
    controller.updateColors("cells", scene.buffers("cells"));
    expect(controller.readPixel(16, 32)[1]).toBeGreaterThan(200);

    controller.destroy();
  });

  it("picks the drawableId under a top-left screen pixel", async () => {
    const { controller } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    scene.setFill("cells", "b", "#0000ff");
    controller.setGroup("cells", scene.buffers("cells"));
    controller.setTransform({ k: 1, x: 0, y: 0 });
    expect(controller.pick("cells", 16, 32)).toBe(0);
    expect(controller.pick("cells", 48, 32)).toBe(1);
    controller.destroy();
  });

  it("exports a PNG data URL", async () => {
    const { controller } = await setup();
    const scene = twoHalves();
    scene.setFill("cells", "a", "#ff0000");
    controller.setGroup("cells", scene.buffers("cells"));
    controller.setTransform({ k: 1, x: 0, y: 0 });
    const url = controller.toPNG();
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    controller.destroy();
  });
});
