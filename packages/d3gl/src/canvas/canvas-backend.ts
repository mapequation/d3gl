import type { Backend, RenderLayer, RenderDelta, ViewTransform, DrawableVector } from "../core/index.js";
import { svgFromLayers } from "../svg/index.js";

const css = (c: readonly [number, number, number, number]) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] / 255).toFixed(4)})`;

/** The persistent clip currently applied to the context (for incremental append):
 *  which layer it's for and at which transform, so we only re-clip when those change. */
interface ActiveClip {
  layer: string;
  k: number;
  x: number;
  y: number;
}

export class CanvasBackend implements Backend {
  private ctx: CanvasRenderingContext2D;
  private layers: RenderLayer[] = [];
  private transform: ViewTransform = { k: 1, x: 0, y: 0 };
  /** Clip silhouette per source-layer name, built once (not re-traced per batch). */
  private clipCache = new Map<string, Path2D>();
  /** A clip left applied across incremental appends (clip-once, draw-many). */
  private activeClip: ActiveClip | null = null;

  constructor(private canvas: HTMLCanvasElement, private width: number, private height: number) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("CanvasBackend: 2D context unavailable");
    this.ctx = ctx;
  }

  setLayers(layers: RenderLayer[]): void {
    this.releaseClip();
    this.clipCache.clear();
    this.layers = layers;
  }

  updateLayer(name: string, layer: RenderLayer): void {
    this.releaseClip();
    this.clipCache.delete(name); // this layer's geometry may have changed → stale clip path
    const i = this.layers.findIndex((l) => l.name === name);
    if (i >= 0) this.layers[i] = layer;
    else this.layers.push(layer);
  }

  setTransform(t: ViewTransform): void {
    this.releaseClip(); // a moved view invalidates the persistent clip region
    this.transform = t;
  }

  /**
   * Incremental append (O(new)): accumulate the new drawables into the stored layer
   * (so a later full `render()` still draws everything), then draw ONLY those new
   * drawables on top — no clear. The clip (if any) is established ONCE and kept across
   * appends at a given transform, so each batch is just the new shapes — the canvas
   * analog of a GPU sub-buffer upload. Full redraws happen on transform/recolor/resize.
   */
  appendToLayer(delta: RenderDelta): void {
    const layer = this.layers.find((l) => l.name === delta.name);
    if (!layer) return; // layer is always registered (setLayers) before any append
    // Loop, not push(...spread): a big batch would exceed the argument-count limit.
    const acc = layer.drawables as DrawableVector[];
    for (const d of delta.drawables) acc.push(d);

    const { ctx } = this;
    const t = this.transform;
    if (layer.clipTo) {
      const reuse =
        this.activeClip?.layer === layer.name && this.activeClip.k === t.k && this.activeClip.x === t.x && this.activeClip.y === t.y;
      if (!reuse) {
        this.releaseClip(); // pop any stale clip
        ctx.setTransform(t.k, 0, 0, t.k, t.x, t.y);
        const path = this.clipPathFor(layer.clipTo);
        ctx.save();
        if (path) ctx.clip(path);
        this.activeClip = { layer: layer.name, k: t.k, x: t.x, y: t.y };
      } else {
        ctx.setTransform(t.k, 0, 0, t.k, t.x, t.y); // clip already applied; just (re)assert the transform
      }
    } else {
      this.releaseClip();
      ctx.setTransform(t.k, 0, 0, t.k, t.x, t.y);
    }
    this.drawShapes(delta.drawables, layer.sizeMode === "screen", t);
  }

  render(): void {
    const { ctx } = this;
    this.releaseClip(); // any persistent append-clip is replaced by the per-layer clips below
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const t = this.transform;
    ctx.setTransform(t.k, 0, 0, t.k, t.x, t.y);
    for (const layer of this.layers) {
      const path = layer.clipTo ? this.clipPathFor(layer.clipTo) : null;
      if (path) {
        ctx.save();
        ctx.clip(path);
      }
      this.drawShapes(layer.drawables, layer.sizeMode === "screen", t);
      if (path) ctx.restore();
    }
  }

  /** Pop a persistent append-clip if one is applied (balances its save()). */
  private releaseClip(): void {
    if (this.activeClip) {
      this.ctx.restore();
      this.activeClip = null;
    }
  }

  /** Build (once) and cache the clip silhouette for a source layer, in world coords.
   *  ctx.clip(path) then applies it under whatever transform is current. */
  private clipPathFor(srcName: string): Path2D | null {
    const cached = this.clipCache.get(srcName);
    if (cached) return cached;
    const src = this.layers.find((l) => l.name === srcName);
    if (!src) return null;
    const path = new Path2D();
    for (const d of src.drawables) {
      if ((d.flags & 1) === 0) continue;
      if (d.circles.length > 0) {
        for (const c of d.circles) {
          path.moveTo(c.x + c.r, c.y);
          path.arc(c.x, c.y, c.r, 0, 2 * Math.PI);
        }
      } else {
        for (const s of d.subpaths) {
          const p = s.points;
          if (p.length < 2) continue;
          path.moveTo(p[0]!, p[1]!);
          for (let i = 2; i < p.length; i += 2) path.lineTo(p[i]!, p[i + 1]!);
          if (s.closed) path.closePath();
        }
      }
    }
    this.clipCache.set(srcName, path);
    return path;
  }

  /** Draw the given drawables at the current transform (no clip management here). */
  private drawShapes(drawables: readonly DrawableVector[], screenMode: boolean, t: ViewTransform): void {
    const { ctx } = this;
    const fillStroke = (d: DrawableVector, strokeW: number): void => {
      if (d.fill[3] > 0) { ctx.fillStyle = css(d.fill); ctx.fill(); }
      if (d.stroke[3] > 0 && strokeW > 0) { ctx.strokeStyle = css(d.stroke); ctx.lineWidth = strokeW; ctx.stroke(); }
    };
    for (const d of drawables) {
      if ((d.flags & 1) === 0) continue;
      if (d.circles.length > 0) {
        for (const c of d.circles) {
          if (screenMode) {
            // Constant pixel radius: draw in identity transform at projected screen coords.
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
        // Anchored glyph: constant pixel size around the projected anchor.
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
        // World path. In screen mode, stroke width is constant px (divide by k since the
        // context is scaled by k).
        ctx.beginPath();
        for (const s of d.subpaths) {
          const p = s.points; if (p.length < 2) continue;
          ctx.moveTo(p[0]!, p[1]!);
          for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
          if (s.closed) ctx.closePath();
        }
        fillStroke(d, screenMode ? d.lineWidth / t.k : d.lineWidth);
      }
    }
  }

  toPNG(): string { this.render(); return this.canvas.toDataURL("image/png"); }
  toSVG(): string { return svgFromLayers(this.width, this.height, this.layers, this.transform); }
  destroy(): void {
    this.releaseClip();
    this.layers = [];
    this.clipCache.clear();
  }
}
