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
  /** A constant width, or a per-datum width (e.g. branch thickness ∝ subtended terminals). */
  lineWidth?: number | ((d: D, i: number) => number);
  clipTo?: string;
  id?: (d: D, i: number) => string | number;
  /** "world" (default): geometry scales with zoom. "screen": constant pixel size — anchored
   *  glyphs keep their size, strokes keep their pixel width. See `anchor`. */
  sizeMode?: "world" | "screen";
  /** Glyph anchor in world coords per datum. In "screen" sizeMode the drawable is rendered
   *  at a constant pixel size around this point (e.g. a pie pinned to a tree node). */
  anchor?: (d: D, i: number) => [number, number];
  /** Screen-space declutter radius (px): on each zoom, hide anchored glyphs that overlap an
   *  already-kept one (earlier data wins). Pairs with `anchor` + "screen" sizeMode. */
  declutter?: number;
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
    const lw = opts.lineWidth;
    const widthOf = typeof lw === "function" ? lw : (_d: D, _i: number) => lw as number;
    const anchorOf = opts.anchor;
    const build = (g: GroupBuilder): void => {
      // d3gl's PathContext implements the path-building subset d3 generators use;
      // present it as CanvasRenderingContext2D (the type their .context()/geoPath
      // expect) so user draw code needs no cast. Single internal cast here.
      list.forEach((d, i) =>
        g.drawable(
          ids[i]!,
          (ctx: PathContext) => opts.draw(ctx as unknown as CanvasRenderingContext2D, d, i),
          lw != null || anchorOf ? { lineWidth: lw != null ? widthOf(d, i) : 0, anchor: anchorOf?.(d, i) } : undefined,
        ),
      );
    };
    this.registerLayer({ name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo, sizeMode: opts.sizeMode, declutter: opts.declutter, build });
    return this;
  }
  points<D>(name: string, data: readonly D[], opts: PlotPointOptions<D>): this {
    const list = data as D[];
    const ids = list.map((d, i) => (opts.id ? opts.id(d, i) : i));
    const resolveRadius = typeof opts.radius === "function" ? opts.radius : (_d: D, _i: number) => (opts.radius as number | undefined) ?? 3;
    const build = (g: GroupBuilder): void => {
      list.forEach((d, i) => g.point(ids[i]!, opts.x(d, i), opts.y(d, i), resolveRadius(d, i)));
    };
    this.registerLayer({ name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo, sizeMode: opts.sizeMode, build });
    return this;
  }
}
export function plot(host: HTMLElement, opts: PlotOptions): Plot { return new Plot(host, opts); }
