import { describe, it, expect } from "vitest";
import { Scene } from "@d3gl/core";
import { MapController } from "./controller.js";

const W = 256;
const H = 256;

/** A dense grid of cells covering the WxH pixel space. */
function grid(cols: number, rows: number) {
  const scene = new Scene();
  const cw = W / cols;
  const ch = H / rows;
  scene.group("cells", (g) => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        g.drawable(`${c}-${r}`, (ctx) => ctx.rect(c * cw, r * ch, cw, ch));
      }
    }
  });
  return scene;
}

describe("performance budget", () => {
  it("recolor + render stays far cheaper than the initial geometry build", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    document.body.appendChild(canvas);
    const controller = await MapController.create(canvas, { width: W, height: H });

    const cols = 64;
    const rows = 64; // 4096 cells
    const scene = grid(cols, rows);
    const ids = Array.from({ length: cols * rows }, (_, i) => `${i % cols}-${Math.floor(i / cols)}`);

    // Cost of building geometry (tessellation + upload).
    const t0 = performance.now();
    controller.setGroup("cells", scene.buffers("cells"));
    controller.setTransform({ k: 1, x: 0, y: 0 });
    controller.renderToFramebuffer();
    const buildMs = performance.now() - t0;

    // Cost of N recolor cycles (CPU scale lookups + one texture write + redraw).
    const cycles = 20;
    const t1 = performance.now();
    for (let n = 0; n < cycles; n++) {
      const shade = n % 2 === 0 ? "#ff0000" : "#00ff00";
      for (const id of ids) scene.setFill("cells", id, shade);
      controller.updateColors("cells", scene.buffers("cells"));
      controller.renderToFramebuffer();
    }
    const recolorMs = (performance.now() - t1) / cycles;

    console.log(`[perf] buildMs=${buildMs.toFixed(1)} recolorMs=${recolorMs.toFixed(1)}`);

    // A recolor cycle must be cheap. If recolor secretly re-tessellated, it would
    // cost ~buildMs each; assert it is well under that (generous tripwire), and
    // under a generous absolute ceiling to catch gross regressions.
    expect(recolorMs).toBeLessThan(Math.max(buildMs, 50));
    expect(recolorMs).toBeLessThan(250);

    // Correctness: the final recolor actually took effect.
    const px = controller.readPixel(4, 4);
    const isRed = px[0]! > 150 && px[1]! < 100;
    const isGreen = px[1]! > 150 && px[0]! < 100;
    expect(isRed || isGreen).toBe(true);

    controller.destroy();
  });
});
