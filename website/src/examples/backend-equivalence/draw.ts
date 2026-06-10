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
// Scene 2 — stroke joins & caps (thick opaque polylines)
// ---------------------------------------------------------------------------

/** One thick open/closed polyline, to probe stroke joins (sharp/acute/closed) and end caps. */
export interface Line { pts: [number, number][]; closed?: boolean; color: string; }

export function makeLines(width: number, height: number): Line[] {
  const x = (f: number): number => width * f;
  const y = (f: number): number => height * f;
  return [
    // Zigzag with sharp alternating corners (joins) and two open ends (caps).
    { color: "#1f77b4", pts: [[x(0.1), y(0.3)], [x(0.3), y(0.12)], [x(0.5), y(0.3)], [x(0.7), y(0.12)], [x(0.9), y(0.3)]] },
    // A very acute spike — exceeds a small miter limit, so the miter falls back to bevel.
    { color: "#d62728", pts: [[x(0.12), y(0.62)], [x(0.5), y(0.42)], [x(0.88), y(0.62)]] },
    // A closed triangle: every corner is a (closed-path) join.
    { color: "#2ca02c", closed: true, pts: [[x(0.5), y(0.66)], [x(0.78), y(0.92)], [x(0.22), y(0.92)]] },
  ];
}

/** Add the stroke-joins/caps polyline scene to a Plot and render it. */
export function drawJoinsScene(chart: Plot, width: number, height: number, style?: JoinStyle): void {
  const lines = makeLines(width, height);
  const lineWidth = Math.max(8, Math.round(Math.min(width, height) * 0.07));
  chart.layer("joins", lines, {
    draw: (ctx, l) => {
      ctx.moveTo(l.pts[0]![0], l.pts[0]![1]);
      for (let i = 1; i < l.pts.length; i++) ctx.lineTo(l.pts[i]![0], l.pts[i]![1]);
      if (l.closed) ctx.closePath();
    },
    stroke: (l: Line) => l.color,
    lineWidth,
    lineJoin: style?.lineJoin,
    lineCap: style?.lineCap,
    miterLimit: style?.miterLimit,
    id: (_l, i) => i,
  });
  chart.render();
}

// ---------------------------------------------------------------------------
// Scene 3 — translucent pie chart (shows WebGL stroke compositing differences)
// ---------------------------------------------------------------------------

/** A pie wedge as an explicit low-poly path (centre → a few arc points → close) — deliberately
 *  NOT a smooth circle, so the rim corners are sharp enough to show miter spikes (as in the
 *  ancestral-ranges pies). */
export interface Wedge { pts: [number, number][]; fill: string; }
/** One open segment crossing the pie, to show end caps over another (translucent) stroke. */
export interface Ray { x0: number; y0: number; x1: number; y1: number; }

const PIE_FRACTIONS = [0.3, 0.14, 0.22, 0.18, 0.16];
const PIE_COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f"];
/** Semi-transparent black: overlapping borders darken where they stack and a line end stays
 *  visible over another stroke — and it reveals WebGL's stroke self-overlap (issue #41). */
const STROKE_RGBA = "rgba(0, 0, 0, 0.5)";
const ARC_STEPS = 3; // few steps per wedge arc ⇒ a low-poly, "less circular" pie

export function makeWedges(cx: number, cy: number, r: number): Wedge[] {
  let a = -Math.PI / 2;
  return PIE_FRACTIONS.map((f, i) => {
    const a0 = a;
    const a1 = a + f * 2 * Math.PI;
    a = a1;
    const pts: [number, number][] = [[cx, cy]];
    for (let s = 0; s <= ARC_STEPS; s++) {
      const t = a0 + (a1 - a0) * (s / ARC_STEPS);
      pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
    }
    return { pts, fill: PIE_COLORS[i % PIE_COLORS.length]! };
  });
}

export function makeRays(cx: number, cy: number, r: number, n: number): Ray[] {
  const rays: Ray[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i + 0.5) * (2 * Math.PI / n) + 0.3;
    rays.push({
      x0: cx + Math.cos(a) * r * 0.5, y0: cy + Math.sin(a) * r * 0.5,
      x1: cx + Math.cos(a) * r * 1.32, y1: cy + Math.sin(a) * r * 1.32,
    });
  }
  return rays;
}

/**
 * A low-poly pie chart (closed wedges) with thick semi-transparent black borders, plus a few
 * open rays crossing it. The sharp wedge corners exercise JOINS (miter spikes vs bevel vs round)
 * and the rays' ends exercise CAPS; the translucent border reveals where strokes overlap and
 * lets a ray-end sit visibly over a wedge border. It also surfaces WebGL's translucent
 * stroke-tessellation differences (see issue #41) — most visible with `miter`.
 */
export function drawPieScene(chart: Plot, width: number, height: number, style?: JoinStyle): void {
  const cx = width / 2;
  const cy = height * 0.5;
  const r = Math.min(width, height) * 0.3;
  const lineWidth = Math.max(7, Math.round(Math.min(width, height) * 0.05));
  const wedges = makeWedges(cx, cy, r);
  const rays = makeRays(cx, cy, r, 3);

  chart.layer("pie", wedges, {
    draw: (ctx, w) => {
      ctx.moveTo(w.pts[0]![0], w.pts[0]![1]);
      for (let i = 1; i < w.pts.length; i++) ctx.lineTo(w.pts[i]![0], w.pts[i]![1]);
      ctx.closePath();
    },
    fill: (w: Wedge) => w.fill,
    stroke: STROKE_RGBA,
    lineWidth,
    lineJoin: style?.lineJoin,
    miterLimit: style?.miterLimit,
    id: (_w, i) => i,
  });

  chart.layer("rays", rays, {
    draw: (ctx, ray) => {
      ctx.moveTo(ray.x0, ray.y0);
      ctx.lineTo(ray.x1, ray.y1);
    },
    stroke: STROKE_RGBA,
    lineWidth,
    lineCap: style?.lineCap,
    id: (_ray, i) => i,
  });

  chart.render();
}
