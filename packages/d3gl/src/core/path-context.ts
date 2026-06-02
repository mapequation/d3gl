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
