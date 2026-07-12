import { declutterMembers, type GroupBuilder, type PathContext, type LineJoin, type LineCap } from "../core/index.js";
import { InstancedLane } from "../core/instanced-lane.js";
import { BaseEngine, type InteractiveLayerOptions, type BaseEngineOptions, type LaneInteractive } from "./base-engine.js";
import { LayerHandle } from "./layer-handle.js";
import { resolvePlotPointsSoA, plotPointsCircles, declutterPointsStrategy } from "./points-lane.js";
import { resolveRingColors, ringCircles } from "./highlight-ring.js";
import { dimOthers } from "./selection-dim.js";

/** Shared empty kept-set returned by a points highlight lane when nothing is selected/hovered. */
const EMPTY_KEPT = new Uint32Array(0);

/** Plot adds no engine-level options of its own — all of {@link BaseEngineOptions}
 *  (sizing, `backend`, `tooltipClass`) apply. */
export interface PlotOptions extends BaseEngineOptions {}
export interface PlotLayerOptions<D = unknown> extends InteractiveLayerOptions<D> {
  /**
   * Draw one datum's geometry by emitting path commands. The context is **deliberately typed
   * as `CanvasRenderingContext2D`** so d3 generators that render to a context —
   * `d3.linkHorizontal()`, `d3.linkRadial()`, `d3.line()`, `d3.arc()`,
   * `geoPath(projection, ctx)`, `d3.ribbon()`, … — accept it directly with no cast (d3's
   * typings demand the full context). At runtime the engine passes a {@link PathContext} —
   * only the path-building subset (moveTo/lineTo/bezierCurveTo/quadraticCurveTo/arc/arcTo/
   * rect/closePath) is implemented; fills/strokes come from the layer options below, not
   * from context state, and non-path members don't exist at runtime. Hand-written draw code
   * that wants the honest contract can type its own helper against the exported `PathContext`.
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

export interface PlotPointOptions<D = unknown> extends InteractiveLayerOptions<D> {
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
interface PointsLayerInfo<D> {
  data: D[];
  ids: (string | number)[];
  opts: PlotPointOptions<D>;
}

export class Plot extends BaseEngine {
  /** Re-sync closure per non-passThrough points() layer, run by onBackendChanged() to
   *  re-evaluate lane vs. Scene eligibility when the backend upgrades or downgrades. Each
   *  closure captures its layer's {@link PointsLayerInfo} with the datum type `D` intact —
   *  the datum-erased registry never re-derives it (the #221 seam). Initialized lazily
   *  (not as a class field) so it is ready before the BaseEngine constructor fires
   *  onBackendChanged() during `super()`. */
  private _pointsLayers: Map<string, () => void> | undefined;
  private get pointsLayers(): Map<string, () => void> {
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
    for (const sync of this.pointsLayers.values()) sync();
  }

  /**
   * Register (or re-register) one non-passThrough points layer on the correct path for
   * the CURRENT backend:
   * - useLane: register an instanced lane + optional no-op Scene spec for tooltip dispatch.
   *   If a real Scene spec for this name was previously registered (from a canvas phase),
   *   replace it with an empty build so there is no double-draw.
   * - !useLane: unregister any instanced lane; register the real Scene LayerSpec.
   */
  private syncPointsLayer<D>(name: string, info: PointsLayerInfo<D>): void {
    const { data: list, ids, opts } = info;

    // A decluttered points layer renders via the instanced lane even when interactive (#105 N7c-2):
    // selection/hover are drawn by a companion ring overlay, tooltip/pick resolve through the lane. Only
    // passThrough/clipTo (which the lane can't express) fall back to the Scene path. Non-decluttered
    // points still go Scene (the lane IS the declutter path).
    const declutter = opts.declutter;
    const useLane = !opts.passThrough && !opts.clipTo
      && declutter != null && declutter > 0 && !!this.backend()?.setInstancedLayer;

    const laneName = "points:" + name;
    const hlLaneName = laneName + ":hl";

    if (useLane) {
      const { radius, fill } = opts;
      const pointRadiusOf = typeof radius === "function" ? radius : (): number => radius ?? 3;
      const fillOf = typeof fill === "function" ? fill : (): string => fill ?? "#000";
      const screenSized = (opts.sizeMode ?? "world") === "screen";

      // Resolve the full per-point SoA ONCE (data/style change only, not per-frame).
      // Each accessor is called exactly N times here, never again during setTransform.
      const { allCenters, allRadii, allColors } = resolvePlotPointsSoA(list, opts.x, opts.y, pointRadiusOf, fillOf);

      // Allocate scratch buffers at capacity N (reused every frame — no per-frame allocation).
      const n = list.length;
      const scratchCenters = new Float32Array(n * 2);
      const scratchRadii = new Float32Array(n);
      const scratchColors = new Uint8Array(n * 4);

      // members() needs each point's kept survivor — track it only when the layer is interactive.
      const ixOpts = this.interactionFields(opts);
      const interactive = !!(ixOpts.selectable || ixOpts.hover || ixOpts.tooltip || ixOpts.selection);
      const winners = interactive ? new Int32Array(n) : undefined;
      const strategy = declutterPointsStrategy(n, allCenters, allRadii, declutter, undefined, this.width, this.height, screenSized, winners);
      const srcLane = new InstancedLane(strategy, (vis) => {
        // Gather kept indices into scratch buffers (no accessor calls, no rgb() parse, no allocation).
        const circles = plotPointsCircles(vis, allCenters, allRadii, allColors, scratchCenters, scratchRadii, scratchColors);
        // selection.others dimming (#162): fade non-selected kept points to the layer's others-opacity,
        // matching Scene layers + network. O(1) when nothing is selected (othersDim short-circuits).
        const dimOp = this.othersDim(name);
        if (dimOp != null) {
          const selSet = this.selectedIds(name);
          if (selSet && selSet.size) {
            const kept = (k: number): boolean => selSet.has(ids[vis[k]!]!);
            dimOthers(circles.colors, vis.length, dimOp, kept);
            dimOthers(circles.borderColors, vis.length, dimOp, kept);
          }
        }
        return [{ name: laneName, primitive: "circles", circles, sizeMode: opts.sizeMode ?? "world" }];
      });
      const idToIndex = interactive ? new Map(ids.map((id, i) => [id, i])) : undefined;
      const laneInteractive: LaneInteractive<D> | undefined = interactive ? {
        layer: name,
        options: ixOpts,
        highlightLane: hlLaneName,
        datumOf: (id) => { const i = idToIndex!.get(id); return i == null ? null : list[i] ?? null; },
        members: (id) => { const i = idToIndex!.get(id); return i == null || !winners ? [id] : declutterMembers(winners, i, n).map((k) => ids[k]!); },
      } : undefined;
      this.registerInstancedLane(laneName, {
        lane: srcLane,
        layerNames: [laneName],
        dynamic: true,
        resolve: opts.pickable === false ? () => null : (i) => ({ layer: name, id: ids[i]!, datum: list[i] }),
        interactive: laneInteractive,
      });

      // Companion ring overlay drawn on top (registered after the source lane). Registered for any
      // interactive layer so a programmatic select() rings too; its select intersects the highlighted
      // ids with the kept (decluttered) set — O(kept) per refresh, empty until something is shown.
      if (interactive) {
        const colors = resolveRingColors(ixOpts);
        const ringName = hlLaneName + ":ring";
        const ringSizeMode = opts.sizeMode ?? "world";
        this.registerInstancedLane(hlLaneName, {
          lane: new InstancedLane(
            {
              select: () => {
                if (!this.hasHighlight(name)) return EMPTY_KEPT;
                const sel = this.selectedIds(name), hov = this.hoveredIds(name);
                const vis = srcLane.visible;
                const out: number[] = [];
                for (let k = 0; k < vis.length; k++) { const i = vis[k]!; const id = ids[i]!; if (sel?.has(id) || hov?.has(id)) out.push(i); }
                return out.length ? Uint32Array.from(out) : EMPTY_KEPT;
              },
              pick: () => -1,
            },
            (vis) => {
              if (vis.length === 0) return [];
              const selected = this.selectedIds(name);
              return [{ name: ringName, primitive: "circles", sizeMode: ringSizeMode, circles: ringCircles(vis, (i) => [allCenters[i * 2]!, allCenters[i * 2 + 1]!], (i) => allRadii[i]!, (i) => !!selected?.has(ids[i]!), colors) }];
            },
          ),
          layerNames: [ringName], dynamic: true, resolve: () => null,
        });
      } else {
        this.unregisterInstancedLane(hlLaneName);
      }

      // Clear any real Scene spec left from a canvas phase — the lane owns draw + interaction now, and a
      // Scene spec of the same name would double-draw and shadow the lane in pick/selection dispatch.
      if (this.specs.find((s) => s.name === name)) this.removeLayer(name);
    } else {
      // Revert to Scene path: drop the lane (and its ring overlay) if one was registered.
      this.unregisterInstancedLane(hlLaneName);
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

  /**
   * Declare (or re-declare) a named layer of arbitrary `data`, each datum drawn by the
   * `opts.draw` callback emitting path commands — so `d3-shape`/`d3-geo` generators that render
   * to a context (`d3.line()`, `d3.arc()`, `geoPath(projection, ctx)`, …) work directly. Geometry
   * is tessellated once and retained, so all three backends render it identically and it stays
   * crisp under zoom. Re-declaring an existing `name` resets its base styles. Returns a
   * {@link LayerHandle} for appending data and per-layer styling. For large point sets prefer
   * {@link Plot.points}, which batches them through the shared instanced lane.
   *
   * @typeParam D - the datum type passed to `draw` and the accessors.
   */
  layer<D>(name: string, data: readonly D[], opts: PlotLayerOptions<D>): LayerHandle<D> {
    const list = data as D[];
    const ids = list.map((d, i) => (opts.id ? opts.id(d, i) : i));
    this.dropInteractionState(name); // a re-declared layer starts with base styles
    this.registerLayer({ name, data: list, ids, fill: opts.fill, stroke: opts.stroke, clipTo: opts.clipTo, sizeMode: opts.sizeMode, declutter: opts.declutter, pickable: opts.pickable, ...this.interactionFields(opts), build: this.buildDrawables(list, ids, 0, opts) });
    return new LayerHandle<D>(this, name, (items) => this.appendDrawables(name, items, opts));
  }

  /**
   * Declare (or re-declare) a named layer of points positioned by `opts.x`/`opts.y`, rendered
   * through the shared instanced point lane (one draw call for the whole layer). Prefer this over
   * {@link Plot.layer} for large point sets: it scales to millions and supports screen-space
   * `declutter`. `data` may be an array or a callback; with `passThrough: true` points stream
   * uncapped but aren't pickable. Re-declaring an existing `name` resets its interaction/style
   * state. Returns a {@link LayerHandle} for appending data and per-layer styling.
   *
   * @typeParam D - the datum type passed to the accessors.
   */
  points<D>(name: string, data: readonly D[] | (() => readonly D[]), opts: PlotPointOptions<D>): LayerHandle<D> {
    if (opts.passThrough) {
      if (opts.hover || opts.tooltip || opts.selection || opts.selectable)
        throw new Error("hover/tooltip/selection/selectable require a retained layer (passThrough layers are not pickable)");
      if (opts.declutter) throw new Error("declutter requires a retained layer (passThrough has no per-drawable visibility flags)");
      const radius = opts.radius ?? 3;
      const radiusOf = typeof radius === "function" ? radius : (): number => radius;
      const fill = opts.fill;
      const colorOf = typeof fill === "function" ? fill : (): string => fill ?? "#000";
      this.registerPassThrough<D>({
        name,
        source: typeof data === "function" ? () => [...data()] : [...data],
        // plot x/y accessors yield projected world coords directly (view transform applied at draw)
        buildItem: (d, i) => ({
          kind: "points",
          centers: [[opts.x(d, i), opts.y(d, i)]],
          radius: radiusOf(d, i),
          color: colorOf(d, i),
        }),
        sizeMode: opts.sizeMode,
        clipTo: opts.clipTo,
      });
      return new LayerHandle<D>(this, name, (items) => this.appendPassThrough(name, items));
    }
    if (typeof data === "function") throw new Error("callback data requires passThrough: true");
    const list = data as D[];
    const ids = list.map((d, i) => (opts.id ? opts.id(d, i) : i));
    this.dropInteractionState(name); // a re-declared layer starts with base styles

    // Store a re-sync closure so onBackendChanged() can re-register when the backend
    // upgrades/downgrades. The closure keeps the datum type D bound to (data, ids, opts)
    // — the engine-side registry stays datum-erased without re-deriving D (#221).
    const info: PointsLayerInfo<D> = { data: list, ids, opts };
    this.pointsLayers.set(name, () => this.syncPointsLayer(name, info));
    // Delegate registration to syncPointsLayer which handles both lane and Scene paths.
    this.syncPointsLayer(name, info);

    // A declutter layer may render via the instanced lane now OR after a backend upgrade
    // (canvas→WebGL via backend:"auto"), so its handle must ALWAYS throw on append — the
    // lane holds a data snapshot, and appending to the (possibly no-op) Scene spec would
    // silently desync spec.data/spec.ids. The decision must NOT depend on the live backend,
    // or a layer registered on canvas would bind the real append handler and corrupt itself
    // once it upgrades to the lane.
    const laneEligible = !opts.passThrough && !opts.clipTo
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
    // DELIBERATE third-party-boundary cast (#221): d3gl's PathContext implements exactly the
    // path-building subset d3-shape/d3-geo generators emit, but d3's typings demand the full
    // CanvasRenderingContext2D — so the widening happens ONCE here and every user `draw`
    // accepts `d3.line()`/`geoPath(proj, ctx)`/… uncast (the d3-compatibility core value).
    // The exported PathContext type documents the honest contract for hand-written draw code.
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
