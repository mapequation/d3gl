import type { Backend, RenderLayer, RenderDelta, ViewTransform, DrawableVector, PassThroughLayer, PointBatch, DrawBatch, ProjectedPath, StyleTables } from "../core/index.js";
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

  /** Canvas-2D persists drawn pixels between calls, so the canvas IS the pass-through
   *  accumulation buffer: points draw on top of the retained base map and stay there. */
  readonly supportsPassThrough = true;
  /** Pass-through layer metadata only (name / sizeMode / clip) — no retained geometry; the
   *  engine re-projects the point data each repaint and hands us batches via drawPassThrough. */
  private ptLayers = new Map<string, PassThroughLayer>();
  /** A frozen raster of the whole canvas captured at gesture start, plus the transform it was
   *  drawn at. While non-null we snapshot-pan (blit it under the delta transform) instead of
   *  re-rendering — the backend holds no point data to redraw, so a normal render would drop them. */
  private ptSnapshot: { canvas: HTMLCanvasElement; transform: ViewTransform } | null = null;

  /** Device pixels per CSS pixel (drawing buffer is CSS size × dpr — see backend-factory).
   *  Folded into every setTransform so the backend's drawing code stays in CSS-px coords while
   *  rendering at the physical resolution; 1 on a standard display (all the math below is ×1). */
  private dpr: number;

  constructor(private canvas: HTMLCanvasElement, private width: number, private height: number) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("CanvasBackend: 2D context unavailable");
    this.ctx = ctx;
    this.dpr = width > 0 ? canvas.width / width : 1;
  }

  /** Set the view transform (world → screen, CSS px) with the device-pixel scale folded in. */
  private setView(t: ViewTransform): void {
    this.ctx.setTransform(t.k * this.dpr, 0, 0, t.k * this.dpr, t.x * this.dpr, t.y * this.dpr);
  }
  /** Screen-space identity (1 CSS px = dpr device px), for constant-pixel glyphs/points. */
  private setScreen(): void {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }
  /** Clear the whole device-px backing store. */
  private clearAll(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Resize the CSS size + device-px backing store and re-read the dpr. Clears the canvas
   *  (setting canvas.width/height resets the bitmap and context state); the engine re-renders
   *  right after, which reapplies the view transform via setView. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    const ratio = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.dpr = ratio;
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

  /** Styles-only update: swap the stored vector view (the next render() repaints from
   *  it). Visibility flags feed the clip silhouette, so drop this layer's cached clip. */
  updateLayerStyles(name: string, _tables: StyleTables, drawables: DrawableVector[]): void {
    const layer = this.layers.find((l) => l.name === name);
    if (!layer) return;
    layer.drawables = drawables;
    this.clipCache.delete(name);
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
        this.setView(t);
        const path = this.clipPathFor(layer.clipTo);
        ctx.save();
        if (path) ctx.clip(path);
        this.activeClip = { layer: layer.name, k: t.k, x: t.x, y: t.y };
      } else {
        this.setView(t); // clip already applied; just (re)assert the transform
      }
    } else {
      this.releaseClip();
      this.setView(t);
    }
    this.drawShapes(delta.drawables, layer.sizeMode === "screen", t);
  }

  render(): void {
    // Mid-gesture with pass-through layers: blit the frozen snapshot under the delta
    // transform instead of re-rendering. A normal render would clear the canvas and redraw
    // only the retained layers — dropping the pass-through points (we hold no point data).
    if (this.ptSnapshot) { this.compositeSnapshot(); return; }
    const { ctx } = this;
    this.releaseClip(); // any persistent append-clip is replaced by the per-layer clips below
    this.clearAll();
    const t = this.transform;
    this.setView(t);
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

  setPassThroughLayer(layer: PassThroughLayer): void {
    this.ptLayers.set(layer.name, layer);
  }

  removePassThroughLayer(name: string): void {
    this.ptLayers.delete(name);
  }

  /**
   * Draw a batch of pass-through points onto the main canvas at the current transform.
   * - `"replace-first"` starts a fresh full repaint of the overlay: drop any snapshot, redraw
   *   the retained base via the normal render(), then draw this batch on top.
   * - `"replace-rest"` / `"append"` draw this batch on top of what's already there (no clear) —
   *   continuing a chunked repaint, or an incremental add.
   * (Single-batch draw; Task 7 time-slices large batches. No color grouping — YAGNI.)
   */
  drawPassThrough(name: string, batch: DrawBatch, mode: "replace-first" | "replace-rest" | "append"): void {
    if (mode === "replace-first") {
      this.ptSnapshot = null;       // a fresh repaint supersedes any in-flight snapshot-pan
      this.render();                // clears + redraws the retained base map
    }
    if (batch.points) this.drawPtBatch(name, batch.points);
    if (batch.paths) this.drawPathBatch(name, batch.paths);
  }

  /** Capture the current canvas + transform so render() can snapshot-pan during a gesture. */
  snapshotPassThrough(): void {
    const snap = document.createElement("canvas");
    snap.width = this.canvas.width;
    snap.height = this.canvas.height;
    snap.getContext("2d")!.drawImage(this.canvas, 0, 0);
    this.ptSnapshot = { canvas: snap, transform: { ...this.transform } };
  }

  /** Draw one batch of points in device/screen space, applying the current transform manually
   *  (mirrors the screen-mode circle path in drawShapes). The canvas is sized in device px with
   *  no DPR scale (see backend-factory.makeCanvas), so world→screen is exactly t.k*w + t.(x,y). */
  private drawPtBatch(name: string, batch: PointBatch): void {
    const { ctx } = this;
    const t = this.transform;
    const screen = this.ptLayers.get(name)?.sizeMode === "screen";
    const { positions, radii, colors, count } = batch;
    ctx.save();
    this.setScreen(); // points are positioned in screen (CSS) px; dpr maps to device px
    for (let i = 0; i < count; i++) {
      const sx = t.k * positions[i * 2]! + t.x;
      const sy = t.k * positions[i * 2 + 1]! + t.y;
      const r = screen ? radii[i]! : radii[i]! * t.k;
      const o = i * 4;
      ctx.fillStyle = `rgba(${colors[o]}, ${colors[o + 1]}, ${colors[o + 2]}, ${colors[o + 3]! / 255})`;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Draw projected path features (Polygon/Line/etc.) for a pass-through layer. World mode
   *  (the common case) mirrors the retained world path in drawShapes: scale the context by k
   *  and trace world coords, so a point drawn via drawPtBatch (sx = t.k*x + t.x) lands at the
   *  same screen location as a path vertex. Stroke width is the reference lineWidth (scaled
   *  with zoom by the context, matching retained world strokes). Screen-mode PT paths are a
   *  follow-up; world mode is what geo polygon/line pass-through needs today. */
  private drawPathBatch(_name: string, paths: readonly ProjectedPath[]): void {
    const { ctx } = this;
    const t = this.transform;
    ctx.save();
    this.setView(t);
    for (const p of paths) {
      const path = new Path2D();
      for (const s of p.subpaths) {
        const pts = s.points;
        if (pts.length < 2) continue;
        path.moveTo(pts[0]!, pts[1]!);
        for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i]!, pts[i + 1]!);
        if (s.closed) path.closePath();
      }
      if (p.fill) { ctx.fillStyle = css(p.fill); ctx.fill(path); }
      if (p.stroke && p.lineWidth > 0) { ctx.strokeStyle = css(p.stroke); ctx.lineWidth = p.lineWidth; ctx.stroke(path); }
    }
    ctx.restore();
  }

  /**
   * Snapshot-pan: clear, then blit the frozen snapshot under the delta from the transform it was
   * captured at (s) to the current transform (t). A world point w sat at s.k*w + s.offset in the
   * snapshot; it must now appear at t.k*w + t.offset. So a snapshot pixel p (= world (p-s.off)/s.k)
   * maps to (t.k/s.k)*p + (t.off - (t.k/s.k)*s.off). The canvas has no DPR scale, so p is already
   * in device px and no extra scaling is needed.
   */
  private compositeSnapshot(): void {
    const { ctx } = this;
    const s = this.ptSnapshot!.transform;
    const t = this.transform;
    const a = t.k / s.k;
    this.clearAll();
    // The snapshot is a device-px raster; the pan delta (t-s) is in CSS px, so scale it by dpr.
    ctx.setTransform(a, 0, 0, a, (t.x - a * s.x) * this.dpr, (t.y - a * s.y) * this.dpr);
    ctx.drawImage(this.ptSnapshot!.canvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
      if (d.stroke[3] > 0 && strokeW > 0) {
        ctx.strokeStyle = css(d.stroke);
        ctx.lineWidth = strokeW;
        // Match the WebGL stroke geometry (and SVG): explicit join/limit/cap, not the
        // Canvas defaults (which differ from SVG's default miter limit of 4).
        ctx.lineJoin = d.lineJoin;
        ctx.miterLimit = d.miterLimit;
        ctx.lineCap = d.lineCap;
        ctx.stroke();
      }
    };
    for (const d of drawables) {
      if ((d.flags & 1) === 0) continue;
      if (d.circles.length > 0) {
        for (const c of d.circles) {
          if (screenMode) {
            // Constant pixel radius: draw in screen space (CSS px) at projected screen coords.
            ctx.save();
            this.setScreen();
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
        this.setScreen();
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
    this.ptLayers.clear();
    this.ptSnapshot = null;
  }
}
