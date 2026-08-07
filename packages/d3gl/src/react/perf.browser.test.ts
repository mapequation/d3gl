import { describe, it, expect } from "vitest";
import { Scene } from "../core/index.js";
import { MapController } from "./controller.js";
import { perfBudget, perfN } from "../__tests__/perf-budget.js";

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

    // Deliberately capped near its calibrated size (#262). This guard's central assertion is a
    // RATIO — `recolorMs < buildMs * 0.25` — and buildMs is carried by an N-INDEPENDENT
    // shader-compile constant while recolorMs is ~1µs/drawable of d3-color parsing. The ratio
    // therefore inverts somewhere around 10k-50k drawables with no regression present at all, so
    // scaling this leg with the tier would manufacture a false failure. Raising the cap means
    // reformulating the assertion against an absolute per-drawable cost first.
    const N = perfN(4096, { max: 8192 });
    const cols = Math.max(1, Math.round(Math.sqrt(N)));
    const rows = Math.max(1, Math.ceil(N / cols));
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

    // A recolor cycle must be MUCH cheaper than a geometry build. If recolor
    // secretly re-tessellated it would cost ~buildMs each, so require it to stay
    // under a fraction of buildMs — this enforces the recolor-<<-build invariant
    // even on fast hardware (where buildMs itself is small). The small absolute
    // floor (5ms) only absorbs timer noise; it never lets recolor approach build.
    expect(recolorMs).toBeLessThan(Math.max(buildMs * 0.25, perfBudget(5)));
    // Gross-regression ceiling regardless of build cost.
    expect(recolorMs).toBeLessThan(perfBudget(250));

    // Correctness: the final recolor actually took effect.
    const px = controller.readPixel(4, 4);
    const isRed = px[0]! > 150 && px[1]! < 100;
    const isGreen = px[1]! > 150 && px[0]! < 100;
    expect(isRed || isGreen).toBe(true);

    controller.destroy();
  });
});
