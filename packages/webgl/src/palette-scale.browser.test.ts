import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Scene } from "@d3gl/core";
import { GroupRenderer } from "./renderer.js";
import { clipFromView } from "./transform.js";

const W = 260;
const H = 260;

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

function pixel(device: any, framebuffer: any, x: number, y: number): number[] {
  const p = device.readPixelsToArrayWebGL(framebuffer, { sourceX: x, sourceY: y, sourceWidth: 1, sourceHeight: 1 });
  return [p[0], p[1], p[2], p[3]];
}

describe("palette lookup across many ON-SCREEN tiled cells", () => {
  it("colors each tiled cell by its own drawableId (>256 visible drawables)", async () => {
    const { device, framebuffer } = await setup();
    const cols = 130;
    const rows = 130; // 16900 cells -> ~67600 fill verts (>65536, the 16-bit boundary)
    const cw = W / cols;
    const ch = H / rows;
    const ids: { col: number; row: number; id: string }[] = [];
    const scene = new Scene();
    scene.group("cells", (g) => {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const id = `${c}-${r}`;
          ids.push({ col: c, row: r, id });
          g.drawable(id, (ctx) => ctx.rect(c * cw, r * ch, cw, ch));
        }
      }
    });
    // Color each cell distinctly: red ramps with column, blue ramps with row.
    for (const { col, row, id } of ids) {
      const rr = Math.round((col / (cols - 1)) * 255);
      const bb = Math.round((row / (rows - 1)) * 255);
      scene.setFill("cells", id, `rgb(${rr}, 0, ${bb})`);
    }
    const lastId = ids[ids.length - 1]!.id; // highest drawableId
    void lastId;

    const renderer = new GroupRenderer(device, scene.buffers("cells"));
    renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, W, H));
    const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1] });
    renderer.render(pass);
    pass.end();
    device.submit();

    // readback origin is bottom-left; sample cell centres.
    const sample = (col: number, row: number) =>
      pixel(device, framebuffer, Math.floor((col + 0.5) * cw), Math.floor(H - 1 - (row + 0.5) * ch));

    const topLeft = sample(3, 3); // low col, low row -> low red, low blue
    const topRight = sample(125, 3); // high col -> high red
    const bottomLeft = sample(3, 125); // high row -> high blue

    expect(topRight[0]!).toBeGreaterThan(topLeft[0]! + 100); // red ramps with column
    expect(bottomLeft[2]!).toBeGreaterThan(topLeft[2]! + 100); // blue ramps with row
  });
});
