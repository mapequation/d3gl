import { schemeCategory10 } from "d3-scale-chromatic";
import type { Plot } from "@mapequation/d3gl/map";

/** Stroke style for the joins/caps scenes — exposed as interactive controls in the example. */
export interface JoinStyle {
  lineJoin: "miter" | "bevel" | "round";
  lineCap: "butt" | "square" | "round";
  miterLimit: number;
}

// ---------------------------------------------------------------------------
// Scene 1 — overlapping bordered shapes (draw-order probe)
// ---------------------------------------------------------------------------

/** One bordered shape: an opaque category-colored disc with a thick white border. */
export interface Shape { cx: number; cy: number; r: number; fill: string; }

/**
 * A "flower" cluster of heavily-overlapping discs (centre disc + a ring around it), each
 * opaque-filled with a thick white border. Because the discs overlap and are drawn in order,
 * each disc's border is partly covered by later discs' fills — a sensitive probe of fill/stroke
 * DRAW ORDER. WebGL used to draw all fills then all strokes (borders on top); it now composites
 * per drawable like Canvas/SVG.
 */
function flower(cx: number, cy: number, r: number, petals: number, colorAt: (i: number) => string): Shape[] {
  const shapes: Shape[] = [{ cx, cy, r, fill: colorAt(0) }];
  const ringR = r * 1.05;
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * 2 * Math.PI - Math.PI / 2;
    shapes.push({ cx: cx + Math.cos(a) * ringR, cy: cy + Math.sin(a) * ringR, r, fill: colorAt(i + 1) });
  }
  return shapes;
}

export function makeShapes(width: number, height: number): Shape[] {
  const palette = schemeCategory10 as string[];
  const r = Math.min(width, height) * 0.165;
  return flower(width / 2, height / 2, r, 6, (i) => palette[i % palette.length]!);
}

/** Add the overlapping-bordered-shapes layer to a Plot and render it. */
export function drawBordersScene(chart: Plot, width: number, height: number): void {
  const shapes = makeShapes(width, height);
  chart.layer("shapes", shapes, {
    draw: (ctx, s) => {
      ctx.moveTo(s.cx + s.r, s.cy);
      ctx.arc(s.cx, s.cy, s.r, 0, 2 * Math.PI);
      ctx.closePath();
    },
    fill: (s: Shape) => s.fill,
    stroke: "#ffffff",
    lineWidth: 6,
    id: (_s, i) => i,
  });
  chart.render();
}

// ---------------------------------------------------------------------------
// Scenes 2 & 3 — stroke joins & caps. ONE scene, rendered opaque (joins/caps probe)
// or translucent (which reveals WebGL's stroke self-overlap, issue #41).
// ---------------------------------------------------------------------------

/** One thick open/closed polyline — probes joins (sharp/acute/closed) and end caps. `rgb` is
 *  the base colour; the alpha comes from the scene's `opacity`. */
interface Line { pts: [number, number][]; closed?: boolean; rgb: string; }
/** One pie wedge (centre → smooth arc → close); the rim corners are joins. `fill` undefined
 *  leaves the wedge unfilled (exposes how its border stroke is built); `strokeRgb` is the base
 *  border colour, alpha from the scene's `opacity`. */
interface Wedge { cx: number; cy: number; r: number; a0: number; a1: number; fill?: string; strokeRgb: string; }

/** A falsy fill — the engine skips `setFill` for it, leaving the wedge unfilled. */
const NO_FILL = "";

/** Three overlapping polylines in the top half: an asymmetric zigzag, an acute spike, and a
 *  closed triangle — varied join angles plus open ends (caps). */
function makeLines(width: number, height: number): Line[] {
  const x = (f: number): number => width * f;
  const y = (f: number): number => height * f;
  return [
    { rgb: "31, 119, 180", pts: [[x(0.1), y(0.3)], [x(0.3), y(0.12)], [x(0.75), y(0.3)], [x(0.7), y(0.12)], [x(0.9), y(0.3)]] },
    { rgb: "214, 39, 40", pts: [[x(0.12), y(0.22)], [x(0.5), y(0.42)], [x(0.88), y(0.42)]] },
    { rgb: "44, 160, 44", closed: true, pts: [[x(0.5), y(0.26)], [x(0.78), y(0.5)], [x(0.22), y(0.5)]] },
  ];
}

const PIE_FRACTIONS = [0.2, 0.1, 0.14, 0.22, 0.18];
// Two wedges are left unfilled (undefined) so the border stroke construction is visible.
const PIE_FILLS: (string | undefined)[] = ["#4e79a7", "#f28e2b", undefined, undefined, "#59a14f"];
const PIE_STROKE_RGB = ["255, 0, 0", "255, 255, 0", "0, 255, 255", "255, 0, 255", "100, 100, 100"];

/** A pie of smooth-arc wedges in the bottom half (drawn with `ctx.arc`, not a polygon). */
function makeWedges(cx: number, cy: number, r: number): Wedge[] {
  let a = -Math.PI / 2;
  return PIE_FRACTIONS.map((f, i) => {
    const a0 = a;
    const a1 = a + f * 2 * Math.PI;
    a = a1;
    return { cx, cy, r, a0, a1, fill: PIE_FILLS[i], strokeRgb: PIE_STROKE_RGB[i % PIE_STROKE_RGB.length]! };
  });
}

/**
 * The shared stroke scene: three overlapping polylines (joins + caps) above a pie chart whose
 * wedges are drawn with `ctx.arc`. Rendered at `opacity` 1 it's a clean join/cap probe (all three
 * backends match); at `opacity` < 1 the translucent strokes reveal a WebGL-only difference — its
 * triangulated stroke double-blends slightly where a stroke self-overlaps (joins, and the wedge
 * rim), whereas Canvas/SVG composite each stroke as a single coverage. Some wedges are unfilled so
 * the border construction shows, and the lines overlap the pie so a translucent line-end also sits
 * visibly over a wedge border.
 */
export function drawStrokeScene(chart: Plot, width: number, height: number, opacity: number, style?: JoinStyle): void {
  const lineWidth = Math.max(7, Math.round(Math.min(width, height) * 0.05));
  const lines = makeLines(width, height);
  const wedges = makeWedges(width / 2, height * 0.75, Math.min(width, height) * 0.2);

  chart.layer("pie", wedges, {
    draw: (ctx, w) => {
      ctx.moveTo(w.cx, w.cy);
      ctx.arc(w.cx, w.cy, w.r, w.a0, w.a1);
      ctx.closePath();
    },
    fill: (w: Wedge) => w.fill ?? NO_FILL,
    stroke: (w: Wedge) => `rgba(${w.strokeRgb}, ${opacity})`,
    lineWidth,
    lineJoin: style?.lineJoin,
    miterLimit: style?.miterLimit,
    id: (_w, i) => i,
  });

  chart.layer("lines", lines, {
    draw: (ctx, l) => {
      ctx.moveTo(l.pts[0]![0], l.pts[0]![1]);
      for (let i = 1; i < l.pts.length; i++) ctx.lineTo(l.pts[i]![0], l.pts[i]![1]);
      if (l.closed) ctx.closePath();
    },
    stroke: (l: Line) => `rgba(${l.rgb}, ${opacity})`,
    lineWidth,
    lineJoin: style?.lineJoin,
    lineCap: style?.lineCap,
    miterLimit: style?.miterLimit,
    id: (_l, i) => i,
  });

  chart.render();
}
