import type { PathContext, Subpath } from "./path-context.js";
import { flattenCubic, flattenQuadratic, flattenArc } from "./flatten.js";

/**
 * Records PathContext drawing calls into flattened polylines (subpaths).
 * This is the retained-mode capture used by GPU backends: call a d3 generator
 * into a PathRecorder once, then hand the subpaths to the tessellator.
 */
export class PathRecorder implements PathContext {
  private paths: Subpath[] = [];
  private current: Subpath | null = null;
  private cx = 0;
  private cy = 0;
  // Accumulated translate offset, baked into recorded coordinates (see PathContext.translate).
  private tx = 0;
  private ty = 0;

  /** Flattening tolerance in coordinate units. */
  constructor(public tolerance = 0.25) {}

  get subpaths(): readonly Subpath[] {
    return this.paths;
  }

  beginPath(): void {
    this.paths = [];
    this.current = null;
  }

  translate(dx: number, dy: number): void {
    this.tx += dx;
    this.ty += dy;
  }

  moveTo(x: number, y: number): void {
    x += this.tx;
    y += this.ty;
    this.current = { points: [x, y], closed: false };
    this.paths.push(this.current);
    this.cx = x;
    this.cy = y;
  }

  lineTo(x: number, y: number): void {
    x += this.tx;
    y += this.ty;
    if (!this.current) {
      // moveTo re-applies the offset, so pass the un-offset coordinate.
      this.moveTo(x - this.tx, y - this.ty);
      return;
    }
    this.current.points.push(x, y);
    this.cx = x;
    this.cy = y;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    cpx += this.tx; cpy += this.ty; x += this.tx; y += this.ty;
    if (!this.current) this.moveTo(this.cx - this.tx, this.cy - this.ty);
    flattenQuadratic(this.cx, this.cy, cpx, cpy, x, y, this.tolerance, this.current!.points);
    this.cx = x;
    this.cy = y;
  }

  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    cp1x += this.tx; cp1y += this.ty; cp2x += this.tx; cp2y += this.ty; x += this.tx; y += this.ty;
    if (!this.current) this.moveTo(this.cx - this.tx, this.cy - this.ty);
    flattenCubic(this.cx, this.cy, cp1x, cp1y, cp2x, cp2y, x, y, this.tolerance, this.current!.points);
    this.cx = x;
    this.cy = y;
  }

  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false,
  ): void {
    x += this.tx;
    y += this.ty;
    const sx = x + radius * Math.cos(startAngle);
    const sy = y + radius * Math.sin(startAngle);
    if (!this.current) {
      this.moveTo(sx - this.tx, sy - this.ty);
    } else {
      this.current.points.push(sx, sy);
    }
    flattenArc(x, y, radius, startAngle, endAngle, counterclockwise, this.tolerance, this.current!.points);
    const len = this.current!.points.length;
    this.cx = this.current!.points[len - 2]!;
    this.cy = this.current!.points[len - 1]!;
  }

  arcTo(_x1: number, _y1: number, _x2: number, _y2: number, _radius: number): void {
    // arcTo draws a tangent arc between two segments — NOT a polyline through the
    // control points. A naive line approximation would silently diverge from the
    // CanvasContext backend (which forwards to the real Canvas arcTo), so rather
    // than record geometry that is subtly wrong, we fail fast. d3's path-emitting
    // generators do not use arcTo; implement a real tangent-arc flattening when a
    // consumer actually needs it.
    throw new Error("PathRecorder.arcTo is not implemented yet");
  }

  rect(x: number, y: number, w: number, h: number): void {
    x += this.tx;
    y += this.ty;
    this.current = { points: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true };
    this.paths.push(this.current);
    this.cx = x;
    this.cy = y;
  }

  closePath(): void {
    if (this.current) this.current.closed = true;
  }
}
