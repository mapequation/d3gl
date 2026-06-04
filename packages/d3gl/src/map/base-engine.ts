import { select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type D3ZoomEvent } from "d3-zoom";
import { Scene, HitIndex, type GroupBuilder, type RenderLayer, type ViewTransform } from "../core/index.js";
import { createBackend, type BackendType, type BackendHandle } from "./backend-factory.js";

export type Accessor<D, T> = T | ((d: D, i: number) => T);
export interface HoverHit { layer: string; id: string | number; datum: unknown; }

interface LayerSpec {
  name: string;
  data: any[];
  ids: (string | number)[];
  fill?: Accessor<any, string>;
  stroke?: Accessor<any, string>;
  clipTo?: string;
  sizeMode?: "world" | "screen";
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
  private hoverCb: ((hit: HoverHit | null, ev: PointerEvent) => void) | null = null;
  private swapToken = 0;
  private destroyed = false;

  constructor(protected host: HTMLElement, protected width: number, protected height: number, backend: BackendType) {
    this.ready = this.swapBackend(backend);
  }
  whenReady(): Promise<void> { return this.ready; }

  /** Register/replace a layer: build its Scene group, apply accessors, index, push. */
  protected registerLayer(spec: LayerSpec): void {
    this.scene.group(spec.name, spec.build);
    this.applyAccessors(spec);
    this.specs = this.specs.filter((s) => s.name !== spec.name).concat(spec);
    this.hitIndexes.set(spec.name, new HitIndex(this.scene.drawables(spec.name)));
    this.pushLayers();
  }

  recolor(name: string): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    this.applyAccessors(spec);
    this.handle?.backend.updateLayer(name, this.renderLayer(spec));
    this.render();
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
    const sel = select(this.host as Element);
    const behavior = d3zoom<Element, unknown>().scaleExtent(extent).on("zoom", (e: D3ZoomEvent<Element, unknown>) => {
      const t: ViewTransform = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
      this.setTransform(t);
      onTransform?.(t);
    });
    (sel as any).call(behavior);
    // Seed d3-zoom's internal transform from the engine's CURRENT view so a non-identity base
    // (e.g. a centering translate set via setTransform before enableZoom) is respected, and
    // zoom-to-cursor deltas measure from it rather than from identity.
    const t = this.transform;
    (sel as any).call(behavior.transform, zoomIdentity.translate(t.x, t.y).scale(t.k));
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
  private applyAccessors(spec: LayerSpec): void {
    spec.data.forEach((d, i) => {
      const id = spec.ids[i]!;
      const fill = this.resolve(spec.fill, d, i);
      if (fill) this.scene.setFill(spec.name, id, fill);
      const stroke = this.resolve(spec.stroke, d, i);
      if (stroke) this.scene.setStroke(spec.name, id, stroke);
    });
  }
  private renderLayer(spec: LayerSpec): RenderLayer {
    return { name: spec.name, buffers: this.scene.buffers(spec.name), drawables: this.scene.drawables(spec.name), clipTo: spec.clipTo, sizeMode: spec.sizeMode };
  }
  private pushLayers(): void {
    this.handle?.backend.setLayers(this.specs.map((s) => this.renderLayer(s)));
    this.handle?.backend.setTransform(this.transform);
    this.render();
  }
  private async swapBackend(type: BackendType): Promise<void> {
    const token = ++this.swapToken;
    const old = this.handle;
    const next = await createBackend(type, this.host, this.width, this.height);
    // A newer swap superseded this one, or the engine was destroyed mid-flight:
    // tear down the freshly created backend so it never orphans an element.
    if (token !== this.swapToken || this.destroyed) { next.backend.destroy(); if (next.element !== this.host) next.element.remove(); return; }
    old?.backend.destroy();
    if (old && old.element !== this.host) old.element.remove();
    this.handle = next;
    next.backend.setLayers(this.specs.map((s) => this.renderLayer(s)));
    next.backend.setTransform(this.transform);
    next.backend.render();
  }
}
