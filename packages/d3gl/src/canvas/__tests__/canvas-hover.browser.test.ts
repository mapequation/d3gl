import { describe, it, expect } from "vitest";
import { CanvasBackend } from "../canvas-backend.js";
import type { TextData } from "../../core/index.js";

// The one-label hover slot (#496) keeps the pixels under the hovered label and puts them back on clear. Its
// kept rectangle must cover everything the label paints, including the halo's miter spikes at sharp glyph
// corners, which reach up to TEXT_HALO_MITER_LIMIT × the halo width beyond the glyphs (#571).

const W = 200;
const H = 80;

describe("Canvas hover slot", () => {
  it("restores every pixel the hover painted, halo spikes included", () => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    document.body.appendChild(canvas);
    const backend = new CanvasBackend(canvas, W, H);
    backend.render(); // an empty frame: every pixel transparent
    const ctx = canvas.getContext("2d")!;
    const font = "16px sans-serif";
    ctx.font = font;
    const text = "WVWVW MNMN 1477"; // acute corners: their miter spikes reach farthest
    const width = ctx.measureText(text).width;
    const td: TextData = { x: 40, y: 40, text, font, color: "#000", halo: { color: "#00f", width: 3 } };

    backend.setHoverText({ text: td, width, height: 16 });
    const painted = ctx.getImageData(0, 0, W, H).data;
    let shown = 0;
    for (let i = 3; i < painted.length; i += 4) if (painted[i]! > 0) shown++;
    expect(shown).toBeGreaterThan(100); // the hover drew its chip and label

    backend.setHoverText(null);
    const after = ctx.getImageData(0, 0, W, H).data;
    let left = 0;
    for (let i = 3; i < after.length; i += 4) if (after[i]! > 0) left++;
    expect(left).toBe(0);
    backend.destroy();
    canvas.remove();
  });
});
