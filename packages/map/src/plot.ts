import type { GroupBuilder, PathContext } from "@d3gl/core";
import { BaseEngine } from "./base-engine.js";
import type { BackendType } from "./backend-factory.js";

export interface PlotOptions { width: number; height: number; backend?: BackendType; }
export interface PlotLayerOptions<D = any> {
  /**
   * Draw one datum's geometry by emitting path commands. The context is typed as
   * `CanvasRenderingContext2D` so d3 generators that render to a context —
   * `d3.linkHorizontal()`, `d3.linkRadial()`, `d3.line()`, `d3.arc()`,
   * `geoPath(projection, ctx)`, `d3.ribbon()`, … — accept it directly with no cast.
   * Only the path-building subset (moveTo/lineTo/bezierCurveTo/quadraticCurveTo/
   * arc/arcTo/rect/closePath) is implemented; fills/strokes come from the layer
   * options below, not from context state.
   */
  draw: (ctx: CanvasRenderingContext2D, datum: D, index: number) => void;
  fill?: string | ((d: D, i: number) => string);
  stroke?: string | ((d: D, i: number) => string);
  lineWidth?: number; clipTo?: string;
  id?: (d: D, i: number) => string | number;
}

export interface PlotPointOptions<D = any> {
  x: (d: D, i: number) => number;
  y: (d: D, i: number) => number;
  radius?: number | ((d: D, i: number) => number);
  fill?: string | ((d: D, i: number) => string);
  stroke?: string | ((d: D, i: number) => string);
  id?: (d: D, i: number) => string | number;
  clipTo?: string;
  /** "world" (default): radius scales with zoom. "screen": constant pixel size. */
  sizeMode?: "world" | "screen";
}

export class Plot extends BaseEngine {
  constructor(host: HTMLElement, opts: PlotOptions) { super(host, opts.width, opts.height, opts.backend ?? "webgl"); }
  layer<D>(name: string, data: readonly D[], opts: PlotLayerOptions<D>): this {
    const list = data as D[];
    const ids = list.map((d, i) => (opts.id ? opts.id(d, i) : i));
    const drawOpts = opts.lineWidth != null ? { lineWidth: opts.lineWidth } : undefined;
    const build = (g: GroupBuilder): void => {
      // d3gl's PathContext implements the path-building subset d3 generators use;
      // present it as CanvasRenderingContext2D (the type their .context()/geoPath
      // expect) so user draw code needs no cast. Single internal cast here.
      list.forEach((d, i) =>
        g.drawable(ids[i]!, (ctx: PathContext) => opts.draw(ctx as unknown as CanvasRenderingContext2D, d, i), drawOpts),
      );
    };
    this.registerLayer({ name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo, build });
    return this;
  }
  points<D>(name: string, data: readonly D[], opts: PlotPointOptions<D>): this {
    const list = data as D[];
    const ids = list.map((d, i) => (opts.id ? opts.id(d, i) : i));
    const resolveRadius = typeof opts.radius === "function" ? opts.radius : (_d: D, _i: number) => (opts.radius as number | undefined) ?? 3;
    const build = (g: GroupBuilder): void => {
      list.forEach((d, i) => g.point(ids[i]!, opts.x(d, i), opts.y(d, i), resolveRadius(d, i)));
    };
    this.registerLayer({ name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo, pointSizeMode: opts.sizeMode, build });
    return this;
  }
}
export function plot(host: HTMLElement, opts: PlotOptions): Plot { return new Plot(host, opts); }
