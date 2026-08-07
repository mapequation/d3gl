/**
 * PathContext is the seam of d3gl: the subset of CanvasRenderingContext2D's
 * path API that d3 path-emitting generators (d3-geo geoPath, d3-shape, d3-chord,
 * d3-hierarchy links) actually call. Implement this once per backend and any of
 * those generators can render to that backend unchanged.
 *
 * The signatures intentionally match CanvasRenderingContext2D so a real 2D
 * context satisfies this interface structurally.
 */
export interface PathContext {
  beginPath(): void;
  /**
   * Shift all subsequent path coordinates by (dx, dy), accumulating like
   * CanvasRenderingContext2D.translate. The canonical d3 idiom for placing an
   * origin-centred generator (radial trees, chords, …) at an offset: call
   * `translate(cx, cy)` once, then run the generator into this context unchanged.
   *
   * This is the only transform in the seam — no rotate/scale/save/restore. Radial
   * generators bake angle into their coordinates, so a translation is all they need;
   * a richer transform stack would complicate every backend for no current consumer.
   * The offset is part of context state (not reset by beginPath) and, in retained
   * backends, lives only for the single drawable the callback is recording.
   */
  translate(dx: number, dy: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  /**
   * Tangent arc with Canvas-2D semantics (#86): line to the point where the circle of
   * `radius` touches the segment from the current point towards `(x1, y1)`, then sweep the
   * short arc to where it touches the segment from `(x1, y1)` towards `(x2, y2)`, leaving
   * the current point there. The rounded-corner primitive (rounded bars, CSS-style cards).
   * Degenerate inputs — zero radius, coincident or collinear points — draw a straight line
   * to `(x1, y1)`; a negative radius is an error. Retained backends bake it to a polyline
   * once, at `tolerance`, so every backend draws the identical geometry.
   */
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  closePath(): void;
}

/** A flattened subpath: a polyline plus whether it was closed. */
export interface Subpath {
  /** Interleaved x,y coordinates: [x0, y0, x1, y1, ...]. */
  points: number[];
  closed: boolean;
}
