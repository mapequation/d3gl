import type { GroupBuilder, PathContext, LineJoin, LineCap } from "../core/index.js";
import { InstancedLane } from "../core/instanced-lane.js";
import { BaseEngine, type InteractiveLayerOptions, type BaseEngineOptions } from "./base-engine.js";
import { LayerHandle } from "./layer-handle.js";
import { plotPointsCircles, declutterPointsStrategy } from "./points-lane.js";

/** Plot adds no engine-level options of its own — all of {@link BaseEngineOptions}
 *  (sizing, `backend`, `tooltipClass`) apply. */
export interface PlotOptions extends BaseEngineOptions {}
export interface PlotLayerOptions<D = any> extends InteractiveLayerOptions<D> {
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
  /** Stroke corner style: "bevel" (default) | "miter" | "round". Applies to the
   *  whole layer; rendered identically across WebGL/Canvas/SVG. */
  lineJoin?: LineJoin;
  /** Miter length / stroke width above which a miter falls back to a bevel (default 10,
   *  matching the Canvas 2D default). Only affects "miter" joins. */
  miterLimit?: number;
  /** End-cap style for open strokes: "butt" (default) | "square" | "round". Consistent
   *  across WebGL/Canvas/SVG. */
  lineCap?: LineCap;
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
  /** When false, skip the CPU hit index (no hover/pick) — saves an Entry per datum on
   *  huge non-interactive layers. */
  pickable?: boolean;
}

export interface PlotPointOptions<D = any> extends InteractiveLayerOptions<D> {
  x: (d: D, i: number) => number;
  y: (d: D, i: number) => number;
  radius?: number | ((d: D, i: number) => number);
  fill?: string | ((d: D, i: number) => string);
  stroke?: string | ((d: D, i: number) => string);
  id?: (d: D, i: number) => string | number;
  clipTo?: string;
  /** "world" (default): radius scales with zoom. "screen": constant pixel size. */
  sizeMode?: "world" | "screen";
  /** Screen-space declutter radius (px): on each transform, hide points whose projected center
   *  falls within this radius of an already-kept one (earlier data wins). Each point's anchor is
   *  its center, so unlike {@link PlotLayerOptions} no explicit `anchor` is needed. Pairs with
   *  `sizeMode: "screen"`. Retained path only (not `passThrough`). */
  declutter?: number;
  /** When false, skip the CPU hit index (no hover/pick) — saves an Entry per point on
   *  huge non-interactive layers (e.g. streamed points). */
  pickable?: boolean;
  /** Render via the backend's pass-through path: no retained Scene geometry, no hit index
   *  (not pickable). Points are projected + drawn directly each repaint (on both Canvas and
   *  WebGL), so the data may be a callback re-invoked per repaint (you own the array). For
   *  huge / fast-changing point sets beyond the retained ceiling (~4–16M). Trade-off vs the
   *  default retained path: retained is always crisp, interactive, and pickable but capped;
   *  pass-through is uncapped + streaming but shows a slightly stale raster during pan/zoom
   *  (re-crisp on settle) and isn't pickable. */
  passThrough?: boolean;
}

export class Plot extends BaseEngine {
  constructor(host: HTMLElement, opts: PlotOptions = {}) {
    super(host, opts);
  }

  layer<D>(name: string, data: readonly D[], opts: PlotLayerOptions<D>): LayerHandle<D> {
    const list = data as D[];
    const ids = list.map((d, i) => (opts.id ? opts.id(d, i) : i));
    this.dropInteractionState(name); // a re-declared layer starts with base styles
    this.registerLayer({ name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo, sizeMode: opts.sizeMode, declutter: opts.declutter, pickable: opts.pickable, ...this.interactionFields(opts), build: this.buildDrawables(list, ids, 0, opts) });
    return new LayerHandle<D>(this, name, (items) => this.appendDrawables(name, items, opts));
  }

  points<D>(name: string, data: readonly D[] | (() => readonly D[]), opts: PlotPointOptions<D>): LayerHandle<D> {
    if (opts.passThrough) {
      if (opts.hover || opts.tooltip || opts.selection)
        throw new Error("hover/tooltip/selection require a retained layer (passThrough layers are not pickable)");
      if (opts.declutter) throw new Error("declutter requires a retained layer (passThrough has no per-drawable visibility flags)");
      const radius = opts.radius ?? 3;
      const radiusOf = typeof radius === "function"
        ? (d: D, i: number) => (radius as (d: D, i: number) => number)(d, i)
        : () => radius as number;
      const colorOf = typeof opts.fill === "function"
        ? (d: D, i: number) => (opts.fill as (d: D, i: number) => string)(d, i)
        : () => (opts.fill as string | undefined) ?? "#000";
      this.registerPassThrough({
        name,
        source: (typeof data === "function" ? () => [...data()] : [...data]) as unknown[] | (() => unknown[]),
        // plot x/y accessors yield projected world coords directly (view transform applied at draw)
        buildItem: (d, i) => ({
          kind: "points",
          centers: [[opts.x(d as D, i), opts.y(d as D, i)]],
          radius: radiusOf(d as D, i),
          color: colorOf(d as D, i),
        }),
        sizeMode: opts.sizeMode,
        clipTo: opts.clipTo,
      });
      return new LayerHandle<D>(this, name, (items) => this.appendPassThrough(name, items as unknown[]));
    }
    if (typeof data === "function") throw new Error("callback data requires passThrough: true");
    const list = data as D[];
    const ids = list.map((d, i) => (opts.id ? opts.id(d, i) : i));
    this.dropInteractionState(name); // a re-declared layer starts with base styles

    // Eligibility: route to the shared instanced lane when declutter is set, the backend is WebGL
    // (setInstancedLayer available), and no clipTo / passThrough / hover / selection (those need the
    // Scene path: GPU stencil, SVG export, auto-highlight, selection restyle).
    // tooltip IS allowed: a no-op LayerSpec forwards tooltip dispatch through the lane's resolve datum.
    const useLane = !opts.passThrough && !opts.clipTo && !opts.hover && !opts.selection
      && opts.declutter != null && !!this.backend()?.setInstancedLayer;

    if (useLane) {
      // Resolve the same accessors the Scene path would use.
      const xOf = (d: D, i: number) => opts.x(d, i);
      const yOf = (d: D, i: number) => opts.y(d, i);
      const pointRadiusOf = typeof opts.radius === "function"
        ? (d: D, i: number) => (opts.radius as (d: D, i: number) => number)(d, i)
        : (_d: D, _i: number) => (opts.radius as number | undefined) ?? 3;
      const fillOf = typeof opts.fill === "function"
        ? (d: D, i: number) => (opts.fill as (d: D, i: number) => string)(d, i)
        : (_d: D, _i: number) => (opts.fill as string | undefined) ?? "#000";
      const declutterPxOf = (_d: D, _i: number) => opts.declutter as number;
      const screenSized = (opts.sizeMode ?? "world") === "screen";
      const laneName = "points:" + name;

      const strategy = declutterPointsStrategy(list, xOf, yOf, pointRadiusOf, declutterPxOf, undefined, this.width, this.height, screenSized);
      this.registerInstancedLane(laneName, {
        lane: new InstancedLane(strategy, (vis) => [{
          name: laneName,
          primitive: "circles",
          circles: plotPointsCircles(list, vis, xOf, yOf, pointRadiusOf, fillOf, vis.length),
          sizeMode: opts.sizeMode ?? "world",
        }]),
        layerNames: [laneName],
        dynamic: true,
        resolve: opts.pickable === false ? () => null : (i) => ({ layer: name, id: ids[i]!, datum: list[i] }),
      });

      // If tooltip is set, register a no-op LayerSpec so BaseEngine's tooltip dispatch resolves
      // hit.layer === name → spec.tooltip. pickable:false means no Scene HitIndex (the lane owns pick).
      if (opts.tooltip) {
        this.registerLayer({
          name,
          data: list,
          ids,
          pickable: false,
          tooltip: opts.tooltip,
          build: () => { /* no Scene geometry — lane owns draw + pick */ },
        });
        // Attach pointer listeners for the tooltip (registerLayer only attaches when spec.hover or tooltip is set,
        // but we need the pointermove guard to include this spec's tooltip).
      }

      return new LayerHandle<D>(this, name, () => { /* append not supported on lane layers */ });
    }

    this.registerLayer({ name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo, sizeMode: opts.sizeMode, declutter: opts.declutter, pickable: opts.pickable, ...this.interactionFields(opts), build: this.buildPoints(list, ids, 0, opts) });
    return new LayerHandle<D>(this, name, (items) => this.appendPoints(name, items, opts));
  }

  private appendDrawables<D>(name: string, items: readonly D[], opts: PlotLayerOptions<D>): void {
    if (items.length === 0) return;
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) throw new Error(`unknown layer: ${name}`);
    const base = spec.data.length;
    const ids = items.map((d, j) => (opts.id ? opts.id(d, base + j) : base + j));
    this.appendToLayer(name, items, ids, this.buildDrawables(items, ids, base, opts));
  }

  private appendPoints<D>(name: string, items: readonly D[], opts: PlotPointOptions<D>): void {
    if (items.length === 0) return;
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) throw new Error(`unknown layer: ${name}`);
    const base = spec.data.length;
    const ids = items.map((d, j) => (opts.id ? opts.id(d, base + j) : base + j));
    this.appendToLayer(name, items, ids, this.buildPoints(items, ids, base, opts));
  }

  /** Build a chunk of context-draw drawables. `base` is the global index of items[0]
   *  (0 for the initial layer, current length for an append) so user accessors see a
   *  stable index. */
  private buildDrawables<D>(items: readonly D[], ids: (string | number)[], base: number, opts: PlotLayerOptions<D>): (g: GroupBuilder) => void {
    const lw = opts.lineWidth;
    const widthOf = typeof lw === "function" ? lw : (_d: D, _i: number) => lw as number;
    const anchorOf = opts.anchor;
    const { lineJoin, miterLimit, lineCap } = opts;
    // d3gl's PathContext implements the path-building subset d3 generators use; present
    // it as CanvasRenderingContext2D so user draw code needs no cast. Single cast here.
    return (g) =>
      items.forEach((d, j) =>
        g.drawable(
          ids[j]!,
          (ctx: PathContext) => opts.draw(ctx as unknown as CanvasRenderingContext2D, d, base + j),
          lw != null || anchorOf
            ? { lineWidth: lw != null ? widthOf(d, base + j) : 0, anchor: anchorOf?.(d, base + j), lineJoin, miterLimit, lineCap }
            : undefined,
        ),
      );
  }

  /** Build a chunk of point drawables (see buildDrawables for `base`). */
  private buildPoints<D>(items: readonly D[], ids: (string | number)[], base: number, opts: PlotPointOptions<D>): (g: GroupBuilder) => void {
    const resolveRadius = typeof opts.radius === "function" ? opts.radius : (_d: D, _i: number) => (opts.radius as number | undefined) ?? 3;
    return (g) => items.forEach((d, j) => g.point(ids[j]!, opts.x(d, base + j), opts.y(d, base + j), resolveRadius(d, base + j)));
  }
}
export function plot(host: HTMLElement, opts: PlotOptions = {}): Plot { return new Plot(host, opts); }
