import type { PathContext } from "../core/index.js";
import { flattenArc } from "../core/index.js";

/** Round to 3 decimals and drop trailing zeros (compact, deterministic output). */
function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/**
 * A PathContext that accumulates an SVG path `d` string. Used for publication
 * vector export: re-run a d3 generator (geoPath, d3-shape, …) into this context
 * and read `toPath()`. Curves map to native C/Q commands; arcs are flattened to
 * line segments (correct geometry; geo export is polygons/lines, so this is rare).
 *
 * `tolerance` controls only arc flattening and is independent of a `PathRecorder`'s
 * tolerance — pass the same value if you need the SVG arc density to match the GPU.
 */
export class SvgPathContext implements PathContext {
  private d = "";
  // Accumulated translate offset (see PathContext.translate). arc()/arcTo() delegate to
  // moveTo/lineTo, so applying it in the primitive emitters below covers every command.
  private tx = 0;
  private ty = 0;

  constructor(public tolerance = 0.25) {}

  toPath(): string {
    return this.d;
  }

  beginPath(): void {
    this.d = "";
  }

  translate(dx: number, dy: number): void {
    this.tx += dx;
    this.ty += dy;
  }

  moveTo(x: number, y: number): void {
    this.d += `M${fmt(x + this.tx)},${fmt(y + this.ty)}`;
  }

  lineTo(x: number, y: number): void {
    this.d += `L${fmt(x + this.tx)},${fmt(y + this.ty)}`;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.d += `Q${fmt(cpx + this.tx)},${fmt(cpy + this.ty)},${fmt(x + this.tx)},${fmt(y + this.ty)}`;
  }

  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    this.d += `C${fmt(cp1x + this.tx)},${fmt(cp1y + this.ty)},${fmt(cp2x + this.tx)},${fmt(cp2y + this.ty)},${fmt(x + this.tx)},${fmt(y + this.ty)}`;
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise = false): void {
    const sx = x + radius * Math.cos(startAngle);
    const sy = y + radius * Math.sin(startAngle);
    if (this.d === "") this.moveTo(sx, sy);
    else this.lineTo(sx, sy);
    const pts: number[] = [];
    flattenArc(x, y, radius, startAngle, endAngle, counterclockwise, this.tolerance, pts);
    for (let i = 0; i < pts.length; i += 2) this.lineTo(pts[i]!, pts[i + 1]!);
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, _radius: number): void {
    // Same documented simplification as the GPU recorder: not a true tangent arc.
    this.lineTo(x1, y1);
    this.lineTo(x2, y2);
  }

  rect(x: number, y: number, w: number, h: number): void {
    x += this.tx;
    y += this.ty;
    this.d += `M${fmt(x)},${fmt(y)}L${fmt(x + w)},${fmt(y)}L${fmt(x + w)},${fmt(y + h)}L${fmt(x)},${fmt(y + h)}Z`;
  }

  closePath(): void {
    this.d += "Z";
  }
}
