import { describe, it, expect } from "vitest";
import { Scene } from "@d3gl/core";
import { MapController } from "./controller.js";

const W = 256;
const H = 256;

describe("MapController at example scale", () => {
  it("renders thousands of distinct tiled cells (offscreen readPixel)", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    document.body.appendChild(canvas);
    const controller = await MapController.create(canvas, { width: W, height: H });

    const cols = 64;
    const rows = 64; // 4096 cells
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
    for (const { col, row, id } of ids) {
      scene.setFill("cells", id, `rgb(${Math.round((col / 63) * 255)}, 0, ${Math.round((row / 63) * 255)})`);
    }

    controller.setGroup("cells", scene.buffers("cells"));
    controller.setTransform({ k: 1, x: 0, y: 0 });

    // readPixel takes top-left screen coords.
    const topLeft = controller.readPixel(8, 8);
    const topRight = controller.readPixel(248, 8);
    const bottomLeft = controller.readPixel(8, 248);

    expect(topRight[0]).toBeGreaterThan(topLeft[0] + 100); // red ramps with column
    expect(bottomLeft[2]).toBeGreaterThan(topLeft[2] + 100); // blue ramps with row

    controller.destroy();
  });
});
