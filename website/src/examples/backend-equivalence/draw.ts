import { schemeCategory10 } from "d3-scale-chromatic";
import type { Plot } from "@mapequation/d3gl/map";

// ---------------------------------------------------------------------------
// Scene 1 — overlapping bordered shapes (draw-order probe)
// ---------------------------------------------------------------------------

/** One bordered shape: an opaque category-colored disc with a thick white border. */
export interface Shape {
  cx: number;
  cy: number;
  r: number;
  fill: string;
}

/**
 * A "flower" cluster of heavily-overlapping discs (centre disc + a ring around it),
 * each opaque-filled with a thick white border. Because the discs overlap and are drawn
 * in order, every disc's border is partly covered by later discs' fills — so this is a
 * sensitive probe of fill/stroke DRAW ORDER. WebGL used to draw all fills then all
 * strokes (borders on top); now it composites per drawable like Canvas/SVG.
 */
function flower(cx: number, cy: number, r: number, petals: number, colorAt: (i: number) => string): Shape[] {
  const shapes: Shape[] = [{ cx, cy, r, fill: colorAt(0) }];
  const ringR = r * 1.05; // ring discs sit ~one radius out, so each overlaps the centre and its neighbours
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * 2 * Math.PI - Math.PI / 2;
    shapes.push({ cx: cx + Math.cos(a) * ringR, cy: cy + Math.sin(a) * ringR, r, fill: colorAt(i + 1) });
  }
  return shapes;
}

export function makeShapes(width: number, height: number): Shape[] {
  const palette = schemeCategory10 as string[];
  const colorAt = (i: number): string => palette[i % palette.length]!;
  const r = Math.min(width, height) * 0.165;
  return flower(width / 2, height / 2, r, 6, colorAt);
}

const BORDER_PX = 6; // thick white border so the occlusion divergence is unmistakable

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
    lineWidth: BORDER_PX,
    id: (_s, i) => i,
  });
  chart.render();
}

// ---------------------------------------------------------------------------
// Scene 2 — stroke joins & caps (a pie chart + overlapping rays)
// ---------------------------------------------------------------------------

/** Stroke style for the joins/caps scene — exposed as interactive controls in the example. */
export interface JoinStyle {
  lineJoin: "miter" | "bevel" | "round";
  lineCap: "butt" | "square" | "round";
  miterLimit: number;
}

/** One pie wedge (centre → arc → back to centre): a closed path whose corners are joins. */
interface Wedge { cx: number; cy: number; r: number; a0: number; a1: number; fill: string; }
/** One open segment crossing the pie, to show end caps (and how an end sits over another stroke). */
interface Ray { x0: number; y0: number; x1: number; y1: number; }

const PIE_FRACTIONS = [0.3, 0.14, 0.22, 0.18, 0.16]; // wedge sizes (sum ≈ 1)
const PIE_COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f"];
/** Semi-transparent black so overlapping borders darken where they stack, and a line end
 *  drawn over another stroke stays visible — instead of the opaque white of a pie chart. */
const STROKE_RGBA = "rgba(0, 0, 0, 0.55)";

function makeWedges(cx: number, cy: number, r: number): Wedge[] {
  let a = -Math.PI / 2;
  return PIE_FRACTIONS.map((f, i) => {
    const a0 = a;
    const a1 = a + f * 2 * Math.PI;
    a = a1;
    return { cx, cy, r, a0, a1, fill: PIE_COLORS[i % PIE_COLORS.length]! };
  });
}

/** Rays that cross the pie's rim (inner end over the fill, outer end on the background),
 *  so the chosen cap is visible at both ends and overlaps the wedge borders. */
function makeRays(cx: number, cy: number, r: number, n: number): Ray[] {
  const rays: Ray[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i + 0.5) * (2 * Math.PI / n) + 0.3;
    rays.push({
      x0: cx + Math.cos(a) * r * 0.5,
      y0: cy + Math.sin(a) * r * 0.5,
      x1: cx + Math.cos(a) * r * 1.32,
      y1: cy + Math.sin(a) * r * 1.32,
    });
  }
  return rays;
}

/**
 * A pie chart (closed wedges) with thick semi-transparent black borders plus a few open
 * rays crossing it. The wedge corners (sharp tips at the centre and rim) exercise JOINS —
 * miter spikes vs bevel cuts vs round arcs; the rays' ends exercise CAPS, and because the
 * borders are translucent you can see where a ray ends on top of a wedge border. Same look
 * on WebGL, Canvas, and SVG once joins/caps/miter-limit are pinned identically.
 */
export function drawJoinsScene(chart: Plot, width: number, height: number, style?: JoinStyle): void {
  const cx = width / 2;
  const cy = height * 0.5;
  const r = Math.min(width, height) * 0.3;
  const lineWidth = Math.max(7, Math.round(Math.min(width, height) * 0.055));
  const wedges = makeWedges(cx, cy, r);
  const rays = makeRays(cx, cy, r, 3);

  chart.layer("pie", wedges, {
    draw: (ctx, w) => {
      ctx.moveTo(w.cx, w.cy);
      ctx.arc(w.cx, w.cy, w.r, w.a0, w.a1);
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
