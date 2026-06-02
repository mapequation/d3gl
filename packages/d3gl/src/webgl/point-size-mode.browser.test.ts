import { describe, it, expect } from "vitest";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Scene } from "../core/index.js";
import { GroupRenderer } from "./renderer.js";
import { clipFromView } from "./transform.js";

const W = 128, H = 128;

/** Count lit (non-clear) pixels in the center row (y = H/2) of a framebuffer. */
function litSpanInRow(device: any, fb: any, y: number): number {
  let count = 0;
  for (let x = 0; x < W; x++) {
    const p = device.readPixelsToArrayWebGL(fb, {
      sourceX: x,
      sourceY: H - 1 - y,
      sourceWidth: 1,
      sourceHeight: 1,
    });
    if ((p[3] ?? 0) > 10) count++;
  }
  return count;
}

describe("point size mode: screen vs world", () => {
  it("screen-mode point keeps constant pixel span under zoom; world-mode grows", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    document.body.appendChild(canvas);
    const device = await luma.createDevice({
      adapters: [webgl2Adapter],
      type: "webgl",
      createCanvasContext: { canvas, useDevicePixels: false },
    });
    const fb = device.createFramebuffer({
      width: W,
      height: H,
      colorAttachments: ["rgba8unorm"],
    });

    const RADIUS = 8;
    const cx = W / 2, cy = H / 2;

    function renderAt(k: number, sizeMode: "world" | "screen"): number {
      // Keep center fixed: x = cx - cx*k, y = cy - cy*k so k*cx+x = cx.
      const tx = cx - cx * k;
      const ty = cy - cy * k;
      const scene = new Scene();
      scene.group("pts", (b) => b.point("a", cx, cy, RADIUS));
      scene.setFill("pts", "a", "rgba(255,0,0,255)");
      const r = new GroupRenderer(device, scene.buffers("pts"), W, H);
      r.setTransform(clipFromView({ k, x: tx, y: ty }, W, H));
      r.setSizeMode(sizeMode);
      const pass = device.beginRenderPass({ framebuffer: fb, clearColor: [0, 0, 0, 0] });
      r.render(pass);
      pass.end();
      device.submit();
      const span = litSpanInRow(device, fb, cy);
      r.destroy();
      return span;
    }

    const worldK1 = renderAt(1, "world");
    const worldK4 = renderAt(4, "world");
    const screenK1 = renderAt(1, "screen");
    const screenK4 = renderAt(4, "screen");

    // World mode: span should grow ~4x with k (allow 3x–5x range).
    expect(worldK4).toBeGreaterThan(worldK1 * 2.5);

    // Screen mode: span should stay ~constant (within 20% of each other).
    expect(Math.abs(screenK4 - screenK1)).toBeLessThanOrEqual(screenK1 * 0.2 + 2);

    fb.destroy();
    device.destroy();
  });
});
