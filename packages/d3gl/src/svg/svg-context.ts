import type { PathContext } from "../core/index.js";
import { flattenArc, flattenArcTo, DEFAULT_CURVE_TOLERANCE } from "../core/index.js";

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
 * `tolerance` controls only arc flattening (`arc` and `arcTo`) and is independent of a
 * `PathRecorder`'s tolerance — pass the same value if you need the SVG arc density to match
 * the GPU. Both default to {@link DEFAULT_CURVE_TOLERANCE}, the one source of truth the
 * engines' `curveTolerance` option also feeds (#45).
 */
export class SvgPathContext implements PathContext {
  private d = "";
  // Accumulated translate offset (see PathContext.translate), applied by every emitter below.
  private tx = 0;
  private ty = 0;
  // Current point, with the translate offset already applied, and whether there is one.
  // arcTo's tangent arc is defined relative to it, so it has to be tracked (moveTo/lineTo
  // alone can't be derived from the `d` string without re-parsing).
  private cx = 0;
  private cy = 0;
  private hasPoint = false;

  constructor(public tolerance = DEFAULT_CURVE_TOLERANCE) {}

  toPath(): string {
    return this.d;
  }

  beginPath(): void {
    this.d = "";
    this.hasPoint = false;
  }

  translate(dx: number, dy: number): void {
    this.tx += dx;
    this.ty += dy;
  }

  // moveTo/lineTo store the current point INLINE rather than via `mark()`: they are the two
  // commands `svg/serialize.ts` drives once per vertex of every drawable on an SVG push, so
  // they stay a straight-line body with no extra call.
  moveTo(x: number, y: number): void {
    const px = x + this.tx;
    const py = y + this.ty;
    this.cx = px;
    this.cy = py;
    this.hasPoint = true;
    this.d += `M${fmt(px)},${fmt(py)}`;
  }

  lineTo(x: number, y: number): void {
    const px = x + this.tx;
    const py = y + this.ty;
    this.cx = px;
    this.cy = py;
    this.hasPoint = true;
    this.d += `L${fmt(px)},${fmt(py)}`;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.d += `Q${fmt(cpx + this.tx)},${fmt(cpy + this.ty)},${fmt(x + this.tx)},${fmt(y + this.ty)}`;
    this.mark(x + this.tx, y + this.ty);
  }

  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    this.d += `C${fmt(cp1x + this.tx)},${fmt(cp1y + this.ty)},${fmt(cp2x + this.tx)},${fmt(cp2y + this.ty)},${fmt(x + this.tx)},${fmt(y + this.ty)}`;
    this.mark(x + this.tx, y + this.ty);
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise = false): void {
    const sx = x + radius * Math.cos(startAngle);
    const sy = y + radius * Math.sin(startAngle);
    if (!this.hasPoint) this.moveTo(sx, sy);
    else this.lineTo(sx, sy);
    const pts: number[] = [];
    flattenArc(x + this.tx, y + this.ty, radius, startAngle, endAngle, counterclockwise, this.tolerance, pts);
    this.emit(pts);
  }

  /** Tangent arc with Canvas-2D semantics — the same {@link flattenArcTo} the GPU
   *  recorder uses, so a rounded corner is the identical polyline on every backend (#86). */
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    if (!this.hasPoint) {
      // Canvas semantics: with no subpath yet, arcTo only seeds one at the corner.
      this.moveTo(x1, y1);
      return;
    }
    const pts: number[] = [];
    flattenArcTo(this.cx, this.cy, x1 + this.tx, y1 + this.ty, x2 + this.tx, y2 + this.ty, radius, this.tolerance, pts);
    this.emit(pts);
  }

  rect(x: number, y: number, w: number, h: number): void {
    x += this.tx;
    y += this.ty;
    this.d += `M${fmt(x)},${fmt(y)}L${fmt(x + w)},${fmt(y)}L${fmt(x + w)},${fmt(y + h)}L${fmt(x)},${fmt(y + h)}Z`;
    this.mark(x, y); // Canvas leaves the current point at the rect's origin
  }

  closePath(): void {
    this.d += "Z";
  }

  /** Emit a flattened run of absolute x,y pairs as `L` commands (already offset). */
  private emit(pts: readonly number[]): void {
    for (let i = 0; i + 1 < pts.length; i += 2) {
      this.mark(pts[i] ?? 0, pts[i + 1] ?? 0);
      this.d += `L${fmt(this.cx)},${fmt(this.cy)}`;
    }
  }

  /** Record the current point (coordinates already carry the translate offset). */
  private mark(x: number, y: number): void {
    this.cx = x;
    this.cy = y;
    this.hasPoint = true;
  }
}
