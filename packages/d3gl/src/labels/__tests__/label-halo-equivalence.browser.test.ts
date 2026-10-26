import { describe, it, expect, beforeAll } from "vitest";
import { page } from "vitest/browser";
import { LabelLayer, resolveLabelStyle, DEFAULT_LABEL_TEXT, type LabelStyle, type LabelText } from "../label-layer.js";
import { paintTexts } from "../../canvas/draw-texts.js";

// #571: the WebGL overlay (an HTML label with a CSS text stroke) and Canvas/SVG/export (`paintTexts`) draw
// the same halo. Both are rasterized by the browser and captured in ONE screenshot, so the comparison sees
// what a user sees. DOM text and fillText can land a pixel apart, so the panels are compared at their best
// alignment (a shift of up to SHIFT px), and by their total halo coverage.

const W = 120;
const H = 40;
const BG: [number, number, number] = [37, 99, 235]; // a saturated fill, so the white halo stands out
const TEXT = "169 23 114";
const SHIFT = 2;
const MARGIN = 4; // ignore the panel borders: only the label matters
// Measured in headless Chromium: the stroke differs from Canvas by 0.0012 (width 1) and 0.0033 (width 2),
// the old text-shadow glow by 0.0149. The threshold sits between them with margin on both sides.
const MAX_DIFF = 0.005;
const MAX_MASS = 0.1;

/** One row: the overlay label on the left, the Canvas-painted label on the right, on the same background. */
function row(overlayStyle: LabelStyle | undefined, text: LabelText): { el: HTMLElement; destroy: () => void } {
  const bg = `rgb(${BG.join(",")})`;
  const el = document.createElement("div");
  el.style.cssText = `display:flex;width:${2 * W}px;height:${H}px;background:${bg}`;
  const host = document.createElement("div");
  host.style.cssText = `position:relative;flex:none;width:${W}px;height:${H}px;overflow:hidden`;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText = `display:block;flex:none;width:${W}px;height:${H}px`;
  el.append(host, canvas);
  document.body.appendChild(el);

  const layer = new LabelLayer(host, (a) => a.text, undefined, overlayStyle);
  layer.update([{ id: 1, refX: 20, refY: 14, text: TEXT }], { k: 1, x: 0, y: 0 }, { width: W, height: H });
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  paintTexts(ctx, [{ x: 20, y: 20, text: TEXT, font: text.font, color: text.color, halo: text.halo }]);
  return { el, destroy: () => { layer.destroy(); el.remove(); } };
}

/** The two panels of a {@link row} as RGB pixel arrays, captured in one screenshot. */
async function capture(el: HTMLElement): Promise<{ overlay: Uint8ClampedArray; canvas: Uint8ClampedArray }> {
  const base64 = await page.screenshot({ element: el, save: false });
  const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
  expect([bitmap.width, bitmap.height]).toEqual([2 * W, H]); // captured 1:1, not rescaled
  const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  return { overlay: ctx.getImageData(0, 0, W, H).data, canvas: ctx.getImageData(W, 0, W, H).data };
}

/** How white a pixel is relative to the background, 0..1: the halo's coverage (the dark text counts 0). */
function whiteness(p: Uint8ClampedArray, i: number): number {
  const lo = Math.min(p[i]!, p[i + 1]!, p[i + 2]!);
  return Math.max(0, Math.min(1, (lo - BG[0]) / (255 - BG[0])));
}

/** Total halo coverage in a panel's interior. */
function haloMass(p: Uint8ClampedArray): number {
  let m = 0;
  for (let y = MARGIN; y < H - MARGIN; y++) for (let x = MARGIN; x < W - MARGIN; x++) m += whiteness(p, (y * W + x) * 4);
  return m;
}

/** Mean per-channel difference (0..1) between the panels at their best alignment. */
function alignedDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let best = Infinity;
  for (let dy = -SHIFT; dy <= SHIFT; dy++) {
    for (let dx = -SHIFT; dx <= SHIFT; dx++) {
      let sum = 0, n = 0;
      for (let y = MARGIN; y < H - MARGIN; y++) {
        for (let x = MARGIN; x < W - MARGIN; x++) {
          const i = (y * W + x) * 4, j = ((y + dy) * W + (x + dx)) * 4;
          sum += Math.abs(a[i]! - b[j]!) + Math.abs(a[i + 1]! - b[j + 1]!) + Math.abs(a[i + 2]! - b[j + 2]!);
          n += 3;
        }
      }
      best = Math.min(best, sum / n / 255);
    }
  }
  return best;
}

async function compare(overlayStyle: LabelStyle | undefined, text: LabelText): Promise<{ mass: [number, number]; diff: number }> {
  const r = row(overlayStyle, text);
  const { overlay, canvas } = await capture(r.el);
  r.destroy();
  return { mass: [haloMass(overlay), haloMass(canvas)], diff: alignedDiff(overlay, canvas) };
}

describe("label halo equivalence (#571)", () => {
  beforeAll(async () => {
    await page.viewport(2 * W + 40, H + 40); // small enough that the test frame is not scaled down
  });

  it.each([1, 2])("the overlay strokes the same halo as Canvas at width %d", async (width) => {
    const text = { ...DEFAULT_LABEL_TEXT, halo: { color: "#ffffff", width } };
    const { mass, diff } = await compare(resolveLabelStyle(undefined, undefined, text), text);
    expect(mass[1]).toBeGreaterThan(20);
    expect(Math.abs(mass[0] - mass[1]) / mass[1]).toBeLessThan(MAX_MASS);
    expect(diff).toBeLessThan(MAX_DIFF);
  });

  it("draws a custom font and colour the same on the overlay as on Canvas (#577)", async () => {
    const text = { font: "700 13px Georgia, serif", color: "#7f1d1d", halo: { color: "#ffffff", width: 1 } };
    const { mass, diff } = await compare(resolveLabelStyle(undefined, undefined, text), text);
    expect(mass[1]).toBeGreaterThan(20);
    expect(Math.abs(mass[0] - mass[1]) / mass[1]).toBeLessThan(MAX_MASS);
    expect(diff).toBeLessThan(MAX_DIFF);
  });

  it("draws no halo on either at width 0", async () => {
    const text = { ...DEFAULT_LABEL_TEXT, halo: { color: "#ffffff", width: 0 } };
    const { mass } = await compare(resolveLabelStyle(undefined, undefined, text), text);
    expect(mass[0]).toBeLessThan(1);
    expect(mass[1]).toBeLessThan(1);
  });

  it("is not vacuous: the old text-shadow glow does not pass as the width-1 stroke", async () => {
    const glow = { ...resolveLabelStyle(undefined, undefined, { ...DEFAULT_LABEL_TEXT, halo: undefined }), textShadow: "0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff" };
    const { diff } = await compare(glow, DEFAULT_LABEL_TEXT);
    expect(diff).toBeGreaterThanOrEqual(MAX_DIFF);
  });
});
