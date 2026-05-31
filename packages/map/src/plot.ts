import type { GroupBuilder, PathContext } from "@d3gl/core";
import { BaseEngine } from "./base-engine.js";
import type { BackendType } from "./backend-factory.js";

export interface PlotOptions { width: number; height: number; backend?: BackendType; }
export interface PlotLayerOptions<D = any> {
  draw: (ctx: PathContext, datum: D, index: number) => void;
  fill?: string | ((d: D, i: number) => string);
  stroke?: string | ((d: D, i: number) => string);
  lineWidth?: number; clipTo?: string;
  id?: (d: D, i: number) => string | number;
}

export class Plot extends BaseEngine {
  constructor(host: HTMLElement, opts: PlotOptions) { super(host, opts.width, opts.height, opts.backend ?? "webgl"); }
  layer<D>(name: string, data: readonly D[], opts: PlotLayerOptions<D>): this {
    const list = data as D[];
    const ids = list.map((d, i) => (opts.id ? opts.id(d, i) : i));
    const drawOpts = opts.lineWidth != null ? { lineWidth: opts.lineWidth } : undefined;
    const build = (g: GroupBuilder): void => {
      list.forEach((d, i) => g.drawable(ids[i]!, (ctx: PathContext) => opts.draw(ctx, d, i), drawOpts));
    };
    this.registerLayer({ name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo, build });
    return this;
  }
}
export function plot(host: HTMLElement, opts: PlotOptions): Plot { return new Plot(host, opts); }
