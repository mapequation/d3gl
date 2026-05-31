import { type GeoProjection } from "d3-geo";
import { select } from "d3-selection";
import { zoom as d3zoom, type D3ZoomEvent } from "d3-zoom";
import { Scene, HitIndex, type RenderLayer, type ViewTransform } from "@d3gl/core";
import { geoLayer } from "@d3gl/geo";
import { createBackend, type BackendType, type BackendHandle } from "./backend-factory.js";

type Accessor<F, T> = T | ((f: F, i: number) => T);

export interface LayerOptions<F = any> {
  fill?: Accessor<F, string>;
  stroke?: Accessor<F, string>;
  lineWidth?: number;
  pointRadius?: number;
  clipTo?: string;
  id?: (f: F, i: number) => string | number;
}

export interface GeoMapOptions {
  width: number;
  height: number;
  projection: GeoProjection;
  backend?: BackendType;
}

export interface HoverHit { layer: string; id: string | number; feature: unknown; }

interface LayerSpec {
  name: string;
  features: any[];
  opts: LayerOptions;
  ids: (string | number)[];   // resolved per-feature ids (drawable order)
}

export class GeoMap {
  private scene = new Scene();
  private specs: LayerSpec[] = [];
  private hitIndexes = new Map<string, HitIndex>();
  private transform: ViewTransform = { k: 1, x: 0, y: 0 };
  private handle: BackendHandle | null = null;
  private ready: Promise<void>;
  private hoverCb: ((hit: HoverHit | null, ev: PointerEvent) => void) | null = null;

  constructor(private host: HTMLElement, private opts: GeoMapOptions) {
    this.ready = this.swapBackend(opts.backend ?? "webgl");
  }
  whenReady(): Promise<void> { return this.ready; }

  layer<F>(name: string, features: F | readonly F[], opts: LayerOptions<F> = {}): this {
    const list = Array.isArray(features) ? (features as F[]) : [features as F];
    const ids = list.map((f, i) => (opts.id ? opts.id(f, i) : i));
    this.scene.group(name, geoLayer(list as any[], this.opts.projection, {
      id: (_f, i) => ids[i]!, lineWidth: opts.lineWidth, pointRadius: opts.pointRadius,
    }));
    this.applyAccessors(name, list as any[], opts);
    this.specs = this.specs.filter((s) => s.name !== name).concat({ name, features: list as any[], opts, ids });
    this.hitIndexes.set(name, new HitIndex(this.scene.drawables(name)));
    this.pushLayers();
    return this;
  }

  recolor(name: string): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    this.applyAccessors(name, spec.features, spec.opts);
    this.handle?.backend.updateLayer(name, this.renderLayer(spec));
    this.render();
    return this;
  }

  setBackend(type: BackendType): this { this.ready = this.swapBackend(type); return this; }
  setTransform(t: ViewTransform): this {
    this.transform = t;
    this.handle?.backend.setTransform(t);
    this.render();
    return this;
  }
  enableZoom(extent: [number, number] = [1, 50]): this {
    const sel = select(this.host as Element);
    const behavior = d3zoom<Element, unknown>().scaleExtent(extent).on("zoom", (e: D3ZoomEvent<Element, unknown>) => {
      this.setTransform({ k: e.transform.k, x: e.transform.x, y: e.transform.y });
    });
    (sel as any).call(behavior);
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
    for (let i = this.specs.length - 1; i >= 0; i--) {        // topmost layer first
      const spec = this.specs[i]!;
      const id = this.hitIndexes.get(spec.name)?.pick(px, py);
      if (id != null) {
        const fi = spec.ids.indexOf(id);
        return { layer: spec.name, id, feature: fi >= 0 ? spec.features[fi] : null };
      }
    }
    return null;
  }

  render(): this { this.handle?.backend.render(); return this; }
  toSVG(): string { return this.handle?.backend.toSVG() ?? ""; }
  toPNG(): string { return this.handle?.backend.toPNG() ?? ""; }
  destroy(): void {
    this.host.removeEventListener("pointermove", this.onPointerMove);
    this.host.removeEventListener("pointerleave", this.onPointerLeave);
    this.handle?.backend.destroy();
    if (this.handle && this.handle.element !== this.host) this.handle.element.remove();
    this.handle = null;
  }

  // ---- internals ----
  private onPointerMove = (e: PointerEvent): void => {
    if (!this.hoverCb) return;
    const r = this.host.getBoundingClientRect();
    this.hoverCb(this.pick(e.clientX - r.left, e.clientY - r.top), e);
  };
  private onPointerLeave = (e: PointerEvent): void => { this.hoverCb?.(null, e); };

  private resolve<T>(a: Accessor<any, T> | undefined, f: any, i: number): T | undefined {
    return typeof a === "function" ? (a as (f: any, i: number) => T)(f, i) : a;
  }
  private applyAccessors(name: string, features: any[], opts: LayerOptions): void {
    features.forEach((f, i) => {
      const id = opts.id ? opts.id(f, i) : i;
      const fill = this.resolve(opts.fill, f, i);
      if (fill) this.scene.setFill(name, id, fill);
      const stroke = this.resolve(opts.stroke, f, i);
      if (stroke) this.scene.setStroke(name, id, stroke);
    });
  }
  private renderLayer(spec: LayerSpec): RenderLayer {
    return { name: spec.name, buffers: this.scene.buffers(spec.name), drawables: this.scene.drawables(spec.name), clipTo: spec.opts.clipTo };
  }
  private pushLayers(): void {
    const layers = this.specs.map((s) => this.renderLayer(s));
    this.handle?.backend.setLayers(layers);
    this.handle?.backend.setTransform(this.transform);
    this.render();
  }
  private async swapBackend(type: BackendType): Promise<void> {
    const old = this.handle;
    const next = await createBackend(type, this.host, this.opts.width, this.opts.height);
    old?.backend.destroy();
    if (old && old.element !== this.host) old.element.remove();
    this.handle = next;
    next.backend.setLayers(this.specs.map((s) => this.renderLayer(s)));
    next.backend.setTransform(this.transform);
    next.backend.render();
  }
}

export function geoMap(host: HTMLElement, opts: GeoMapOptions): GeoMap {
  return new GeoMap(host, opts);
}
