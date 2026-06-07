import { select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type D3ZoomEvent } from "d3-zoom";
import { Scene, HitIndex, type Backend, type GroupBuilder, type RenderLayer, type ViewTransform } from "../core/index.js";
import { createBackend, type BackendType, type BackendHandle } from "./backend-factory.js";

export type Accessor<D, T> = T | ((d: D, i: number) => T);
export interface HoverHit { layer: string; id: string | number; datum: unknown; }

export interface LayerSpec {
  name: string;
  data: any[];
  ids: (string | number)[];
  fill?: Accessor<any, string>;
  stroke?: Accessor<any, string>;
  clipTo?: string;
  sizeMode?: "world" | "screen";
  /** When true, this layer is dropped from the render while the user is interacting
   *  (a rotation drag, or a zoom/pan gesture) — and not re-projected per rotation
   *  frame; it re-projects + reappears when the interaction ends. */
  hideOnInteraction?: boolean;
  /** Screen-space declutter radius (px). When set, on each transform the engine hides
   *  anchored glyphs whose projected anchor falls within this radius of an already-kept one
   *  (grouped by anchor, earlier drawables win) — constant-size markers stop overlapping. */
  declutter?: number;
  build: (g: GroupBuilder) => void;   // rebuilds the Scene group (geo or draw)
}

export abstract class BaseEngine {
  protected scene = new Scene();
  protected specs: LayerSpec[] = [];
  protected hitIndexes = new Map<string, HitIndex>();
  protected transform: ViewTransform = { k: 1, x: 0, y: 0 };
  protected handle: BackendHandle | null = null;
  protected ready: Promise<void>;
  private currentBackend: BackendType;
  private hoverCb: ((hit: HoverHit | null, ev: PointerEvent) => void) | null = null;
  private swapToken = 0;
  private destroyed = false;
  /** True while the user is interacting (a rotation drag, or a zoom/pan gesture).
   *  Layers flagged hideOnInteraction are excluded from the render while this is true. */
  protected interacting = false;
  /** Detaches the currently-attached interaction (zoom or rotation), if any. */
  private interactionCleanup: (() => void) | null = null;

  constructor(protected host: HTMLElement, protected width: number, protected height: number, backend: BackendType) {
    this.currentBackend = backend;
    this.ready = this.swapBackend(backend);
  }
  whenReady(): Promise<void> { return this.ready; }
  /** The currently-active backend type (set by the constructor / swapBackend). */
  protected backendType(): BackendType { return this.currentBackend; }
  /** The live backend instance, or null before the first swap resolves. */
  protected backend(): Backend | null { return this.handle?.backend ?? null; }

  /** Register/replace a layer: build its Scene group, apply accessors, index, push. */
  protected registerLayer(spec: LayerSpec): void {
    this.scene.group(spec.name, spec.build);
    this.applyAccessors(spec);
    const at = this.specs.findIndex((s) => s.name === spec.name);
    if (at >= 0) this.specs[at] = spec;
    else this.specs.push(spec);
    this.hitIndexes.set(spec.name, new HitIndex(this.scene.drawables(spec.name)));
    this.pushLayers();
  }

  /**
   * Append items to an already-registered layer: build only the new drawables,
   * extend the spec's data/ids, color the new range, grow the hit index, and
   * re-push just this layer. `ids` are caller-resolved (continuing the index or
   * honoring the layer's id accessor).
   *
   * Validates all new ids up-front (against the layer's existing ids and each
   * other) so a duplicate throws before any mutation — the append is atomic. The
   * Scene-level dup guard remains as a backstop.
   */
  protected appendToLayer(name: string, items: readonly any[], ids: readonly (string | number)[], build: (g: GroupBuilder) => void): void {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) throw new Error(`unknown layer: ${name}`);
    if (items.length === 0) return;
    // ids and items must stay parallel — a mismatch would desync spec.data/spec.ids
    // (which applyAccessors and pick index in lockstep).
    if (ids.length !== items.length) throw new Error(`appendToLayer: ids.length (${ids.length}) !== items.length (${items.length})`);
    const existing = new Set(spec.ids.map(String));
    const seen = new Set<string>();
    for (const id of ids) {
      const key = String(id);
      if (existing.has(key) || seen.has(key)) throw new Error(`duplicate drawable id: ${key}`);
      seen.add(key);
    }
    const drawOffset = this.scene.drawableCount(name); // drawables, not data (culling may differ)
    const dataStart = spec.data.length;
    this.scene.appendToGroup(name, build);
    // NB: never `push(...items)` — spreading a large batch (the batch-size control goes
    // to 1M) exceeds the argument-count limit and throws RangeError. Loop instead.
    for (const it of items) spec.data.push(it);
    for (const id of ids) spec.ids.push(id);
    // The drawables actually added (culling may produce fewer than `items`). Used to
    // color only the new range, grow the hit index, and feed the backend delta.
    const newDrawables = this.scene.drawables(name, drawOffset); // O(new)
    this.applyAccessors(spec, dataStart, new Set(newDrawables.map((d) => d.id)));
    this.hitIndexes.get(name)?.append(newDrawables);
    // Skip the GPU push for a layer hidden mid-interaction (mirrors recolor): the
    // gesture-end rebuild re-projects + re-pushes the full extended list.
    if (this.interacting && spec.hideOnInteraction) return;
    const backend = this.handle?.backend;
    if (backend?.appendToLayer) {
      // O(new): the backend uploads/draws ONLY the appended delta (and is responsible
      // for making it visible — e.g. canvas draws-on-top). No full render() here, or
      // we'd pay O(total) per batch and defeat the point.
      backend.appendToLayer({
        name,
        buffers: this.scene.appendedBuffers(name, drawOffset),
        drawables: newDrawables,
        clipTo: spec.clipTo,
        sizeMode: spec.sizeMode,
      });
    } else {
      backend?.updateLayer(name, this.renderLayer(spec)); // fallback: full re-upload (e.g. SVG)
      this.render();
    }
  }

  recolor(name: string): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    this.applyAccessors(spec);
    // Don't touch the backend for a layer that's hidden mid-interaction (setLayers
    // already dropped it); it re-projects + repaints when the interaction ends.
    if (!(this.interacting && spec.hideOnInteraction)) {
      this.handle?.backend.updateLayer(name, this.renderLayer(spec));
      this.render();
    }
    return this;
  }
  setClip(name: string, clipTo?: string): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    spec.clipTo = clipTo;
    this.pushLayers();
    return this;
  }
  setBackend(type: BackendType): this { this.ready = this.swapBackend(type); return this; }
  /** Detach the current pan/zoom or rotation interaction (no-op if none). */
  disableInteraction(): this {
    this.interactionCleanup?.();
    this.interactionCleanup = null;
    this.interacting = false;
    return this;
  }
  /** Subclasses (GeoMap.enableRotation) register their interaction teardown here.
   *  Call disableInteraction() first if replacing an existing interaction. */
  protected setInteractionCleanup(fn: () => void): void {
    this.interactionCleanup = fn;
  }
  /** Toggle the interacting flag. When it changes AND some layer opts into
   *  hideOnInteraction, re-push so those layers drop out / come back at the
   *  gesture boundary. A no-op (beyond the flag) when no layer opts in, so
   *  zoom/pan on ordinary maps keeps zero overhead. */
  protected setInteracting(v: boolean): void {
    if (this.interacting === v) return;
    this.interacting = v;
    if (this.specs.some((s) => s.hideOnInteraction)) this.pushLayers();
  }
  setTransform(t: ViewTransform): this {
    this.transform = t;
    this.handle?.backend.setTransform(t);
    for (const spec of this.specs) if (spec.declutter) this.declutterLayer(spec, t);
    this.render();
    return this;
  }

  /**
   * Hide anchored glyphs that overlap in screen space, keeping earlier (e.g. larger-clade)
   * ones. Drawables sharing an exact anchor (a pie's wedges) are one unit. A uniform grid
   * of cell size = radius makes neighbour checks O(1) average, so this is cheap enough to run
   * on every zoom; it only toggles visibility flags (no geometry rebuild).
   */
  private declutterLayer(spec: LayerSpec, t: ViewTransform): void {
    const radius = spec.declutter!;
    if (!(radius > 0)) return;
    const draws = this.scene.drawables(spec.name);
    const groups = new Map<string, { ax: number; ay: number; ids: (string | number)[] }>();
    for (const d of draws) {
      if (!d.anchor) continue;
      const key = `${d.anchor[0]},${d.anchor[1]}`;
      const g = groups.get(key) ?? { ax: d.anchor[0], ay: d.anchor[1], ids: [] };
      g.ids.push(d.id);
      groups.set(key, g);
    }
    if (groups.size === 0) return;
    const r2 = radius * radius;
    const grid = new Map<string, { x: number; y: number }[]>();
    const visible = new Set<string | number>();
    for (const g of groups.values()) {
      const sx = t.k * g.ax + t.x, sy = t.k * g.ay + t.y;
      const cx = Math.floor(sx / radius), cy = Math.floor(sy / radius);
      let occluded = false;
      for (let i = -1; i <= 1 && !occluded; i++)
        for (let j = -1; j <= 1 && !occluded; j++) {
          for (const p of grid.get(`${cx + i},${cy + j}`) ?? []) {
            const dx = p.x - sx, dy = p.y - sy;
            if (dx * dx + dy * dy < r2) { occluded = true; break; }
          }
        }
      if (!occluded) {
        (grid.get(`${cx},${cy}`) ?? grid.set(`${cx},${cy}`, []).get(`${cx},${cy}`)!).push({ x: sx, y: sy });
        for (const id of g.ids) visible.add(id);
      }
    }
    for (const d of draws) this.scene.setFlag(spec.name, d.id, !d.anchor || visible.has(d.id) ? 1 : 0);
    this.handle?.backend.updateLayer(spec.name, this.renderLayer(spec));
  }
  /**
   * Enable scroll-to-zoom / drag-to-pan via d3-zoom, clamped to `extent`. The optional
   * `onTransform` callback fires after each `setTransform` during zoom — use it to keep an
   * HTML overlay (e.g. a `LabelLayer`) aligned with the GPU geometry as the view changes.
   */
  enableZoom(extent: [number, number] = [1, 100], onTransform?: (t: ViewTransform) => void): this {
    this.disableInteraction();
    const sel = select(this.host as Element);
    const behavior = d3zoom<Element, unknown>().scaleExtent(extent)
      .on("start", () => this.setInteracting(true))
      .on("zoom", (e: D3ZoomEvent<Element, unknown>) => {
        const t: ViewTransform = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        this.setTransform(t);
        onTransform?.(t);
      })
      .on("end", () => this.setInteracting(false));
    (sel as any).call(behavior);
    // Seed d3-zoom's internal transform from the engine's CURRENT view so a non-identity base
    // (e.g. a centering translate set via setTransform before enableZoom) is respected, and
    // zoom-to-cursor deltas measure from it rather than from identity.
    const t = this.transform;
    (sel as any).call(behavior.transform, zoomIdentity.translate(t.x, t.y).scale(t.k));
    this.interactionCleanup = () => { (sel as any).on(".zoom", null); };
    return this;
  }
  on(event: "hover", cb: (hit: HoverHit | null, ev: PointerEvent) => void): this {
    if (event === "hover") {
      this.hoverCb = cb;
      this.host.addEventListener("pointermove", this.onPointerMove);
      this.host.addEventListener("pointerleave", this.onPointerLeave);
    }
    return this;
  }
  pick(x: number, y: number): HoverHit | null {
    const px = (x - this.transform.x) / this.transform.k;
    const py = (y - this.transform.y) / this.transform.k;
    for (let i = this.specs.length - 1; i >= 0; i--) {
      const spec = this.specs[i]!;
      const id = this.hitIndexes.get(spec.name)?.pick(px, py);
      if (id != null) {
        const di = spec.ids.indexOf(id);
        return { layer: spec.name, id, datum: di >= 0 ? spec.data[di] : null };
      }
    }
    return null;
  }
  render(): this { this.handle?.backend.render(); return this; }
  toSVG(): string { return this.handle?.backend.toSVG() ?? ""; }
  toPNG(): string { return this.handle?.backend.toPNG() ?? ""; }
  destroy(): void {
    this.destroyed = true;
    // Detach pan/zoom or rotation listeners so a trailing wheel/pointer event can't
    // fire on a destroyed engine (destroy() otherwise only removes hover listeners).
    this.disableInteraction();
    // Invalidate any in-flight swapBackend so a pending backend that resolves
    // after destroy() bails and removes its own element (instead of orphaning a
    // canvas in the host — which happens when the engine is destroyed before its
    // first backend has finished initializing, e.g. a React recreate on resize).
    this.swapToken++;
    this.host.removeEventListener("pointermove", this.onPointerMove);
    this.host.removeEventListener("pointerleave", this.onPointerLeave);
    this.handle?.backend.destroy();
    if (this.handle && this.handle.element !== this.host) this.handle.element.remove();
    this.handle = null;
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.hoverCb) return;
    const r = this.host.getBoundingClientRect();
    this.hoverCb(this.pick(e.clientX - r.left, e.clientY - r.top), e);
  };
  private onPointerLeave = (e: PointerEvent): void => { this.hoverCb?.(null, e); };
  private resolve<T>(a: Accessor<any, T> | undefined, d: any, i: number): T | undefined {
    return typeof a === "function" ? (a as (d: any, i: number) => T)(d, i) : a;
  }
  private applyAccessors(spec: LayerSpec, start = 0, present?: Set<string | number>): void {
    // A spec has one id per datum, but the built group may have fewer drawables —
    // e.g. geoLayer culls back-hemisphere points on a globe, so those ids have no
    // drawable. Only color the ids actually present (setFill/Stroke throw on
    // unknown ids), which keeps the typo guard for genuinely-missing drawables.
    // `present` is supplied by the append path (only the new drawables) so coloring
    // stays O(new); a full (re)build passes nothing and scans all drawables.
    const ids = present ?? new Set(this.scene.drawables(spec.name).map((dr) => dr.id));
    for (let i = start; i < spec.data.length; i++) {
      const d = spec.data[i]!;
      const id = spec.ids[i]!;
      if (!ids.has(id)) continue;
      const fill = this.resolve(spec.fill, d, i);
      if (fill) this.scene.setFill(spec.name, id, fill);
      const stroke = this.resolve(spec.stroke, d, i);
      if (stroke) this.scene.setStroke(spec.name, id, stroke);
    }
  }
  private renderLayer(spec: LayerSpec): RenderLayer {
    return { name: spec.name, buffers: this.scene.buffers(spec.name), drawables: this.scene.drawables(spec.name), clipTo: spec.clipTo, sizeMode: spec.sizeMode };
  }
  /** Specs to actually render: hidden-on-interaction layers drop out mid-gesture. */
  private renderSpecs(): LayerSpec[] {
    return this.specs.filter((s) => !(this.interacting && s.hideOnInteraction));
  }
  private pushLayers(): void {
    this.handle?.backend.setLayers(this.renderSpecs().map((s) => this.renderLayer(s)));
    this.handle?.backend.setTransform(this.transform);
    this.render();
  }
  private async swapBackend(type: BackendType): Promise<void> {
    this.currentBackend = type;
    const token = ++this.swapToken;
    const old = this.handle;
    const next = await createBackend(type, this.host, this.width, this.height);
    // A newer swap superseded this one, or the engine was destroyed mid-flight:
    // tear down the freshly created backend so it never orphans an element.
    if (token !== this.swapToken || this.destroyed) { next.backend.destroy(); if (next.element !== this.host) next.element.remove(); return; }
    old?.backend.destroy();
    if (old && old.element !== this.host) old.element.remove();
    this.handle = next;
    next.backend.setLayers(this.renderSpecs().map((s) => this.renderLayer(s)));
    next.backend.setTransform(this.transform);
    next.backend.render();
  }
}
