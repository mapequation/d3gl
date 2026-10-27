import { describe, it, expect, beforeAll } from "vitest";
import { page } from "vitest/browser";
import { LabelLayer, resolveLabelStyle, DEFAULT_LABEL_TEXT, type LabelStyle, type LabelText } from "../label-layer.js";
import { paintTexts } from "../../canvas/draw-texts.js";
import { serializeTexts } from "../../svg/serialize.js";
import { TEXT_HALO_MITER_LIMIT, type TextData } from "../../core/index.js";

// #571: the WebGL overlay (an HTML label with a CSS text stroke), Canvas (`paintTexts`, also every export) and
// SVG (`serializeTexts`) draw the same halo, miter joins included. All three are rasterized by the browser and
// captured in ONE screenshot, so the comparison sees what a user sees. DOM text, fillText and SVG text can land
// a pixel apart, so each panel is compared with Canvas at their best alignment (a shift of up to SHIFT px), and
// by their total halo coverage.

const W = 120;
const H = 40;
const BG: [number, number, number] = [37, 99, 235]; // a saturated fill, so the white halo stands out
const DIGITS = "169 23 114";
const SHARP = "MNMN 1477"; // acute glyph corners, where joins and miter limits differ most
const SHIFT = 2;
const MARGIN = 4; // ignore the panel borders: only the label matters
// Measured in headless Chromium: with miter joins at TEXT_HALO_MITER_LIMIT, the three panels are pixel-identical
// (difference 0, coverage equal) for both labels at widths 1-3. On "MNMN 1477" at width 2, Canvas differs from
// them by 0.0035 with round joins (5% more halo) and by 0.015 at Canvas's default miter limit 10 (17% less);
// the old text-shadow glow by 0.015. The thresholds sit below those and leave room for DOM text and fillText
// to rasterize a little apart on other machines and fonts.
const MAX_DIFF = 0.002;
const MAX_MASS = 0.03;

type Panels = { overlay: Uint8ClampedArray; canvas: Uint8ClampedArray; svg: Uint8ClampedArray };

/** One row: the overlay label, the Canvas-painted label and the SVG label, on the same background. `paint`
 *  replaces `paintTexts` in the Canvas panel (for a negative control). */
function row(overlayStyle: LabelStyle | undefined, text: LabelText, label: string, paint = paintTexts): { el: HTMLElement; destroy: () => void } {
  const bg = `rgb(${BG.join(",")})`;
  const el = document.createElement("div");
  el.style.cssText = `display:flex;width:${3 * W}px;height:${H}px;background:${bg}`;
  const host = document.createElement("div");
  host.style.cssText = `position:relative;flex:none;width:${W}px;height:${H}px;overflow:hidden`;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText = `display:block;flex:none;width:${W}px;height:${H}px`;
  const td: TextData = { x: 20, y: 20, text: label, font: text.font, color: text.color, halo: text.halo };
  const svg = document.createElement("div");
  svg.style.cssText = `flex:none;width:${W}px;height:${H}px`;
  svg.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="display:block"><rect width="${W}" height="${H}" fill="${bg}"/>${serializeTexts([td])}</svg>`;
  el.append(host, canvas, svg);
  document.body.appendChild(el);

  const layer = new LabelLayer(host, (a) => a.text, undefined, overlayStyle);
  layer.update([{ id: 1, refX: 20, refY: 14, text: label }], { k: 1, x: 0, y: 0 }, { width: W, height: H });
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  paint(ctx, [td]);
  return { el, destroy: () => { layer.destroy(); el.remove(); } };
}

/** The three panels of a {@link row} as RGB pixel arrays, captured in one screenshot. */
async function capture(el: HTMLElement): Promise<Panels> {
  const base64 = await page.screenshot({ element: el, save: false });
  const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
  expect([bitmap.width, bitmap.height]).toEqual([3 * W, H]); // captured 1:1, not rescaled
  const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  return { overlay: ctx.getImageData(0, 0, W, H).data, canvas: ctx.getImageData(W, 0, W, H).data, svg: ctx.getImageData(2 * W, 0, W, H).data };
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

interface Comparison { mass: { overlay: number; canvas: number; svg: number }; diff: { overlay: number; svg: number } }

async function compare(overlayStyle: LabelStyle | undefined, text: LabelText, label: string, paint = paintTexts): Promise<Comparison> {
  const r = row(overlayStyle, text, label, paint);
  const p = await capture(r.el);
  r.destroy();
  return {
    mass: { overlay: haloMass(p.overlay), canvas: haloMass(p.canvas), svg: haloMass(p.svg) },
    diff: { overlay: alignedDiff(p.overlay, p.canvas), svg: alignedDiff(p.svg, p.canvas) },
  };
}

/** The overlay and SVG panels both match Canvas. */
function expectSame(c: Comparison): void {
  expect(c.mass.canvas).toBeGreaterThan(20);
  for (const k of ["overlay", "svg"] as const) {
    expect(Math.abs(c.mass[k] - c.mass.canvas) / c.mass.canvas).toBeLessThan(MAX_MASS);
    expect(c.diff[k]).toBeLessThan(MAX_DIFF);
  }
}

describe("label halo equivalence (#571)", () => {
  beforeAll(async () => {
    await page.viewport(3 * W + 40, H + 40); // small enough that the test frame is not scaled down
  });

  for (const label of [DIGITS, SHARP]) {
    it.each([1, 2, 3])(`the overlay and SVG stroke the same halo as Canvas, "${label}" at width %d`, async (width) => {
      const text = { ...DEFAULT_LABEL_TEXT, halo: { color: "#ffffff", width } };
      expectSame(await compare(resolveLabelStyle(undefined, undefined, text), text, label));
    });
  }

  it("draws a custom font and colour the same on every backend (#577)", async () => {
    const text = { font: "700 13px Georgia, serif", color: "#7f1d1d", halo: { color: "#ffffff", width: 1 } };
    expectSame(await compare(resolveLabelStyle(undefined, undefined, text), text, DIGITS));
  });

  it("draws no halo on any at width 0", async () => {
    const text = { ...DEFAULT_LABEL_TEXT, halo: { color: "#ffffff", width: 0 } };
    const { mass } = await compare(resolveLabelStyle(undefined, undefined, text), text, DIGITS);
    expect(Math.max(mass.overlay, mass.canvas, mass.svg)).toBeLessThan(1);
  });

  it("is not vacuous: the old text-shadow glow does not pass as the width-1 stroke", async () => {
    const glow = { ...resolveLabelStyle(undefined, undefined, { ...DEFAULT_LABEL_TEXT, halo: undefined }), textShadow: "0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff" };
    const { diff } = await compare(glow, DEFAULT_LABEL_TEXT, DIGITS);
    expect(diff.overlay).toBeGreaterThanOrEqual(MAX_DIFF);
  });

  // A Canvas halo stroked with another join or miter limit must not pass as the overlay's.
  const strokeWith = (join: CanvasLineJoin, limit: number) => (ctx: CanvasRenderingContext2D, texts: readonly TextData[]) => {
    const td = texts[0]!;
    ctx.font = td.font ?? "";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = td.halo?.color ?? "";
    ctx.lineWidth = 2 * (td.halo?.width ?? 0);
    ctx.lineJoin = join;
    ctx.miterLimit = limit;
    ctx.strokeText(td.text, td.x, td.y);
    ctx.fillStyle = td.color ?? "#000";
    ctx.fillText(td.text, td.x, td.y);
  };

  it.each([
    ["round joins", "round", TEXT_HALO_MITER_LIMIT],
    ["Canvas's default miter limit (10)", "miter", 10],
  ] as const)("is not vacuous: %s on Canvas do not pass as the overlay's halo", async (_name, join, limit) => {
    const text = { ...DEFAULT_LABEL_TEXT, halo: { color: "#ffffff", width: 2 } };
    const { diff } = await compare(resolveLabelStyle(undefined, undefined, text), text, SHARP, strokeWith(join, limit));
    expect(diff.overlay).toBeGreaterThanOrEqual(MAX_DIFF);
  });
});
