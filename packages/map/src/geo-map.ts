import { type GeoProjection } from "d3-geo";
import { geoLayer } from "@d3gl/geo";
import { BaseEngine, type HoverHit } from "./base-engine.js";
import type { BackendType } from "./backend-factory.js";

export interface GeoMapOptions { width: number; height: number; projection: GeoProjection; backend?: BackendType; }
export interface LayerOptions<F = any> {
  fill?: string | ((f: F, i: number) => string);
  stroke?: string | ((f: F, i: number) => string);
  lineWidth?: number; pointRadius?: number; clipTo?: string;
  id?: (f: F, i: number) => string | number;
  /** "world" (default): radius scales with zoom. "screen": constant pixel size. */
  sizeMode?: "world" | "screen";
}

export class GeoMap extends BaseEngine {
  constructor(host: HTMLElement, private opts: GeoMapOptions) {
    super(host, opts.width, opts.height, opts.backend ?? "webgl");
  }
  layer<F>(name: string, features: F | readonly F[], opts: LayerOptions<F> = {}): this {
    const list = Array.isArray(features) ? (features as F[]) : [features as F];
    const ids = list.map((f, i) => (opts.id ? opts.id(f, i) : i));
    this.registerLayer({
      name, data: list as any[], ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo, pointSizeMode: opts.sizeMode,
      build: geoLayer(list as any[], this.opts.projection, { id: (_f, i) => ids[i]!, lineWidth: opts.lineWidth, pointRadius: opts.pointRadius, sizeMode: opts.sizeMode }),
    });
    return this;
  }
}
export function geoMap(host: HTMLElement, opts: GeoMapOptions): GeoMap { return new GeoMap(host, opts); }
export type { HoverHit };
