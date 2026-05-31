import { describe, it, expect } from "vitest";
import { Scene } from "@d3gl/core";
import { CanvasBackend } from "../canvas-backend.js";

function rectLayer(name: string, x: number, y: number, w: number, h: number, color: string, clipTo?: string) {
  const scene = new Scene();
  scene.group(name, (b) => b.drawable("d", (c) => c.rect(x, y, w, h)));
  scene.setFill(name, "d", color);
  return { name, buffers: scene.buffers(name), drawables: scene.drawables(name), clipTo };
}

describe("CanvasBackend", () => {
  it("fills a rect and clips one layer to another (pixel-accurate)", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 100; canvas.height = 100;
    const backend = new CanvasBackend(canvas, 100, 100);
    // clip source: left half. clipped layer: full red, clipped to left half.
    const mask = rectLayer("mask", 0, 0, 50, 100, "rgb(0,0,0)");
    const red = rectLayer("red", 0, 0, 100, 100, "rgb(255,0,0)", "mask");
    backend.setLayers([mask, red]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    backend.render();
    const ctx = canvas.getContext("2d")!;
    const left = ctx.getImageData(25, 50, 1, 1).data;
    const right = ctx.getImageData(75, 50, 1, 1).data;
    expect(left[0]).toBeGreaterThan(200);   // red inside mask
    expect(right[0]).toBeLessThan(40);      // clipped out on the right
  });
});
