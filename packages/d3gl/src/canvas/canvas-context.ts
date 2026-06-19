import type { PathContext } from "../core/index.js";

/**
 * Immediate-mode backend: forwards PathContext calls straight to a real
 * CanvasRenderingContext2D. This is the publication/fallback path and behaves
 * exactly like drawing with d3 to a canvas today. fill()/stroke() take a style
 * so callers don't poke 2D-context properties directly.
 */
export class CanvasContext implements PathContext {
  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  beginPath(): void {
    this.ctx.beginPath();
  }
  translate(dx: number, dy: number): void {
    this.ctx.translate(dx, dy);
  }
  moveTo(x: number, y: number): void {
    this.ctx.moveTo(x, y);
  }
  lineTo(x: number, y: number): void {
    this.ctx.lineTo(x, y);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.ctx.quadraticCurveTo(cpx, cpy, x, y);
  }
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    this.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false,
  ): void {
    this.ctx.arc(x, y, radius, startAngle, endAngle, counterclockwise);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    this.ctx.arcTo(x1, y1, x2, y2, radius);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.ctx.rect(x, y, w, h);
  }
  closePath(): void {
    this.ctx.closePath();
  }

  /** Fill the current path with the given style. */
  fill(style: string): void {
    this.ctx.fillStyle = style;
    this.ctx.fill();
  }

  /** Stroke the current path with the given style and width. */
  stroke(style: string, width = 1): void {
    this.ctx.strokeStyle = style;
    this.ctx.lineWidth = width;
    this.ctx.stroke();
  }
}
