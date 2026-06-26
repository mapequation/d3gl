import type { GroupBuilder, PathContext, LineJoin, LineCap } from "../core/index.js";
import { InstancedLane } from "../core/instanced-lane.js";
import { BaseEngine, type InteractiveLayerOptions, type BaseEngineOptions } from "./base-engine.js";
import { LayerHandle } from "./layer-handle.js";
import { resolvePlotPointsSoA, plotPointsCircles, declutterPointsStrategy } from "./points-lane.js";

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

/** Stored per-points() layer so syncPointsLayer can re-evaluate lane eligibility on backend changes. */
interface PointsLayerInfo<D = any> {
  data: D[];
  ids: (string | number)[];
  opts: PlotPointOptions<D>;
}

export class Plot extends BaseEngine {
  /** Retained info for every non-passThrough points() layer. Used by onBackendChanged() to
   *  re-evaluate lane vs. Scene eligibility when the backend upgrades or downgrades.
   *  Initialized lazily (not as a class field) so it is ready before the BaseEngine
   *  constructor fires onBackendChanged() during `super()`. */
  private _pointsLayers: Map<string, PointsLayerInfo> | undefined;
  private get pointsLayers(): Map<string, PointsLayerInfo> {
    if (!this._pointsLayers) this._pointsLayers = new Map();
    return this._pointsLayers;
  }

  constructor(host: HTMLElement, opts: PlotOptions = {}) {
    super(host, opts);
  }

  /** Called by BaseEngine after every backend install (first + swaps). Re-syncs all points()
   *  layers so a canvas→WebGL upgrade promotes eligible layers to the instanced lane, and a
   *  downgrade reverts them to the Scene path. */
  protected override onBackendChanged(): void {
    for (const name of this.pointsLayers.keys()) this.syncPointsLayer(name);
  }

  /**
   * Register (or re-register) one non-passThrough points layer on the correct path for
   * the CURRENT backend:
   * - useLane: register an instanced lane + optional no-op Scene spec for tooltip dispatch.
   *   If a real Scene spec for this name was previously registered (from a canvas phase),
   *   replace it with an empty build so there is no double-draw.
   * - !useLane: unregister any instanced lane; register the real Scene LayerSpec.
   */
  private syncPointsLayer(name: string): void {
    const info = this.pointsLayers.get(name);
    if (!info) return;
    const { data: list, ids, opts } = info;

    const useLane = !opts.passThrough && !opts.clipTo && !opts.hover && !opts.selection
      && opts.declutter != null && opts.declutter > 0 && !!this.backend()?.setInstancedLayer;

    const laneName = "points:" + name;

    if (useLane) {
      const xOf = (d: any, i: number) => opts.x(d, i);
      const yOf = (d: any, i: number) => opts.y(d, i);
      const pointRadiusOf = typeof opts.radius === "function"
        ? (d: any, i: number) => (opts.radius as (d: any, i: number) => number)(d, i)
        : (_d: any, _i: number) => (opts.radius as number | undefined) ?? 3;
      const fillOf = typeof opts.fill === "function"
        ? (d: any, i: number) => (opts.fill as (d: any, i: number) => string)(d, i)
        : (_d: any, _i: number) => (opts.fill as string | undefined) ?? "#000";
      const screenSized = (opts.sizeMode ?? "world") === "screen";

      // Resolve the full per-point SoA ONCE (data/style change only, not per-frame).
      // Each accessor is called exactly N times here, never again during setTransform.
      const { allCenters, allRadii, allColors } = resolvePlotPointsSoA(list, xOf, yOf, pointRadiusOf, fillOf);

      // Allocate scratch buffers at capacity N (reused every frame — no per-frame allocation).
      const n = list.length;
      const scratchCenters = new Float32Array(n * 2);
      const scratchRadii = new Float32Array(n);
      const scratchColors = new Uint8Array(n * 4);

      const strategy = declutterPointsStrategy(n, allCenters, allRadii, opts.declutter as number, undefined, this.width, this.height, screenSized);
      this.registerInstancedLane(laneName, {
        lane: new InstancedLane(strategy, (vis) => [{
          name: laneName,
          primitive: "circles",
          // Gather kept indices into scratch buffers (no accessor calls, no rgb() parse, no allocation).
          circles: plotPointsCircles(vis, allCenters, allRadii, allColors, scratchCenters, scratchRadii, scratchColors),
          sizeMode: opts.sizeMode ?? "world",
        }]),
        layerNames: [laneName],
        dynamic: true,
        resolve: opts.pickable === false ? () => null : (i) => ({ layer: name, id: ids[i]!, datum: list[i] }),
      });

      // Replace any previously-registered real Scene spec for this name with a no-op build
      // (clears tessellated geometry so there's no double-draw with the lane), OR register a
      // tooltip-forwarding no-op spec when tooltip is set (BaseEngine needs it for dispatch).
      if (opts.tooltip || this.specs.find((s) => s.name === name)) {
        this.registerLayer({
          name,
          data: list,
          ids,
          pickable: false,
          tooltip: opts.tooltip,
          build: () => { /* no Scene geometry — lane owns draw + pick */ },
        });
      }
    } else {
      // Revert to Scene path: drop the lane if one was registered.
      this.unregisterInstancedLane(laneName);
      this.registerLayer({
        name, data: list, ids,
        fill: opts.fill, stroke: opts.stroke,
        clipTo: opts.clipTo, sizeMode: opts.sizeMode,
        declutter: opts.declutter,
        pickable: opts.pickable,
        ...this.interactionFields(opts),
        build: this.buildPoints(list, ids, 0, opts),
      });
    }
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

    // Store the layer info so onBackendChanged() can re-sync when the backend upgrades/downgrades.
    this.pointsLayers.set(name, { data: list, ids, opts });
    // Delegate registration to syncPointsLayer which handles both lane and Scene paths.
    this.syncPointsLayer(name);

    // A declutter layer may render via the instanced lane now OR after a backend upgrade
    // (canvas→WebGL via backend:"auto"), so its handle must ALWAYS throw on append — the
    // lane holds a data snapshot, and appending to the (possibly no-op) Scene spec would
    // silently desync spec.data/spec.ids. The decision must NOT depend on the live backend,
    // or a layer registered on canvas would bind the real append handler and corrupt itself
    // once it upgrades to the lane.
    const laneEligible = !opts.passThrough && !opts.clipTo && !opts.hover && !opts.selection
      && opts.declutter != null && opts.declutter > 0;

    return new LayerHandle<D>(this, name, laneEligible
      ? () => { throw new Error("append() is not supported on a declutter points layer (it renders via the instanced lane); rebuild the layer with the full data via points()."); }
      : (items) => this.appendPoints(name, items, opts));
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
