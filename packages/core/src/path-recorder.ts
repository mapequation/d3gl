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

  /** Flattening tolerance in coordinate units. */
  constructor(public tolerance = 0.25) {}

  get subpaths(): readonly Subpath[] {
    return this.paths;
  }

  beginPath(): void {
    this.paths = [];
    this.current = null;
  }

  moveTo(x: number, y: number): void {
    this.current = { points: [x, y], closed: false };
    this.paths.push(this.current);
    this.cx = x;
    this.cy = y;
  }

  lineTo(x: number, y: number): void {
    if (!this.current) {
      this.moveTo(x, y);
      return;
    }
    this.current.points.push(x, y);
    this.cx = x;
    this.cy = y;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    if (!this.current) this.moveTo(this.cx, this.cy);
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
    if (!this.current) this.moveTo(this.cx, this.cy);
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
    const sx = x + radius * Math.cos(startAngle);
    const sy = y + radius * Math.sin(startAngle);
    if (!this.current) {
      this.moveTo(sx, sy);
    } else {
      this.current.points.push(sx, sy);
    }
    flattenArc(x, y, radius, startAngle, endAngle, counterclockwise, this.tolerance, this.current!.points);
    const len = this.current!.points.length;
    this.cx = this.current!.points[len - 2]!;
    this.cy = this.current!.points[len - 1]!;
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    // Minimal arcTo: approximate by a line to the tangent corner. d3 generators
    // rarely emit arcTo; full tangent-arc support is deferred until a consumer needs it.
    this.lineTo(x1, y1);
    this.lineTo(x2, y2);
    void radius;
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.current = { points: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true };
    this.paths.push(this.current);
    this.cx = x;
    this.cy = y;
  }

  closePath(): void {
    if (this.current) this.current.closed = true;
  }
}
