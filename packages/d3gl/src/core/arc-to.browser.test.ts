import { describe, it, expect } from "vitest";
import { PathRecorder } from "./path-recorder.js";
import { SvgPathContext } from "../svg/svg-context.js";
import { diffPixels, type PixelBuffer } from "../map/__tests__/backend-equivalence-harness.js";

/**
 * `arcTo` against the REFERENCE implementation (#86): the browser's own
 * `CanvasRenderingContext2D.arcTo`. `CanvasContext` forwards straight to it, so this is
 * literally what one of the three PathContext implementations does — the node tests can
 * only pin our flattening against itself, and the acceptance criterion is Canvas-2D
 * semantics.
 *
 * All three paths are rasterised by the SAME canvas rasteriser at the same size, so the
 * only thing the diff can see is the geometry each one described. The tolerance is the
 * flattening tolerance: at `0.02` world units the polyline is well under a pixel from the
 * true arc, so the frames agree to the position-tolerant diff's noise floor.
 */

const W = 220;
const H = 220;
const TOLERANCE = 0.02;

/** Corners chosen to span the interesting cases: right angles, an acute turn, an obtuse
 *  turn, and a radius that fills the whole corner. `[x0,y0, x1,y1, x2,y2, r]`. */
const CORNERS: { name: string; pts: [number, number, number, number, number, number]; r: number }[] = [
  { name: "right angle", pts: [40, 20, 180, 20, 180, 120], r: 40 },
  { name: "acute turn", pts: [30, 190, 170, 60, 40, 40], r: 25 },
  { name: "obtuse turn", pts: [20, 60, 110, 100, 200, 60], r: 60 },
  { name: "tiny radius", pts: [40, 20, 180, 20, 180, 120], r: 2 },
];

function blank(): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  return ctx;
}

function readback(ctx: CanvasRenderingContext2D): PixelBuffer {
  const img = ctx.getImageData(0, 0, W, H);
  return { width: W, height: H, data: new Uint8Array(img.data.buffer.slice(0)) };
}

/** Paint a path with a thick stroke — a corner that is squared instead of rounded (or an
 *  arc swept the long way) then covers a large, unmistakable block of pixels. */
function paint(ctx: CanvasRenderingContext2D, path: Path2D | null): PixelBuffer {
  ctx.fillStyle = "#1f77b4";
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 6;
  ctx.lineJoin = "round";
  if (path) {
    ctx.fill(path);
    ctx.stroke(path);
  } else {
    ctx.fill();
    ctx.stroke();
  }
  return readback(ctx);
}

/** The browser's own arcTo, via a real 2D context. */
function nativeFrame(trace: (ctx: CanvasRenderingContext2D) => void): PixelBuffer {
  const ctx = blank();
  ctx.beginPath();
  trace(ctx);
  ctx.closePath();
  return paint(ctx, null);
}

/** Our flattened polyline (what WebGL tessellates and what Canvas/SVG draw from the Scene). */
function recorderFrame(trace: (ctx: PathRecorder) => void): PixelBuffer {
  const rec = new PathRecorder(TOLERANCE);
  rec.beginPath();
  trace(rec);
  rec.closePath();
  const path = new Path2D();
  for (const sp of rec.subpaths) {
    const p = sp.points;
    if (p.length < 2) continue;
    path.moveTo(p[0] ?? 0, p[1] ?? 0);
    for (let i = 2; i < p.length; i += 2) path.lineTo(p[i] ?? 0, p[i + 1] ?? 0);
    if (sp.closed) path.closePath();
  }
  return paint(blank(), path);
}

/** The SVG path context's `d` string, rasterised through the same canvas via Path2D. */
function svgFrame(trace: (ctx: SvgPathContext) => void): PixelBuffer {
  const svg = new SvgPathContext(TOLERANCE);
  svg.beginPath();
  trace(svg);
  svg.closePath();
  return paint(blank(), new Path2D(svg.toPath()));
}

/** Trace one corner: current point → corner → outgoing direction, closed back to the start. */
function corner(c: (typeof CORNERS)[number]) {
  const [x0, y0, x1, y1, x2, y2] = c.pts;
  return (ctx: { moveTo(x: number, y: number): void; arcTo(a: number, b: number, cc: number, d: number, r: number): void; lineTo(x: number, y: number): void }): void => {
    ctx.moveTo(x0, y0);
    ctx.arcTo(x1, y1, x2, y2, c.r);
    ctx.lineTo(x2, y2);
  };
}

/** A rounded rectangle, the canonical arcTo consumer. */
function roundedRect(x: number, y: number, w: number, h: number, r: number) {
  return (ctx: { moveTo(x: number, y: number): void; arcTo(a: number, b: number, c: number, d: number, r: number): void }): void => {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
  };
}

describe("arcTo matches the browser's own Canvas-2D arcTo (#86)", () => {
  for (const c of CORNERS) {
    it(`${c.name}: recorder and SVG context both agree with native`, () => {
      const native = nativeFrame(corner(c));
      const rec = recorderFrame(corner(c));
      const svg = svgFrame(corner(c));
      // Sanity: the shapes actually painted (an all-white frame would diff to zero).
      const ink = diffPixels(native, blankFrame());
      expect(ink.mismatches).toBeGreaterThan(1500);
      expect(diffPixels(native, rec).fraction).toBeLessThan(0.005);
      expect(diffPixels(native, svg).fraction).toBeLessThan(0.005);
      expect(diffPixels(rec, svg).fraction).toBeLessThan(0.005);
    });
  }

  it("a rounded rectangle is pixel-identical to the native one", () => {
    const trace = roundedRect(20, 20, 180, 120, 34);
    const native = nativeFrame(trace);
    expect(diffPixels(native, recorderFrame(trace)).fraction).toBeLessThan(0.005);
    expect(diffPixels(native, svgFrame(trace)).fraction).toBeLessThan(0.005);
  });

  it("fully-round ends (radius = half the short side) still agree", () => {
    const trace = roundedRect(20, 60, 180, 100, 50);
    const native = nativeFrame(trace);
    expect(diffPixels(native, recorderFrame(trace)).fraction).toBeLessThan(0.005);
    expect(diffPixels(native, svgFrame(trace)).fraction).toBeLessThan(0.005);
  });

  it("degenerate corners collapse to a line exactly like native", () => {
    // r = 0, collinear points, and a coincident corner: Canvas lines to (x1, y1).
    const cases: [number, number, number, number, number, number, number][] = [
      [40, 40, 160, 40, 160, 160, 0],
      [40, 40, 100, 40, 160, 40, 30],
      [40, 40, 40, 40, 160, 160, 30],
    ];
    for (const [x0, y0, x1, y1, x2, y2, r] of cases) {
      const trace = (ctx: { moveTo(a: number, b: number): void; arcTo(a: number, b: number, c: number, d: number, e: number): void; lineTo(a: number, b: number): void }): void => {
        ctx.moveTo(x0, y0);
        ctx.arcTo(x1, y1, x2, y2, r);
        ctx.lineTo(x2, y2);
      };
      const native = nativeFrame(trace);
      expect(diffPixels(native, recorderFrame(trace)).fraction, `r=${r}`).toBeLessThan(0.005);
      expect(diffPixels(native, svgFrame(trace)).fraction, `r=${r}`).toBeLessThan(0.005);
    }
  });
});

/** An untouched white frame — the reference for the non-vacuity (ink) check. */
function blankFrame(): PixelBuffer {
  return readback(blank());
}
