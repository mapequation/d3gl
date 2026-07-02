import { luma } from "@luma.gl/core";
import { webgl2Adapter, WebGLDevice, WEBGLFramebuffer } from "@luma.gl/webgl";
import type { Device, Framebuffer } from "@luma.gl/core";
import type { Backend, RenderLayer, RenderDelta, ViewTransform, InstancedLayer, InstancedHighlight } from "../core/index.js";
import type { GroupBuffers, GroupBufferDelta, PassThroughLayer, DrawBatch, StyleTables, DrawableVector } from "../core/index.js";
import { GroupRenderer } from "./renderer.js";
import { InstancedCircles, InstancedLines, InstancedArrows, InstancedHalfArrows } from "./instanced.js";
import { PickReadback } from "./pick-readback.js";
import { clipFromView } from "./transform.js";
import { toPNG } from "./png.js";
import { svgFromLayers } from "../svg/index.js";
import { GlobeRenderer } from "./globe.js";
import { PassThroughGL } from "./passthrough-gl.js";

export interface WebGLBackendOptions {
  width: number;
  height: number;
}

export class WebGLBackend implements Backend {
  readonly supportsPassThrough = true;
  private renderers = new Map<string, GroupRenderer>();
  private layers = new Map<string, RenderLayer>();
  private order: string[] = [];
  /** GPU-instanced primitive layers (the network lane), drawn after retained layers. */
  private instanced = new Map<string, InstancedCircles | InstancedLines | InstancedArrows | InstancedHalfArrows>();
  /** Names of instanced layers that opted into the GPU-readback pick pass (#141; link layers only). */
  private pickable = new Set<string>();
  /** Offscreen id-encoded pick target (device px). Lazily created when first picked; resized on demand. */
  private pickFbo: Framebuffer | null = null;
  /** Stall-free single-pixel readback (double-buffered PBO). Lazily created with the pick FBO. */
  private picker: PickReadback | null = null;
  /** Pick FBO is stale (link geometry or transform changed) ⇒ re-render the pick pass before reading. */
  private pickDirty = true;
  private clipMatrix: Float32Array;
  private viewTransform: ViewTransform = { k: 1, x: 0, y: 0 };
  private globe: GlobeRenderer | null = null; // non-null ⇒ globe mode active
  private bakeDirty = true;
  private bakeW = 2048;
  private bakeH = 1024;
  /** Pass-through accumulation surface (lazily created when the first PT layer registers). */
  private pt: PassThroughGL | null = null;
  /** Registered pass-through layer names; the composite is gated on this being non-empty. */
  private ptNames = new Set<string>();
  /** sizeMode of the active PT layer: true ⇒ screen (constant px), false ⇒ world. */
  private ptScreen = false;

  private constructor(
    private readonly device: Device,
    private offscreen: Framebuffer,
    private width: number,
    private height: number,
  ) {
    this.clipMatrix = clipFromView({ k: 1, x: 0, y: 0 }, width, height);
  }

  static async create(canvas: HTMLCanvasElement, opts: WebGLBackendOptions): Promise<WebGLBackend> {
    const device = await luma.createDevice({
      adapters: [webgl2Adapter],
      type: "webgl",
      // Render at the physical display resolution (buffer = CSS size × devicePixelRatio) so
      // thin strokes/points stay crisp on HiDPI screens, matching Canvas/SVG. Clip space is
      // normalized and screen-px math uses CSS-px viewport uniforms, so no shader changes are
      // needed — only the drawing-buffer/viewport resolution rises.
      createCanvasContext: { canvas, useDevicePixels: true },
      // Request a stencil buffer on the canvas drawing buffer so the ONSCREEN
      // render path can clip via the stencil test (WebGL defaults stencil:false).
      webgl: { stencil: true },
    });
    const offscreen = device.createFramebuffer({
      width: opts.width,
      height: opts.height,
      colorAttachments: ["rgba8unorm"],
      depthStencilAttachment: "depth24plus-stencil8",
    });
    return new WebGLBackend(device, offscreen, opts.width, opts.height);
  }

  setLayers(newLayers: RenderLayer[]): void {
    // Destroy old renderers
    for (const r of this.renderers.values()) r.destroy();
    this.renderers.clear();
    this.layers.clear();
    this.order = [];
    for (const layer of newLayers) {
      const renderer = new GroupRenderer(this.device, layer.buffers, this.width, this.height);
      renderer.setTransform(this.clipMatrix);
      this.renderers.set(layer.name, renderer);
      this.layers.set(layer.name, layer);
      this.order.push(layer.name);
    }
    this.bakeDirty = true;
  }

  /**
   * Replace a layer's geometry + tables: destroy the old renderer and rebuild from the
   * full buffers. `updateLayer` deliberately has NO same-count recolor shortcut: equal
   * drawable counts do NOT imply unchanged geometry (the hover overlay re-targets a
   * different drawable at the same count every pointer move). Styles-only changes go
   * through {@link updateLayerStyles}; appends through {@link appendToLayer} (O(new)).
   */
  updateLayer(name: string, layer: RenderLayer): void {
    this.renderers.get(name)?.destroy();
    const renderer = new GroupRenderer(this.device, layer.buffers, this.width, this.height);
    renderer.setTransform(this.clipMatrix);
    this.renderers.set(name, renderer);
    this.layers.set(name, layer);
    if (!this.order.includes(name)) this.order.push(name);
    this.bakeDirty = true;
  }

  /** WebGL renders from the GPU flag/color textures, not the vector view — the `drawables` arg
   *  to {@link updateLayerStyles} is only stashed for `toSVG` export. So the engine may omit it
   *  on hot paths (per-frame declutter) to skip an O(n) rebuild. */
  readonly stylesNeedDrawables = false;

  /** Styles-only update: rewrite the palette/flags textures, refresh the stored vector
   *  view (toSVG reads it), leave geometry buffers untouched. `drawables` omitted ⇒ keep the
   *  previously-stored vector view (export may lag the textures until the next update with it). */
  updateLayerStyles(name: string, tables: StyleTables, drawables?: DrawableVector[]): void {
    const renderer = this.renderers.get(name);
    if (!renderer) return;
    renderer.updateColors(tables);
    if (drawables) {
      const prev = this.layers.get(name);
      if (prev) this.layers.set(name, { ...prev, drawables });
    }
    this.bakeDirty = true;
  }

  /**
   * O(new) incremental append: grow the existing GroupRenderer's geometry buffers
   * (capacity-doubling) and color/flag textures with only the appended tail, instead of
   * rebuilding from full buffers. The engine calls this (not `updateLayer`) for appends.
   *
   * The layer is always registered (via `setLayers`) before any append, so the renderer
   * exists; if it somehow doesn't, we no-op (nothing to grow from a delta alone). If a new
   * geometry-type pass appears that can't be grown incrementally (renderer.append returns
   * false), fall back to a full rebuild via `updateLayer` so the result stays correct.
   */
  appendToLayer(delta: RenderDelta): void {
    const renderer = this.renderers.get(delta.name);
    if (!renderer) return;
    const ok = renderer.append(delta.buffers);
    if (!ok) {
      // A pass needed by the delta did not exist in the renderer yet — e.g. the layer
      // was created empty (all passes null) and the first geometry of some type arrives
      // now. We can't grow a null pass from a tail delta. But when fromDrawable === 0 the
      // delta IS the whole group (group-absolute indices from 0), so we can rebuild the
      // renderer from it. (For a *partial* new-pass-type append — uncommon, since layers
      // keep a stable geometry-type mix — this would be incomplete; documented limit.)
      if (delta.buffers.fromDrawable === 0) {
        renderer.destroy();
        const fresh = new GroupRenderer(this.device, deltaToBuffers(delta.buffers), this.width, this.height);
        fresh.setTransform(this.clipMatrix);
        this.renderers.set(delta.name, fresh);
      }
    }
    // Keep the stored layer's clip/sizeMode current (geometry lives in the renderer).
    const prev = this.layers.get(delta.name);
    if (prev) this.layers.set(delta.name, { ...prev, clipTo: delta.clipTo, sizeMode: delta.sizeMode });
    this.bakeDirty = true;
    // The engine does not call render() after appendToLayer (the backend is responsible
    // for making the append visible); render now (re-bakes if dirty in globe mode).
    this.render();
  }

  setPassThroughLayer(layer: PassThroughLayer): void {
    this.ptNames.add(layer.name);
    this.pt ??= new PassThroughGL(this.device, this.width, this.height);
    this.ptScreen = layer.sizeMode === "screen";
  }

  removePassThroughLayer(name: string): void {
    this.ptNames.delete(name);
    if (this.ptNames.size === 0) {
      this.pt?.destroy();
      this.pt = null;
    }
  }

  drawPassThrough(name: string, batch: DrawBatch, mode: "replace-first" | "replace-rest" | "append"): void {
    if (!this.pt) return;
    const clear = mode === "replace-first";
    this.pt.setScreenMode(this.ptScreen);
    // PassThroughGL records its fboTransform internally on a clear (replace-first).
    this.pt.draw(batch, this.viewTransform, clear);
    // The engine does NOT render() after drawPassThrough (mirrors appendToLayer); render now
    // so the freshly accumulated points are composited to screen.
    this.render();
  }

  /**
   * No-op for WebGL: the accumulation FBO persists across gestures and
   * `PassThroughGL.fboTransform` already records the reference transform (set on the last
   * clear), so the composite blit can offset it during a pan with no extra snapshot. (The
   * canvas backend, by contrast, must copy the canvas here because it has no retained FBO.)
   */
  snapshotPassThrough(): void {}

  setInstancedLayer(layer: InstancedLayer): void {
    this.instanced.get(layer.name)?.destroy();
    // Link layers (lines/arrows/half-arrows) may opt into the GPU-readback pick pass (#141); the
    // primitive builds an extra id-encoded pick model when `pick` is set. Nodes (circles) never do.
    const pick = layer.primitive !== "circles" && !!layer.pickable;
    const r =
      layer.primitive === "lines"
        ? new InstancedLines(this.device, layer.lines, this.width, this.height, pick)
        : layer.primitive === "arrows"
          ? new InstancedArrows(this.device, layer.arrows, this.width, this.height, pick)
          : layer.primitive === "half-arrows"
            ? new InstancedHalfArrows(this.device, layer.halfArrows, this.width, this.height, pick)
            : new InstancedCircles(this.device, layer.circles, this.width, this.height);
    r.setTransform(this.clipMatrix);
    r.setViewport(this.width, this.height);
    r.setSizeMode(layer.sizeMode ?? "world");
    this.instanced.set(layer.name, r);
    if (pick) this.pickable.add(layer.name);
    else this.pickable.delete(layer.name);
    this.pickDirty = true;
  }

  /**
   * Update-in-place for instanced layers: if the layer already exists as the matching
   * primitive type, call `update()` (GPU sub-upload, no teardown). Lines/arrows/half-arrows
   * return `false` from `update()` when a structural property changed (samples, half-flag) —
   * fall back to `setInstancedLayer` (destroy+recreate) in that case. Also recreates when the
   * primitive type changes (e.g. lines → arrows) OR when the layer's `pickable` state no longer
   * matches the existing renderer's pick-model presence (toggling `pickLinks` builds/drops the
   * id-encoded pick model, which `update()` can't do in place — see #141/#179).
   */
  updateInstancedLayer(layer: InstancedLayer): void {
    const existing = this.instanced.get(layer.name);
    // A pick-model presence mismatch (pickLinks toggled) must recreate: the in-place update path
    // never builds/drops the pick model, so an in-place update would leave the wrong pick state.
    const wantPick = layer.primitive !== "circles" && !!layer.pickable;
    const pickMismatch = existing !== undefined && !(existing instanceof InstancedCircles) && wantPick !== this.pickable.has(layer.name);
    if (existing instanceof InstancedCircles && layer.primitive === "circles") {
      existing.update(this.device, layer.circles);
      existing.setSizeMode(layer.sizeMode ?? "world");
    } else if (existing instanceof InstancedLines && layer.primitive === "lines" && !pickMismatch) {
      if (existing.update(this.device, layer.lines)) {
        existing.setSizeMode(layer.sizeMode ?? "world");
        this.pickDirty = true;
      } else {
        this.setInstancedLayer(layer);
      }
    } else if (existing instanceof InstancedArrows && layer.primitive === "arrows" && !pickMismatch) {
      if (existing.update(this.device, layer.arrows)) {
        existing.setSizeMode(layer.sizeMode ?? "world");
        this.pickDirty = true;
      } else {
        this.setInstancedLayer(layer);
      }
    } else if (existing instanceof InstancedHalfArrows && layer.primitive === "half-arrows" && !pickMismatch) {
      if (existing.update(this.device, layer.halfArrows)) {
        existing.setSizeMode(layer.sizeMode ?? "world");
        this.pickDirty = true;
      } else {
        this.setInstancedLayer(layer);
      }
    } else {
      this.setInstancedLayer(layer);
    }
  }

  removeInstancedLayer(name: string): void {
    this.instanced.get(name)?.destroy();
    this.instanced.delete(name);
    this.pickable.delete(name);
    this.pickDirty = true;
  }

  /** Shader-driven highlight (#162): set the layer's highlight uniforms (+ optionally rewrite its
   *  per-instance `selected` flags) with no geometry rebuild — a hover is a uniform change. */
  styleInstancedLayer(name: string, highlight: InstancedHighlight): void {
    this.instanced.get(name)?.setHighlight(highlight);
  }

  setTransform(t: ViewTransform): void {
    this.viewTransform = t;
    this.clipMatrix = clipFromView(t, this.width, this.height);
    for (const r of this.renderers.values()) r.setTransform(this.clipMatrix);
    for (const r of this.instanced.values()) r.setTransform(this.clipMatrix);
    this.pickDirty = true; // links moved with the view ⇒ the pick FBO must be re-rendered before the next read
  }

  /** Resize the onscreen canvas drawing buffer (luma owns it via useDevicePixels), recompute
   *  the clip matrix at the new size, push the new viewport to every renderer (screen-mode point
   *  sizing) and recreate the offscreen export framebuffer. The engine re-pushes layers + renders
   *  after. Globe mode reads this.width/height per draw, so it follows automatically. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    const cc = this.device.getDefaultCanvasContext();
    const canvas = cc.canvas as HTMLCanvasElement;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    // Drive luma's drawing buffer to the new CSS size × dpr deterministically (its own
    // ResizeObserver would otherwise reconcile asynchronously, one frame late).
    cc.setDrawingBufferSize(Math.round(width * cc.devicePixelRatio), Math.round(height * cc.devicePixelRatio));
    this.clipMatrix = clipFromView(this.viewTransform, width, height);
    for (const r of this.renderers.values()) {
      r.setTransform(this.clipMatrix);
      r.setViewport(width, height);
    }
    for (const r of this.instanced.values()) {
      r.setTransform(this.clipMatrix);
      r.setViewport(width, height);
    }
    // The offscreen export/readback FBO is fixed-size; recreate it at the new size (mirrors the
    // globe's destroy+recreate idiom rather than relying on Framebuffer.resize).
    this.offscreen.destroy();
    this.offscreen = this.device.createFramebuffer({
      width,
      height,
      colorAttachments: ["rgba8unorm"],
      depthStencilAttachment: "depth24plus-stencil8",
    });
    this.bakeDirty = true;
    // The pick FBO is device-px and size-checked in ensurePickFbo (recreated on mismatch); just mark stale.
    this.pickDirty = true;
  }

  /** Enter/leave globe mode. texW/texH = equirect bake size. Idempotent re-entry resizes. */
  setGlobeMode(on: boolean, texW = 2048, texH = 1024): void {
    if (on) {
      if (!this.globe) this.globe = new GlobeRenderer(this.device, texW, texH, this.width, this.height);
      else this.globe.setTextureSize(texW, texH);
      this.bakeW = texW;
      this.bakeH = texH;
      this.bakeDirty = true;
    } else if (this.globe) {
      this.globe.destroy();
      this.globe = null;
    }
  }

  /** Update the globe rotation (mat3, column-major) and repaint. No re-bake. */
  setGlobeRotation(m: Float32Array): void { this.globe?.setRotation(m); this.render(); }

  render(): void {
    if (this.globe) { this.renderGlobe(); return; }
    const cc = this.device.getDefaultCanvasContext();
    const fb = cc.getCurrentFramebuffer({ depthStencilFormat: "depth24plus-stencil8" });
    this.drawInto(fb);
  }

  private renderGlobe(): void {
    const cc = this.device.getDefaultCanvasContext();
    const out = cc.getCurrentFramebuffer({ depthStencilFormat: "depth24plus-stencil8" });
    this.drawGlobeInto(out);
  }

  private drawGlobeInto(framebuffer: Framebuffer): void {
    const g = this.globe!;
    if (this.bakeDirty) { this.bakeLayers(g.bakeTarget()); this.bakeDirty = false; }
    const pass = this.device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0], clearDepth: 1 });
    const baseRadius = Math.min(this.width, this.height) * 0.45;
    const k = this.viewTransform.k;
    g.draw(pass, baseRadius * k, [this.width / 2 + this.viewTransform.x, this.height / 2 + this.viewTransform.y]);
    pass.end();
    this.device.submit();
  }

  private bakeLayers(fb: Framebuffer): void {
    const texMatrix = clipFromView({ k: 1, x: 0, y: 0 }, this.bakeW, this.bakeH);
    for (const r of this.renderers.values()) r.setTransform(texMatrix);
    const clipSources = new Set<string>();
    for (const name of this.order) { const ct = this.layers.get(name)?.clipTo; if (ct) clipSources.add(ct); }
    const pass = this.device.beginRenderPass({ framebuffer: fb, clearColor: [0, 0, 0, 0], clearStencil: 0, clearDepth: 1 });
    for (const name of this.order) {
      const r = this.renderers.get(name)!;
      const layer = this.layers.get(name)!;
      r.setStencil(clipSources.has(name) ? "write" : layer.clipTo ? "test" : "off");
      r.setSizeMode(layer.sizeMode ?? "world");
      r.render(pass);
    }
    pass.end();
    this.device.submit();
    // Restore the on-screen clip matrix for any non-globe use.
    for (const r of this.renderers.values()) r.setTransform(this.clipMatrix);
  }

  private drawInto(framebuffer: Framebuffer): void {
    const clipSources = new Set<string>();
    for (const name of this.order) {
      const ct = this.layers.get(name)?.clipTo;
      if (ct) clipSources.add(ct);
    }
    const pass = this.device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0], clearStencil: 0 });
    for (const name of this.order) {
      const r = this.renderers.get(name)!;
      const layer = this.layers.get(name)!;
      r.setStencil(clipSources.has(name) ? "write" : layer.clipTo ? "test" : "off");
      r.setSizeMode(layer.sizeMode ?? "world");
      r.render(pass);
    }
    // Instanced-primitive lane (network nodes/links): no Scene group — fed via
    // setInstancedLayer, drawn after retained layers, before the pass-through composite.
    for (const r of this.instanced.values()) r.render(pass);
    pass.end();
    this.device.submit();

    // Pass-through composite: blit the accumulation FBO onto the SAME target in a second
    // render pass that PRESERVES the retained pixels just drawn (clearColor:false = no
    // load-clear, confirmed luma semantics). During interaction this.viewTransform differs
    // from the FBO's reference transform, so the blit applies the snapshot-pan delta while
    // the retained base above is re-rendered crisp at the current transform. This shared
    // drawInto path also runs for toPNG()/readPixel() (offscreen target), so PNG export
    // gets the pass-through points for free.
    if (this.pt && this.ptNames.size > 0) {
      const pass2 = this.device.beginRenderPass({ framebuffer, clearColor: false });
      this.pt.composite(pass2, this.pt.fboTransform ?? this.viewTransform, this.viewTransform);
      pass2.end();
      this.device.submit();
    }
  }

  toPNG(): string {
    if (this.globe) { this.drawGlobeInto(this.offscreen); return toPNG(this.device, this.offscreen, this.width, this.height); }
    this.drawInto(this.offscreen);
    return toPNG(this.device, this.offscreen, this.width, this.height);
  }

  toSVG(): string {
    // In globe mode, SVG cannot render a 3D sphere; fall back to the baked (equirectangular) layer snapshot.
    return svgFromLayers(this.width, this.height, this.order.map((n) => this.layers.get(n)!), this.viewTransform);
  }

  /**
   * GPU-readback pick (#141): resolve a screen point (CSS px) to the topmost `pickable` instanced link
   * instance. Returns the decoded `gl_InstanceID`, `-1` for background, or `undefined` when there are no
   * pickable layers (the engine then falls through to other pick paths). `exact: true` (click) reads
   * synchronously; `exact: false` (hover) uses the double-buffered PBO and may return the previous
   * pointer position's result with no stall. See {@link PickReadback}.
   */
  pickInstanced(x: number, y: number, exact: boolean): number | undefined {
    if (this.pickable.size === 0 || this.globe) return undefined;
    const fbo = this.ensurePickFbo();
    if (this.pickDirty) this.renderPickPass(fbo);
    const dpr = this.device.getDefaultCanvasContext().devicePixelRatio;
    // CSS px (top-left) → device px (bottom-left origin for WebGL readback), using the FBO's own height.
    const px = Math.floor(x * dpr);
    const py = fbo.height - 1 - Math.floor(y * dpr);
    const handle = (fbo as WEBGLFramebuffer).handle;
    const picker = (this.picker ??= new PickReadback((this.device as WebGLDevice).gl));
    return exact ? picker.readSync(handle, px, py) : picker.read(handle, px, py);
  }

  /** Lazily create / resize the device-px pick FBO (colour-only; no depth/stencil needed for id reads). */
  private ensurePickFbo(): Framebuffer {
    const dpr = this.device.getDefaultCanvasContext().devicePixelRatio;
    const w = Math.max(1, Math.round(this.width * dpr));
    const h = Math.max(1, Math.round(this.height * dpr));
    if (this.pickFbo && this.pickFbo.width === w && this.pickFbo.height === h) return this.pickFbo;
    this.pickFbo?.destroy();
    this.pickFbo = this.device.createFramebuffer({ width: w, height: h, colorAttachments: ["rgba8unorm"] });
    this.pickDirty = true;
    return this.pickFbo;
  }

  /** Render the id-encoded pick models of the pickable link layers into the pick FBO. Background clears
   *  to (0,0,0,1) so empty pixels decode to -1. Only re-runs when {@link pickDirty} (geometry/transform
   *  changed), so a hover over a static view re-reads the same FBO with no redraw. */
  private renderPickPass(fbo: Framebuffer): void {
    const pass = this.device.beginRenderPass({ framebuffer: fbo, clearColor: [0, 0, 0, 1] });
    for (const name of this.pickable) {
      const r = this.instanced.get(name);
      // pickable only ever holds link layers; the instanceof guard narrows the union to the
      // primitives that expose renderPick (circles, the node lane, are CPU-picked and excluded).
      if (r && !(r instanceof InstancedCircles)) r.renderPick(pass);
    }
    pass.end();
    this.device.submit();
    this.pickDirty = false;
  }

  /** Read a pixel from the ONSCREEN canvas default framebuffer after render(). Test aid.
   *  Coords are in CSS px; the onscreen buffer is device px, so scale by the buffer ratio. */
  readScreenPixel(x: number, y: number): number[] {
    this.render();
    const gl = (this.device as unknown as { gl: WebGL2RenderingContext }).gl;
    const sx = gl.drawingBufferWidth / this.width, sy = gl.drawingBufferHeight / this.height;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    const p = new Uint8Array(4);
    gl.readPixels(Math.floor(x * sx), Math.floor((this.height - 1 - y) * sy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
    return [p[0]!, p[1]!, p[2]!, p[3]!];
  }

  /** Read a pixel from the offscreen framebuffer (renders first). Flips y for WebGL origin. */
  readPixel(x: number, y: number): number[] {
    this.drawInto(this.offscreen);
    const p = this.device.readPixelsToArrayWebGL(this.offscreen, {
      sourceX: Math.floor(x),
      sourceY: Math.floor(this.height - 1 - y),
      sourceWidth: 1,
      sourceHeight: 1,
    });
    return [p[0]!, p[1]!, p[2]!, p[3]!];
  }

  destroy(): void {
    for (const r of this.renderers.values()) r.destroy();
    this.renderers.clear();
    for (const r of this.instanced.values()) r.destroy();
    this.instanced.clear();
    this.pickable.clear();
    this.layers.clear();
    this.order = [];
    this.globe?.destroy();
    this.globe = null;
    this.pt?.destroy();
    this.pt = null;
    this.ptNames.clear();
    this.picker?.destroy();
    this.picker = null;
    this.pickFbo?.destroy();
    this.pickFbo = null;
    this.offscreen.destroy();
    this.device.destroy();
  }
}

/**
 * Treat a `fromDrawable === 0` delta as full {@link GroupBuffers}: the delta's arrays
 * already span the whole group (indices are group-absolute from 0). Used only on the
 * rare empty-renderer rebuild path in appendToLayer.
 */
function deltaToBuffers(d: GroupBufferDelta): GroupBuffers {
  return {
    fillVertices: d.fillVertices,
    fillIndices: d.fillIndices,
    strokeVertices: d.strokeVertices,
    strokeIndices: d.strokeIndices,
    fillColors: d.fillColors,
    strokeColors: d.strokeColors,
    flags: d.flags,
    drawableCount: d.drawableCount,
    pointCenters: d.pointCenters,
    pointCount: d.pointCenters.length / 4,
    fillAnchors: d.fillAnchors,
    strokeAnchors: d.strokeAnchors,
    ranges: d.ranges,
  };
}
