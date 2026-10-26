import { describe, it, expect, beforeAll } from "vitest";
import { page } from "vitest/browser";
import { plot } from "./plot.js";

// #580: an oriented data label (`rotationOf`) is drawn at the same place and angle on every backend. WebGL
// draws it in the HTML overlay (a CSS rotate), Canvas with `ctx.rotate` and SVG with a `rotate()` transform,
// all from the one box the culler placed. Both screens are captured in ONE screenshot and their text ink is
// compared by its centroid and principal axis, which pins position and angle without depending on how two
// text rasterizers antialias.

const W = 200;
const H = 120;
const FONT = "16px sans-serif";
const TEXT = "Alpha Centauri";

interface Case { name: string; rotation: number; textAnchor?: "start" | "middle" | "end"; keepUpright?: boolean }
const CASES: Case[] = [
  { name: "30° from the anchor", rotation: Math.PI / 6 },
  { name: "−60°, centred", rotation: -Math.PI / 3, textAnchor: "middle" },
  // Points left, so keepUpright turns it by π and runs the text from the other side of the anchor.
  { name: "150° kept upright", rotation: (5 * Math.PI) / 6, keepUpright: true },
];

beforeAll(async () => {
  await page.viewport(2 * W + 40, H + 40);
});

async function chart(host: HTMLElement, backend: "webgl" | "canvas", c: Case) {
  const p = plot(host, { width: W, height: H, backend });
  await p.whenReady();
  p.labels([{ x: W / 2, y: H / 2 }], {
    labelOf: () => TEXT,
    anchorOf: (d) => [d.x, d.y],
    rotationOf: () => c.rotation,
    textAnchor: c.textAnchor,
    keepUpright: c.keepUpright,
    font: FONT,
  });
  return p;
}

/** Centroid and principal-axis angle (radians, mod π) of a panel's dark text pixels. */
function inkMoments(p: Uint8ClampedArray): { cx: number; cy: number; angle: number } {
  let m = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const w = Math.max(0, 1 - Math.min(p[i]!, p[i + 1]!, p[i + 2]!) / 160); // dark text only, not the white halo
      m += w; sx += w * x; sy += w * y; sxx += w * x * x; syy += w * y * y; sxy += w * x * y;
    }
  }
  const cx = sx / m, cy = sy / m;
  const mu20 = sxx / m - cx * cx, mu02 = syy / m - cy * cy, mu11 = sxy / m - cx * cy;
  return { cx, cy, angle: 0.5 * Math.atan2(2 * mu11, mu20 - mu02) };
}

/** Difference of two axis angles, folded into [0, π/2]. */
function axisDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

describe("oriented data labels draw the same on WebGL and Canvas (#580)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const row = document.createElement("div");
      row.style.cssText = `display:flex;width:${2 * W}px;height:${H}px;background:#fff`;
      const gl = document.createElement("div");
      const cv = document.createElement("div");
      for (const h of [gl, cv]) { h.style.cssText = `position:relative;flex:none;width:${W}px;height:${H}px;overflow:hidden`; row.appendChild(h); }
      document.body.appendChild(row);
      const a = await chart(gl, "webgl", c);
      const b = await chart(cv, "canvas", c);

      const base64 = await page.screenshot({ element: row, save: false });
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      expect([bitmap.width, bitmap.height]).toEqual([2 * W, H]); // captured 1:1, not rescaled
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const onGL = inkMoments(ctx.getImageData(0, 0, W, H).data);
      const onCanvas = inkMoments(ctx.getImageData(W, 0, W, H).data);

      // The expected axis: the rendered rotation is the given one, or π more when flipped (the same axis).
      expect(axisDelta(onGL.angle, c.rotation)).toBeLessThan((2 * Math.PI) / 180);
      expect(axisDelta(onCanvas.angle, onGL.angle)).toBeLessThan((2 * Math.PI) / 180);
      expect(Math.hypot(onCanvas.cx - onGL.cx, onCanvas.cy - onGL.cy)).toBeLessThan(1.5);

      a.destroy();
      b.destroy();
      row.remove();
    });
  }

  it("toSVG() carries the same rotated <text> from WebGL and Canvas", async () => {
    const c: Case = { name: "", rotation: (5 * Math.PI) / 6, keepUpright: true };
    const gl = document.createElement("div");
    const cv = document.createElement("div");
    document.body.append(gl, cv);
    const a = await chart(gl, "webgl", c);
    const b = await chart(cv, "canvas", c);
    const text = (svg: string) => svg.match(/<text[^>]*>[^<]*<\/text>/g) ?? [];
    const fromGL = text(a.toSVG());
    expect(fromGL.length).toBe(1);
    expect(text(b.toSVG())).toEqual(fromGL);
    // Flipped: drawn at 150° + 180° = 330°, from the end of the text, about the anchor.
    expect(fromGL[0]).toContain(`transform="rotate(330 ${W / 2} ${H / 2})"`);
    expect(fromGL[0]).toContain('text-anchor="end"');
    a.destroy();
    b.destroy();
    gl.remove();
    cv.remove();
  });
});
