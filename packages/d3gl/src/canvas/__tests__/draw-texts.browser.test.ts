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
