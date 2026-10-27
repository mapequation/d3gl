import { describe, it, expect } from "vitest";
import { paintTexts } from "../draw-texts.js";

/** Count pixels that are clearly the halo's blue (the text fill is black, the background transparent). */
function bluePixels(ctx: CanvasRenderingContext2D, width: number, height: number): number {
  const { data } = ctx.getImageData(0, 0, width, height);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 2]! > 128 && data[i]! < 100 && data[i + 3]! > 64) n++;
  return n;
}

describe("paintTexts halo", () => {
  it("strokes a halo of the given width behind the text", () => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.canvas.width = 60;
    ctx.canvas.height = 30;
    paintTexts(ctx, [{ x: 10, y: 15, text: "nn", font: "16px sans-serif", color: "#000", halo: { color: "#00f", width: 2 } }]);
    expect(bluePixels(ctx, 60, 30)).toBeGreaterThan(0);
  });

  it("draws no halo at width 0, whatever line width the context held before", () => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.canvas.width = 60;
    ctx.canvas.height = 30;
    // Canvas ignores `lineWidth = 0`, so a 0-width stroke would reuse the previous width.
    ctx.lineWidth = 8;
    paintTexts(ctx, [{ x: 10, y: 15, text: "nn", font: "16px sans-serif", color: "#000", halo: { color: "#00f", width: 0 } }]);
    expect(bluePixels(ctx, 60, 30)).toBe(0);
  });
});

/** Bounding box of the dark text pixels inside a backing-store rectangle, or null when it has none. */
function inkBox(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): { w: number; h: number; minX: number } | null {
  const { data } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let y = 0; y < y1 - y0; y++) {
    for (let x = 0; x < x1 - x0; x++) {
      if (data[(y * (x1 - x0) + x) * 4 + 3]! > 128) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
  }
  return minX === Infinity ? null : { w: maxX - minX, h: maxY - minY, minX: x0 + minX };
}

describe("paintTexts rotation (#580)", () => {
  it("turns a rotated label about its anchor and restores the caller's transform for the next one", () => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.canvas.width = 200;
    ctx.canvas.height = 200;
    ctx.scale(2, 2); // a dpr-2 backing store, as the Canvas backend's setScreen
    paintTexts(ctx, [
      { x: 20, y: 10, text: "Hello", rotation: Math.PI / 2, font: "16px sans-serif", color: "#000" },
      { x: 55, y: 80, text: "Hello", font: "16px sans-serif", color: "#000" },
    ]);
    const t = ctx.getTransform();
    expect([t.a, t.b, t.c, t.d, t.e, t.f]).toEqual([2, 0, 0, 2, 0, 0]);
    // The rotated label runs down from its anchor: taller than wide, in the top-left quarter.
    const rotated = inkBox(ctx, 0, 0, 100, 100);
    expect(rotated && rotated.h > 2 * rotated.w).toBe(true);
    // The plain label after it is flat, where it would be alone (x = 55 CSS px = 110 backing px).
    const plain = inkBox(ctx, 100, 120, 200, 200);
    expect(plain && plain.w > 2 * plain.h).toBe(true);
    expect(plain && Math.abs(plain.minX - 110)).toBeLessThan(4);
  });
});
