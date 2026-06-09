import { schemeCategory10 } from "d3-scale-chromatic";
import { plot, type Plot } from "@mapequation/d3gl/map";
import type { ImperativeSetup } from "../types.js";

/**
 * One bordered shape: an opaque category-colored disc with a thick white border.
 * Drawn in array order, so a later disc's fill paints over an earlier disc's
 * border where they overlap.
 */
export interface Shape {
  cx: number;
  cy: number;
  r: number;
  fill: string;
}

/**
 * A "flower" cluster of heavily-overlapping discs (centre disc + a ring around
 * it), each opaque-filled with a thick white border. This is the minimal repro
 * of issue #41's "overlapping polygon borders" divergence: because the discs
 * overlap and are drawn in order, every disc's white border is partly covered by
 * later discs' fills.
 *
 * - Canvas / SVG (painter's model, per-shape fill-then-stroke): a later disc's
 *   opaque fill OCCLUDES the earlier disc's white border in the overlap region —
 *   borders look broken / partially hidden.
 * - WebGL (current: all fills, then all strokes): every white border lands on top
 *   of all fills — all borders are fully visible.
 *
 * The fix makes WebGL composite like Canvas/SVG, so all three agree.
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

/** Build the overlapping-bordered-shapes scene. Pure d3gl — shared by the single-panel
 *  harness and the side-by-side backend-comparison component. */
export function makeShapes(width: number, height: number): Shape[] {
  const palette = schemeCategory10 as string[];
  const colorAt = (i: number): string => palette[i % palette.length]!;
  const r = Math.min(width, height) * 0.165;
  return flower(width / 2, height / 2, r, 6, colorAt);
}

const BORDER_PX = 6; // thick white border so the occlusion divergence is unmistakable

/** Add the overlapping-bordered-shapes layer to a Plot and render it. */
export function drawEquivalenceScene(chart: Plot, width: number, height: number): void {
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

/**
 * Overlapping bordered shapes (issue #41 repro). Renders a flower of opaque discs
 * with thick white borders. Switch the backend with the harness control to see
 * WebGL composite borders-on-top while Canvas/SVG occlude them — until the
 * draw-order fix makes all three agree. Pure d3gl; the harness owns controls/backend.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const chart = plot(host, { width, height, backend });
  chart.enableZoom([0.5, 40]);
  return {
    engine: chart,
    render: () => drawEquivalenceScene(chart, width, height),
  };
};
