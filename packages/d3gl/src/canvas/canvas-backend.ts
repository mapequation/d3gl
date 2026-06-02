import type { Backend, RenderLayer, ViewTransform, DrawableVector } from "../core/index.js";
import { svgFromLayers } from "../svg/index.js";

function trace(ctx: CanvasRenderingContext2D, d: DrawableVector): void {
  ctx.beginPath();
  for (const s of d.subpaths) {
    const p = s.points;
    if (p.length < 2) continue;
    ctx.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
    if (s.closed) ctx.closePath();
  }
}
const css = (c: readonly [number, number, number, number]) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] / 255).toFixed(4)})`;

export class CanvasBackend implements Backend {
  private ctx: CanvasRenderingContext2D;
  private layers: RenderLayer[] = [];
  private transform: ViewTransform = { k: 1, x: 0, y: 0 };

  constructor(private canvas: HTMLCanvasElement, private width: number, private height: number) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("CanvasBackend: 2D context unavailable");
    this.ctx = ctx;
  }
  setLayers(layers: RenderLayer[]): void { this.layers = layers; }
  updateLayer(name: string, layer: RenderLayer): void {
    const i = this.layers.findIndex((l) => l.name === name);
    if (i >= 0) this.layers[i] = layer; else this.layers.push(layer);
  }
  setTransform(t: ViewTransform): void { this.transform = t; }
  render(): void {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const t = this.transform;
    ctx.setTransform(t.k, 0, 0, t.k, t.x, t.y);
    for (const layer of this.layers) {
      const clipSrc = layer.clipTo ? this.layers.find((l) => l.name === layer.clipTo) : undefined;
      if (clipSrc) {
        ctx.save();
        ctx.beginPath();
        for (const d of clipSrc.drawables) if ((d.flags & 1) !== 0) {
          if (d.circles.length > 0) {
            for (const c of d.circles) { ctx.arc(c.x, c.y, c.r, 0, 2 * Math.PI); ctx.closePath(); }
          } else {
            for (const s of d.subpaths) {
              const p = s.points; if (p.length < 2) continue;
              ctx.moveTo(p[0]!, p[1]!);
              for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
              if (s.closed) ctx.closePath();
            }
          }
        }
        ctx.clip();
      }
      const screenMode = layer.sizeMode === "screen";
      const fillStroke = (d: DrawableVector, strokeW: number): void => {
        if (d.fill[3] > 0) { ctx.fillStyle = css(d.fill); ctx.fill(); }
        if (d.stroke[3] > 0 && strokeW > 0) { ctx.strokeStyle = css(d.stroke); ctx.lineWidth = strokeW; ctx.stroke(); }
      };
      for (const d of layer.drawables) {
        if ((d.flags & 1) === 0) continue;
        if (d.circles.length > 0) {
          // Circle drawable: arc per circle, honoring active clip.
          for (const c of d.circles) {
            if (screenMode) {
              // Draw in identity transform at projected screen coords (constant pixel radius).
              ctx.save();
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.beginPath();
              ctx.arc(t.k * c.x + t.x, t.k * c.y + t.y, c.r, 0, 2 * Math.PI);
              ctx.closePath();
              fillStroke(d, d.lineWidth);
              ctx.restore();
            } else {
              ctx.beginPath();
              ctx.arc(c.x, c.y, c.r, 0, 2 * Math.PI);
              ctx.closePath();
              fillStroke(d, d.lineWidth);
            }
          }
        } else if (screenMode && d.anchor) {
          // Anchored glyph: render at a constant pixel size around the projected anchor.
          const [ax, ay] = d.anchor;
          const ox = t.k * ax + t.x, oy = t.k * ay + t.y;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.beginPath();
          for (const s of d.subpaths) {
            const p = s.points; if (p.length < 2) continue;
            ctx.moveTo(ox + (p[0]! - ax), oy + (p[1]! - ay));
            for (let i = 2; i < p.length; i += 2) ctx.lineTo(ox + (p[i]! - ax), oy + (p[i + 1]! - ay));
            if (s.closed) ctx.closePath();
          }
          fillStroke(d, d.lineWidth);
          ctx.restore();
        } else {
          // World path. In screen mode, stroke width is constant px: divide by k since the
          // context is scaled by k (so k * lineWidth/k = lineWidth device px).
          trace(ctx, d);
          fillStroke(d, screenMode ? d.lineWidth / t.k : d.lineWidth);
        }
      }
      if (clipSrc) ctx.restore();
    }
  }
  toPNG(): string { this.render(); return this.canvas.toDataURL("image/png"); }
  toSVG(): string { return svgFromLayers(this.width, this.height, this.layers, this.transform); }
  destroy(): void { this.layers = []; }
}
