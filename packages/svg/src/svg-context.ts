import type { PathContext } from "@d3gl/core";
import { flattenArc } from "@d3gl/core";

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

  constructor(public tolerance = 0.25) {}

  toPath(): string {
    return this.d;
  }

  beginPath(): void {
    this.d = "";
  }

  moveTo(x: number, y: number): void {
    this.d += `M${fmt(x)},${fmt(y)}`;
  }

  lineTo(x: number, y: number): void {
    this.d += `L${fmt(x)},${fmt(y)}`;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.d += `Q${fmt(cpx)},${fmt(cpy)},${fmt(x)},${fmt(y)}`;
  }

  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    this.d += `C${fmt(cp1x)},${fmt(cp1y)},${fmt(cp2x)},${fmt(cp2y)},${fmt(x)},${fmt(y)}`;
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
    this.d += `M${fmt(x)},${fmt(y)}L${fmt(x + w)},${fmt(y)}L${fmt(x + w)},${fmt(y + h)}L${fmt(x)},${fmt(y + h)}Z`;
  }

  closePath(): void {
    this.d += "Z";
  }
}
