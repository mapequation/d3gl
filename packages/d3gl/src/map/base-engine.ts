import { select, type Selection } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from "d3-zoom";
import { Scene, HitIndex, declutterScreen, declutterScratch, instancedVectorLayers, DEFAULT_CURVE_TOLERANCE, type Backend, type GroupBuilder, type RenderLayer, type VectorLayer, type ViewTransform, type DeclutterScratch, type TextData } from "../core/index.js";
import { LabelLayer, placeLabels, labelCullScratch, labelTextY, resolveLabelStyle, measureText, canvasFont, DEFAULT_LABEL_TEXT, type LabelAnchor, type LabelStyle } from "../labels/index.js";
import type { TextAnchor, LabelBox } from "../labels/cull.js";
import { InstancedLane, type ScreenRect } from "../core/instanced-lane.js";
import { createBackend, createCanvasBackend, type BackendType, type BackendHandle } from "./backend-factory.js";
import { buildBatch, type DrawItem } from "./draw-batch.js";
import { composeColor, type StyleOverride, type SelectionOptions } from "./style-overrides.js";
import { HighlightBuilder, resolveHighlight, hoverParts, HIGHLIGHT_SUFFIX, type HighlightStyle, type HighlightDraw, type HoverOption, type HoverOptions, type PendingColor } from "./highlight.js";
import { Tooltip } from "./tooltip.js";

export type Accessor<D, T> = T | ((d: D, i: number) => T);
export interface HoverHit {
  layer: string;
  id: string | number;
  datum: unknown;
  /**
   * Underlying source ids this hit represents — for inspecting what an aggregate/decluttered glyph
   * stands for (#105 N7c-2). A network LOD aggregate → its leaf node ids; a decluttered glyph →
   * itself + the glyphs absorbed under it; a plain glyph → `[id]`. Lazy: enumeration runs only when
   * called (network = subtree DFS, declutter = a `winners` inverse-scan), never on the pick hot path.
   * Present on `on("hover" | "click")` hits and every `selection()` entry; absent for non-pickable hits.
   */
  members?: () => (string | number)[];
}

/** A registered instanced selection lane (#108-B). BaseEngine drives its re-emit + resolves its picks.
 *  Generic over the datum type `D` its interaction block resolves (see {@link LaneInteractive});
 *  stored datum-erased in the engine's registry via the {@link BaseEngine.registerInstancedLane} overload. */
export interface InstancedLaneEntry<D = unknown> {
  lane: InstancedLane;
  /** The instanced layer names this lane emits — cleared then re-added in this order each emit (draw order). */
  layerNames: readonly string[];
  /** Re-select + re-emit on every setTransform (zoom-dependent: LOD cut / declutter). Static lanes emit once at register. */
  dynamic: boolean;
  /** Re-emit this base lane when the HOVER set changes, not just on selection change (#162). Set by lanes
   *  whose emit styles by hover — e.g. network recolours the hovered node's existing links. Plot leaves it
   *  unset (its hover is only the ring overlay), so a hover doesn't needlessly re-upload the points buffer. */
  hoverDirtiesBase?: boolean;
  /** Map a picked source index (from `lane.pick`) to a HoverHit for hover/click dispatch; null = treat as a miss. */
  resolve(index: number): HoverHit | null;
  /**
   * Opt this lane into hover/selection (#105 N7c-2). When present, the lane's glyphs participate in
   * the same `on("select")` / `selection()` / hover-highlight machinery as Scene layers — styling is
   * a ring overlay drawn by a companion highlight lane (instanced glyphs have no Scene drawables to
   * recolor). Absent ⇒ pick-only (the pre-N7c-2 behavior: `on("hover"|"click")` fire, but no
   * managed selection or visual highlight).
   */
  interactive?: LaneInteractive<D>;
  /**
   * GPU-readback link picking (#141). When set, {@link BaseEngine.pick} consults the backend's pick
   * FBO ({@link Backend.pickInstanced}) *after* the CPU `lane.pick` misses (so a node drawn over a
   * link still wins), and maps the decoded instance index back to a HoverHit. This is the second pick
   * backend the issue describes — pixel-exact over the actual drawn link geometry (thin strips /
   * half-arrows) where the CPU frontier picker (circles only) can't be exact. Returns null on a miss.
   */
  gpuPick?(index: number): HoverHit | null;
}

/**
 * Interaction surface for an instanced lane (#105 N7c-2) — the lane analogue of the per-layer
 * {@link InteractiveLayerOptions} that Scene layers carry on their {@link LayerSpec}. Selection/hover
 * styling is rendered as a **ring overlay** by a separate companion lane (`highlightLane`), since
 * instanced glyphs have no Scene drawables to recolor; `selection.others` dimming is therefore not
 * applied on lanes (selected glyphs get a ring instead).
 */
export interface LaneInteractive<D = unknown> {
  /** The `hit.layer` value this lane owns — the key under which selection/hover ids are tracked. */
  layer: string;
  /** Per-layer interaction options (selectable / hover / tooltip / selection). */
  options: InteractiveLayerOptions<D>;
  /** Companion highlight lane re-emitted when this layer's selection/hover set changes (the ring overlay). */
  highlightLane: string;
  /** Datum for a selected/hovered id — used to rebuild hits in {@link BaseEngine.selection}. */
  datumOf(id: string | number): D | null;
  /** Underlying source ids `id` represents, for {@link HoverHit.members} (subtree leaves / absorbed set). */
  members(id: string | number): (string | number)[];
}

/**
 * Declarative interaction options shared by every engine's retained layers. The machinery
 * (hover overlay, tooltip, selection styling, hit-testing) lives entirely in {@link BaseEngine} —
 * these options are just the per-layer surface that both {@link BaseEngine.select}'s and the
 * hover/tooltip dispatch read. `Plot.layer()`/`Plot.points()` and `GeoMap.layer()` forward them
 * into the {@link LayerSpec} via {@link BaseEngine.interactionFields}, so the contract has one home.
 */
export interface InteractiveLayerOptions<D = unknown> {
  /** Styles for {@link BaseEngine.select}: the selected set and its complement.
   *  Defaults: selected keeps the base style; others `{ opacity: 0.3 }`. */
  selection?: SelectionOptions;
  /** Hover-highlight, symmetric with {@link selection} (#162). `true` enables the default outline/ring.
   *  A {@link HoverOptions} object — `{ hovered?, others? }` — styles it: `hovered` is how the hovered
   *  item looks (a {@link HighlightStyle} redraw / custom `(datum, HighlightBuilder)` draw fn on Scene
   *  layers; the ring's `stroke` on instanced lanes), and `others` fades the non-hovered glyphs (the
   *  hover analogue of `selection.others`, opt-in — honored on instanced lanes via the shader, so it's
   *  a uniform change that stays free even on a full LOD-off draw). A bare `HighlightStyle`/draw-fn is
   *  still accepted as shorthand for `{ hovered: … }`. The hovered item is redrawn in a tiny overlay
   *  layer — O(hovered item) per change; the base layer is untouched. */
  hover?: HoverOption<D> | HoverOptions<D>;
  /** Hover tooltip content for this layer (`null` hides). Shown in a shared engine-managed div —
   *  see `tooltipClass` for styling. Re-evaluated only when the hovered target changes;
   *  re-declare the layer to force a refresh. */
  tooltip?: (d: D, id: string | number) => string | HTMLElement | null;
  /** Opt this layer into click-driven selection. `true` or `{}` = single-select (plain click
   *  replaces the selection). `{ multi: true }` = shift/cmd/ctrl-click toggles add/remove;
   *  plain click replaces. Omitting this option leaves the layer un-selectable (no gesture,
   *  no styling on click). The pointer listeners are attached when the layer is registered —
   *  independently of `on("select")`, which is a pure observer. */
  selectable?: boolean | { multi?: boolean };
  /** Opt this layer's glyphs into **node-drag** (#140): a plain drag starting on a glyph moves it
   *  (instead of panning), reheating the layout. Honored only by engines that implement node-drag
   *  ({@link BaseEngine.beginNodeDrag} — currently `network()`); ignored by geoMap/plot. The pointer
   *  listeners are attached when the layer is registered, like `selectable`. */
  draggable?: boolean;
}

/**
 * An in-progress node-drag (#140). Returned by {@link BaseEngine.beginNodeDrag} once the pointer
 * travels past the click threshold; {@link BaseEngine} feeds it pointer moves (host CSS px) and ends
 * it on pointer-up. The engine owns the physics (which nodes move, how the sim reheats / re-cools);
 * BaseEngine owns only the gesture plumbing (hit-test, window listeners, screen coordinates).
 */
export interface NodeDragSession {
  /** Pointer moved to host-relative CSS px (sx, sy) — translate the held set there. */
  move(sx: number, sy: number): void;
  /** Pointer released — release the pins and let the layout re-cool. */
  end(): void;
}

/**
 * Engine-owned text labels for `plot()` / `geoMap()` (#223) — the data-driven analogue of
 * `network.labels()`. You supply the data and d3-style accessors; the engine measures each label's
 * text once (no magic-number metrics), places + culls collisions on every pan/zoom (the shared
 * {@link LabelLayer} machinery), and routes to the active backend — an HTML overlay on WebGL, native
 * `<text>`/`fillText` on SVG/Canvas so labels survive `toSVG()`/`toPNG()` export. Styling mirrors
 * `network.labels()`: a built-in default look, an inline {@link style} override, or a full-CSS
 * {@link className}. Plain labels are vertically centred on the anchor (offset sits them beside the
 * glyph); set {@link rotationOf} for the oriented (rotated) model.
 */
export interface DataLabelOptions<D = unknown> {
  /** The label text for a datum, or `null`/`""` to skip it (no label for that datum). */
  labelOf: (d: D, i: number) => string | null | undefined;
  /** The label's REFERENCE (world / pre-transform) anchor `[x, y]`; `null`/`undefined` skips it.
   *  For `geoMap` this is a projected point (e.g. `projection(feature.geometry.coordinates)`). */
  anchorOf: (d: D, i: number) => [number, number] | null | undefined;
  /** Importance for collision priority and, when {@link max} caps, ranking (higher wins). Default 0. */
  importanceOf?: (d: D, i: number) => number;
  /** Constant screen-px offset `[dx, dy]` from the anchor, or a per-datum accessor. Default `[0, 0]`. */
  offset?: [number, number] | ((d: D, i: number) => [number, number]);
  /** Oriented labels: reading-direction angle (radians) per datum — switches to the rotated
   *  collision/render model (text runs along the axis, vertically centred on the anchor). */
  rotationOf?: (d: D, i: number) => number;
  /** Which way text runs from the anchor (default `"start"`). Also places a PLAIN label's box —
   *  `"middle"` centres it on the anchor — with the CSS transform derived to match (#204). */
  textAnchor?: TextAnchor;
  /** Oriented labels only: flip 180° to keep text upright (radial-tree readability flip). */
  keepUpright?: boolean;
  /** Cap the number of shown labels to the top-k by importance (default: no cap — collision thins). */
  max?: number;
  /** Inline overlay CSS (camelCased property → value), merged over the built-in default label look
   *  (a dark 11px sans-serif with a white halo) — a partial override like `{ color: "#333" }` keeps
   *  the rest. Applied once per element at creation, never per frame. */
  style?: LabelStyle;
  /** Advanced overlay styling: a CSS class that SKIPS the built-in default so the class's CSS has
   *  full control (combine with {@link style} for inline overrides). */
  className?: string;
  /** Font for backend-native text (SVG/Canvas, incl. export). Defaults to {@link style}'s font, then
   *  the built-in default. Also the font used to MEASURE label boxes. */
  font?: string;
  /** Fill colour for backend-native text. Defaults to {@link style}'s colour, then the default. */
  color?: string;
  /** Legibility halo stroked behind backend-native text. Defaults to the built-in white halo unless
   *  {@link style} sets `textShadow: "none"`. */
  halo?: { color: string; width: number };
}

/**
 * A registered retained layer, generic over its datum type `D`. Engines construct a
 * `LayerSpec<D>` with the concrete datum from `layer()`/`points()` registration, so `data`
 * and its accessors (`fill`/`stroke`/`tooltip`/`hover`) stay bound to the same `D` and can't
 * detype. {@link BaseEngine} stores specs datum-erased (`LayerSpec<unknown>` — the engine
 * never inspects a datum, it only pairs `data[i]` back with the layer's own accessors);
 * the typed→erased hand-off happens at the {@link BaseEngine.registerLayer} overload.
 */
export interface LayerSpec<D = unknown> {
  name: string;
  data: D[];
  ids: (string | number)[];
  fill?: Accessor<D, string>;
  stroke?: Accessor<D, string>;
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
  /** When false, no CPU hit index is built for this layer (pick() can't hit it). Skips
   *  ~one Entry object per drawable — worth it for huge, non-interactive streamed layers. */
  pickable?: boolean;
  /** Styles applied by {@link BaseEngine.select} to the selected set / its complement. */
  selection?: SelectionOptions;
  /** Hover-highlight for this layer: `true`/style/fn, or a `{ hovered?, others? }` object (#162). */
  hover?: HoverOption<D> | HoverOptions<D>;
  /** Tooltip content for the hovered drawable (string / element / null = hide). */
  tooltip?: (d: D, id: string | number) => string | HTMLElement | null;
  /** Opt this layer into click-driven selection (see {@link InteractiveLayerOptions.selectable}). */
  selectable?: boolean | { multi?: boolean };
  build: (g: GroupBuilder) => void;   // rebuilds the Scene group (geo or draw)
}

/** A pass-through (non-retained) layer, generic over its datum type `D` — `source` and
 *  `buildItem` stay bound to the same `D`. Stored datum-erased like {@link LayerSpec}, with
 *  the typed→erased hand-off at the {@link BaseEngine.registerPassThrough} overload. */
export interface PassThroughSpec<D = unknown> {
  name: string;
  /** User data source: an array, or a function re-invoked each full repaint. */
  source: readonly D[] | (() => readonly D[]);
  /** Build the draw item for a datum, or null to cull. Built by the subclass. */
  buildItem: (d: D, i: number) => DrawItem | null;
  sizeMode?: "world" | "screen";
  clipTo?: string;
}

/**
 * How an engine is sized. Sizing is **responsive by default** — the engine observes its host
 * and resizes in place (no teardown), preserving layers, view, and interaction state:
 *
 * - `aspectRatio` set → width-driven: the host fills the available width and keeps this
 *   width÷height ratio (a CSS `aspect-ratio` on the host); the engine tracks the resulting box.
 * - neither `width` nor `height` → fill-parent: the engine tracks the host's box. The host must
 *   get a height from your layout (CSS), since the rendering surface is absolutely positioned.
 * - both `width` and `height` → fixed: a static size, the opt-out (the pre-responsive behavior).
 */
export interface EngineSizing {
  width?: number;
  height?: number;
  /** width ÷ height. When set, the engine is width-driven and keeps this ratio on resize. */
  aspectRatio?: number;
}

/**
 * Options every engine shares, owned and consumed once by the {@link BaseEngine} constructor.
 * Each engine's options type (e.g. `GeoMapOptions`, `PlotOptions`) extends this and adds only
 * its own fields, so a base-level setting is declared in exactly one place and can't drift or
 * be silently dropped by an engine that forgot to wire it.
 */
export interface BaseEngineOptions extends EngineSizing {
  /** Which renderer to draw with — see {@link BackendType}. Defaults to `"webgl"`.
   *  Use `"auto"` for an instant Canvas first paint that upgrades to WebGL in the background. */
  backend?: BackendType;
  /** Class(es) for the hover tooltip box, replacing its default inline look. */
  tooltipClass?: string;
  /**
   * Max deviation, **in world units**, between a curve (`arc` / `bezierCurveTo` /
   * `quadraticCurveTo` in a layer's `draw`) and the polyline it is baked to. Default
   * {@link DEFAULT_CURVE_TOLERANCE} (0.25).
   *
   * The bake happens **once**, when a layer is registered, and the view transform only
   * scales it — so a facet measuring `t` world units measures `t·k` screen px at zoom `k`
   * (#45). A chart that zooms to `kMax` and wants sub-pixel curves therefore wants
   * `curveTolerance: 0.25 / kMax`.
   *
   * It is a quality/size dial, not a free win, and it is deliberately opt-in: an arc's
   * segment count grows as `1/sqrt(tolerance)`, so `0.25 / 40` bakes ~6.3× the vertices
   * **of the curved drawables only** (straight paths, `rect`s, and `points()` circles —
   * which every backend draws analytically — are untouched). Costs nothing per frame.
   *
   * One setting governs the whole engine, so it also refines **anchored `sizeMode: "screen"`
   * glyphs**, whose offsets are used directly as pixels and therefore never facet — those
   * extra vertices buy nothing. (An unanchored screen-`sizeMode` layer *is* world-scaled and
   * does want the finer bake.) Splitting the tolerance per drawable is tracked separately.
   */
  curveTolerance?: number;
}



/** Fallback CSS size used only when a responsive host can't be measured yet (detached / zero
 *  box); the ResizeObserver corrects it on the first real layout. Matches the <canvas> defaults. */
const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 150;

export abstract class BaseEngine {
  /** Build-time curve-flattening tolerance in world units — see
   *  {@link BaseEngineOptions.curveTolerance}. Read by every path that records a curve
   *  outside the Scene (e.g. the geo pass-through recorder), so one option governs them all. */
  protected readonly curveTolerance: number;
  protected scene: Scene;
  protected specs: LayerSpec[] = [];
  protected hitIndexes = new Map<string, HitIndex>();
  /** Pass-through layers: no Scene entry, no retained geometry. */
  protected ptSpecs = new Map<string, PassThroughSpec>();
  /** Instanced selection lanes (#108-B): drives re-emit on setTransform; resolves picks. */
  protected instancedLanes = new Map<string, InstancedLaneEntry>();
  /** Per-lane name-set from its last emit — lets {@link emitInstancedLane} keep the update-in-place
   *  fast path only while the present-layer set is unchanged, and re-add in emit order on a change
   *  (so a reappearing layer can't be appended out of draw order — the backend draws in insertion order). */
  private laneEmittedNames = new Map<string, Set<string>>();
  /** Per-layer id → datum index, maintained incrementally so an append's duplicate-id
   *  check stays O(new) (not O(total)/batch) AND so pick()/restyle resolve a datum
   *  index in O(1) instead of spec.ids.indexOf (O(n) per pointer move). */
  private layerIds = new Map<string, Map<string | number, number>>();
  /** Per-layer style overrides (id → override), composed over the base accessor colors.
   *  Survive rebuilds (reapplied after applyAccessors); dropped when the layer is
   *  re-declared via layer() (its ids may change). */
  private styleOverrides = new Map<string, Map<string | number, StyleOverride>>();
  /** Active highlight per source layer; re-resolved after a rebuild re-projects geometry. */
  private highlights = new Map<string, { ids: (string | number)[]; styleOrDraw?: HighlightStyle | HighlightDraw }>();
  protected transform: ViewTransform = { k: 1, x: 0, y: 0 };
  /** Shared frontier/data label overlay (#105 N7b, #223): the HTML overlay used on the WebGL backend
   *  (crisp + accessible). Owned by the base so every engine's label API — `network.labels()` and the
   *  plot/geo `labels(data, opts)` — reuses one overlay + one placement/routing path. Null when off. */
  protected labelLayer: LabelLayer | null = null;
  /** Backend-native text style (SVG/Canvas `<text>`/`fillText`, incl. export) for the current label
   *  set — set once by {@link createLabelOverlay}, read by {@link routeLabels}. Null when off. */
  private labelText: { font?: string; color?: string; halo?: { color: string; width: number } } | null = null;
  /** The last {@link routeLabels} anchor set, retained (reference only) for the export-only text
   *  backend push (#219): a WebGL toPNG()/toSVG() places these once at export time. Always current —
   *  the overlay branch of routeLabels runs on every transform/rebuild. Covers BOTH network frontier
   *  labels and plot/geo data labels (#223), since both route through routeLabels. */
  private exportAnchors: readonly LabelAnchor[] = [];
  /** Retained cull buffers for the native-text placement path (#204) — `routeLabels` places on every
   *  transform on SVG/Canvas, so the grid + geometry scratch is reused instead of re-allocated. */
  private readonly labelCull = labelCullScratch();
  /** Retained plot/geo data-label anchors (#223): measured + built ONCE at `labels(data, opts)` call,
   *  re-placed (not rebuilt/re-measured) on every transform. `max` caps the shown set (default ∞). */
  private dataLabels: { anchors: LabelAnchor[]; max: number } | null = null;
  protected handle: BackendHandle | null = null;
  protected ready: Promise<void>;
  private currentBackend: BackendType;
  private hoverCb: ((hit: HoverHit | null, ev: PointerEvent) => void) | null = null;
  private clickCb: ((hit: HoverHit | null, ev: PointerEvent) => void) | null = null;
  private selectCb: ((selected: HoverHit[], ev?: PointerEvent) => void) | null = null;
  /** Selected ids per layer (gesture-driven multi-select, #79). */
  private selected = new Map<string, Set<string | number>>();
  /** Transient hover ids per instanced-lane layer (#105 N7c-2) — the hover-ring set, distinct from
   *  the persistent `selected` set. Read by a lane's companion highlight strategy. At most one entry. */
  private laneHilite = new Map<string, Set<string | number>>();
  /** Transient "will-be-removed" ids per instanced-lane layer (#140): the selected glyphs a live
   *  **subtract** marquee currently covers. Read by a lane's highlight strategy to ring them red. */
  private laneRemove = new Map<string, Set<string | number>>();
  /** Instanced-lane layer whose hover ring is currently shown (auto-hover), so a target change clears it. */
  private laneHoverLayer: string | null = null;
  /** Per-Scene-layer declutter `winners` array (id→kept survivor), for `members()` on decluttered glyphs. */
  private declutterWinners = new Map<string, Int32Array>();
  /** Last hover pick, for cheap same-target exits while the pointer stays inside one drawable. */
  private lastHover: HoverHit | null = null;
  /** Source layer whose hover-option highlight is currently shown (auto, not manual). */
  private autoHover: string | null = null;
  private tooltipEl: Tooltip | null = null;
  /** Replaces the tooltip's default inline look when set (e.g. utility classes). */
  protected tooltipClass?: string;
  /** pointerdown position; a pointerup within CLICK_SLOP px of it is a click. */
  private downAt: [number, number] | null = null;
  /** Max pointer travel (px) between down and up for a click — suppresses pan/rotate drags. */
  private static readonly CLICK_SLOP = 4;
  /** Active shift+drag marquee (#159): viewport-space start point; `shown` flips true once the drag
   *  passes the click slop (the overlay box appears). Null when idle. */
  private marquee: { startClientX: number; startClientY: number; shown: boolean } | null = null;
  /** The marquee overlay box + mode badge are created ONCE and reused across gestures (#162): shown on
   *  drag, hidden (not removed) on end. A single reused pair can't be orphaned in the DOM when a gesture
   *  is interrupted (e.g. a ctrl-click context menu), which is how duplicate badges used to accumulate. */
  private marqueeEl: HTMLElement | null = null;
  private marqueeBadge: HTMLElement | null = null;
  /** Lane layers currently showing the live marquee preview (the will-be-selected hover ring), to clear on end. */
  private marqueePreview = new Set<string>();
  /** Active node-drag (#140): the grabbed hit + viewport-space start, plus the session once the pointer
   *  travels past CLICK_SLOP (lazy, so a plain click on a node doesn't reheat the layout). Null when idle. */
  private nodeDrag: { hit: HoverHit; startClientX: number; startClientY: number; session: NodeDragSession | null } | null = null;
  private swapToken = 0;
  private destroyed = false;
  /** "auto" mode only: the WebGL upgrade promise (in-flight, then settled). Null until
   *  enterAutoMode() starts the upgrade; not reset afterwards. */
  private upgradeDone: Promise<void> | null = null;
  /** True only while the background "auto" → WebGL upgrade is in flight. Gates the
   *  same-backend no-op in setBackend so a backend pick during the upgrade still swaps,
   *  and marks the live Canvas backend as the *placeholder* ({@link skipPlaceholderEmit}). */
  private upgrading = false;
  /** True once {@link skipPlaceholderEmit} has withheld an emit from the placeholder canvas —
   *  so an upgrade that never installs WebGL knows it must re-install canvas and let the
   *  engines emit for real ({@link upgradeToWebGL}). Cleared by any explicit backend pick. */
  private withheldFromPlaceholder = false;
  /** True while the user is interacting (a rotation drag, or a zoom/pan gesture).
   *  Layers flagged hideOnInteraction are excluded from the render while this is true. */
  protected interacting = false;
  /** Detaches the currently-attached interaction (zoom or rotation), if any. */
  private interactionCleanup: (() => void) | null = null;
  /** Live d3-zoom selection + behaviour set by {@link enableZoom}, kept so a programmatic view
   *  change (e.g. fit-on-layout streaming) can re-seed the gesture's internal transform via
   *  {@link syncZoomToView} without a subsequent user gesture jumping from a stale base. */
  private zoomSel: Selection<Element, unknown, null, undefined> | null = null;
  private zoomBehavior: ZoomBehavior<Element, unknown> | null = null;
  /** While true, the zoom handler ignores its event — set only while {@link syncZoomToView}
   *  programmatically re-seeds the gesture transform, so re-seeding does not recurse into setTransform. */
  private suppressZoomEmit = false;
  /** True only for the duration of the `setTransform` the zoom handler itself makes. That call is
   *  already in step with d3-zoom, so it must NOT re-seed — re-seeding on every gesture frame would
   *  put a `behavior.transform` apply on the interaction path for no benefit (#202). */
  private inZoomGesture = false;
  /** Repaint-cycle token for the pass-through layers (#110). ONE token for the whole set,
   *  not one per layer, because {@link repaintPassThrough} repaints every pass-through layer
   *  as a single cycle into the shared accumulation surface: a newer cycle (or an interaction)
   *  bumps it and any in-flight time slice bails on its next rAF step. */
  private ptCycleToken = 0;
  /** Rows projected+drawn per rAF slice, summed across the pass-through layers of one cycle.
   *  Big enough that a few-hundred-k layer finishes in one or two frames, small enough that a
   *  multi-million-point fill never blocks the main thread. Module-internal (no public API);
   *  tests stub it via the static field. */
  protected static PT_CHUNK = 500_000;

  /** Current CSS size (px). Set by the constructor's sizing resolution and by setSize(). */
  protected width = 0;
  protected height = 0;
  /** width ÷ height in width-driven mode; undefined otherwise. */
  private aspectRatio?: number;
  /** Whether the engine tracks its host (fill / aspect modes) vs. a fixed size. */
  private responsive = false;
  /** Reusable scratch for the per-zoom screen-space declutter ({@link declutterLayer}): projected
   *  anchor coordinates, the shared declutter grid ({@link DeclutterScratch}), and the per-group
   *  visibility flags — so the hot path (declutter runs on every zoom) allocates nothing per frame.
   *  Grown on demand; never freed. */
  private dcSx: Float64Array | null = null;
  private dcSy: Float64Array | null = null;
  private dcVisible: Uint8Array | null = null;
  private dcScratch: DeclutterScratch = declutterScratch();
  /** Observes the host in responsive modes; coalesced into one rAF per burst. */
  private sizingObserver?: ResizeObserver;
  private resizeRaf = 0;

  constructor(protected host: HTMLElement, opts: BaseEngineOptions) {
    this.curveTolerance = opts.curveTolerance ?? DEFAULT_CURVE_TOLERANCE;
    this.scene = new Scene(this.curveTolerance);
    const backend = opts.backend ?? "webgl";
    this.currentBackend = backend;
    // Backend canvases are positioned absolutely (see makeCanvas) so transiently-coexisting
    // canvases during an "auto" upgrade overlap instead of stacking in normal flow. An
    // absolute canvas anchors to its nearest positioned ancestor, so the host MUST be
    // positioned — otherwise the canvas would escape to some outer ancestor. The React
    // wrappers already set position:relative; for a bare-engine host that is still `static`,
    // promote it to `relative` (a no-op if the consumer already positioned it).
    if (typeof getComputedStyle === "function" && getComputedStyle(host).position === "static") {
      host.style.position = "relative";
    }
    const size = this.resolveSizing(opts);
    this.width = size.width;
    this.height = size.height;
    this.tooltipClass = opts.tooltipClass;
    if (backend === "auto") {
      // Instant canvas first paint; whenReady() resolves now. WebGL is built in the background.
      this.ready = Promise.resolve();
      this.enterAutoMode();
    } else {
      this.ready = this.swapBackend(backend);
    }
    if (this.responsive) this.installResizeObserver();
  }

  /**
   * Resolve the initial CSS size from the sizing spec and, in responsive modes, prepare the
   * host so its box reflects the engine size:
   * - fixed (both width & height, no aspectRatio): host styling untouched (pre-responsive behavior).
   * - width-driven (aspectRatio set): give the host a CSS `aspect-ratio` and let it fill the
   *   available width, then measure the resulting box.
   * - fill-parent (neither width nor height): measure the host box as laid out by your CSS.
   * getBoundingClientRect() forces a synchronous layout, so the just-applied styles are reflected.
   */
  private resolveSizing(s: EngineSizing): { width: number; height: number } {
    if (s.aspectRatio == null && s.width != null && s.height != null) {
      this.responsive = false;
      return { width: Math.round(s.width), height: Math.round(s.height) };
    }
    this.responsive = true;
    this.aspectRatio = s.aspectRatio;
    if (s.aspectRatio != null) {
      if (s.width != null) this.host.style.width = `${s.width}px`;
      else if (!this.host.style.width) this.host.style.width = "100%";
      this.host.style.aspectRatio = String(s.aspectRatio);
      this.host.style.height = ""; // height follows the aspect-ratio
    }
    const rect = this.host.getBoundingClientRect();
    const width = rect.width || s.width || DEFAULT_WIDTH;
    const height = s.aspectRatio != null
      ? width / s.aspectRatio
      : (rect.height || s.height || DEFAULT_HEIGHT);
    return { width: Math.round(width), height: Math.round(height) };
  }

  private installResizeObserver(): void {
    if (typeof ResizeObserver === "undefined") return;
    this.sizingObserver = new ResizeObserver(() => this.scheduleResize());
    this.sizingObserver.observe(this.host);
  }

  /** Coalesce a burst of ResizeObserver callbacks into a single setSize() per animation frame.
   *  The host box drives both axes (its CSS aspect-ratio sizes the height in width-driven mode),
   *  but height is recomputed from the ratio to avoid sub-pixel rounding drift. */
  private scheduleResize(): void {
    if (this.resizeRaf || this.destroyed) return;
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback): number => setTimeout(() => cb(0), 0) as unknown as number;
    this.resizeRaf = raf(() => {
      this.resizeRaf = 0;
      if (this.destroyed) return;
      const rect = this.host.getBoundingClientRect();
      const width = rect.width;
      const height = this.aspectRatio != null ? width / this.aspectRatio : rect.height;
      if (width > 0 && height > 0) this.setSize(width, height);
    });
  }

  /**
   * Resize the engine in place to a new CSS size (px) — no teardown. Resizes the live backend,
   * runs the subclass {@link onResize} hook (e.g. GeoMap refits its projection), then re-renders
   * and repaints pass-through layers. Layers, view transform, and interaction state are preserved.
   * A no-op when the size is unchanged or either axis is zero (a collapsed/hidden layout). In
   * responsive modes the ResizeObserver calls this automatically; callers in fixed mode use it
   * to apply a new explicit size without recreating the engine.
   */
  setSize(width: number, height: number): this {
    const w = Math.max(0, Math.round(width));
    const h = Math.max(0, Math.round(height));
    if (w === 0 || h === 0 || (w === this.width && h === this.height)) return this;
    const prevW = this.width;
    const prevH = this.height;
    this.width = w;
    this.height = h;
    this.handle?.backend.resize(w, h);
    this.onResize(prevW, prevH, w, h);
    this.render();
    this.repaintPassThrough();
    return this;
  }

  /** Subclass hook fired by setSize() after the backend resized but before the re-render.
   *  GeoMap overrides it to refit its projection into the new box. Default: no-op (Plot's
   *  world coords are size-independent). */
  protected onResize(_prevW: number, _prevH: number, _width: number, _height: number): void {}

  whenReady(): Promise<void> { return this.ready; }

  /**
   * Resolves when the active backend is fully settled, INCLUDING the `"auto"` → WebGL background
   * upgrade. `whenReady()` alone resolves at first paint (Canvas in `"auto"` mode); this method
   * additionally awaits the WebGL device so a WebGL-only feature (GPU layout) can safely use it.
   * On any non-`"auto"` backend this is equivalent to `whenReady()`.
   */
  protected async whenBackendSettled(): Promise<void> {
    await this.ready;
    if (this.upgradeDone) await this.upgradeDone;
  }
  /** Idempotent: addEventListener dedupes on the same handler reference. */
  private attachPointer(): void {
    this.host.addEventListener("pointermove", this.onPointerMove);
    this.host.addEventListener("pointerleave", this.onPointerLeave);
  }
  /** Attach pointer down/up/cancel for selection gestures (idempotent via same handler ref). */
  private attachSelectPointer(): void {
    this.host.addEventListener("pointerdown", this.onPointerDown);
    this.host.addEventListener("pointerup", this.onPointerUp);
    this.host.addEventListener("pointercancel", this.onPointerCancel);
  }
  /** The currently-active backend type (set by the constructor / installBackend). */
  protected backendType(): BackendType { return this.currentBackend; }
  /** The live backend instance, or null before the first swap resolves. */
  protected backend(): Backend | null { return this.handle?.backend ?? null; }

  /** Pull the declarative interaction options out of a layer-options object into the
   *  {@link LayerSpec} fields. Shared by `Plot.layer()`/`Plot.points()` and `GeoMap.layer()`
   *  so the hover/tooltip/selection contract lives in exactly one place. */
  protected interactionFields<D>(opts: InteractiveLayerOptions<D>): Pick<LayerSpec<D>, "selection" | "hover" | "tooltip" | "selectable"> {
    return { selection: opts.selection, hover: opts.hover, tooltip: opts.tooltip, selectable: opts.selectable };
  }

  /** Register (or replace) an instanced selection lane and emit it once if a backend is ready.
   *  The generic overload is the typed→erased seam: engines register with their concrete datum
   *  (`InstancedLaneEntry<D>`); the registry stores it datum-erased (the engine only threads a
   *  lane's datum back through its own `datumOf`/`options`, never inspecting it). */
  protected registerInstancedLane<D>(name: string, entry: InstancedLaneEntry<D>): void;
  protected registerInstancedLane(name: string, entry: InstancedLaneEntry): void {
    this.instancedLanes.set(name, entry);
    // An interactive lane needs the same pointer listeners as a Scene layer with these options
    // (idempotent — same handler ref). The pick path resolves the lane; dispatch reads its options.
    const opts = entry.interactive?.options;
    if (opts?.hover || opts?.tooltip) this.attachPointer();
    // selectable → click/marquee gestures; draggable → node-drag (#140). Both ride the down/up listeners.
    if (opts?.selectable || opts?.draggable) this.attachSelectPointer();
    if (this.handle?.backend.setInstancedLayer) this.emitInstancedLane(name);
  }

  /** Drop a lane and remove its instanced layers from the backend. */
  protected unregisterInstancedLane(name: string): void {
    const entry = this.instancedLanes.get(name);
    const backend = this.handle?.backend;
    if (entry && backend?.removeInstancedLayer) for (const n of entry.layerNames) backend.removeInstancedLayer(n);
    this.instancedLanes.delete(name);
  }

  /**
   * Re-select the lane at the live transform and push its layers.
   *
   * For each emitted layer: use `backend.updateInstancedLayer` (update-in-place, no GPU
   * teardown) when available; otherwise fall back to `setInstancedLayer` (destroy+recreate).
   * Layers that were in `entry.layerNames` but are NOT in this frame's emit (a layer that
   * disappears mid-session) are removed with `removeInstancedLayer`.
   */
  protected emitInstancedLane(name: string): void {
    const entry = this.instancedLanes.get(name);
    const backend = this.handle?.backend;
    if (!entry || !backend?.setInstancedLayer) return;

    const emitted = entry.lane.update(this.transform, this.width, this.height);
    const emittedNames = new Set<string>();
    for (const layer of emitted) emittedNames.add(layer.name);

    // The WebGL backend draws instanced layers in insertion order, so draw order == emit order.
    // Updating in place preserves each layer's slot — correct ONLY while the present-layer set is
    // unchanged (the per-frame zoom/pan case). When a layer appears or disappears (e.g. network
    // arrows toggling across an LOD cut), a reappearing layer would be appended last and drawn on
    // top of layers that should sit above it — so on ANY set change, clear this lane's layers and
    // re-add in emit order to re-establish the canonical z-order. (Set-stable ⇒ in-place, the
    // perf-critical path: zero teardown, no order drift.)
    const prev = this.laneEmittedNames.get(name);
    const sameSet = prev != null && prev.size === emittedNames.size && [...emittedNames].every((n) => prev.has(n));
    if (sameSet) {
      for (const layer of emitted) {
        if (backend.updateInstancedLayer) backend.updateInstancedLayer(layer);
        else backend.setInstancedLayer(layer);
      }
    } else {
      for (const n of entry.layerNames) backend.removeInstancedLayer?.(n);
      for (const layer of emitted) backend.setInstancedLayer(layer);
    }
    this.laneEmittedNames.set(name, emittedNames);
    this.onInstancedLaneEmitted(name); // re-apply shader-highlight uniforms a fresh setInstancedLayer reset (#162)
  }

  /** Selected ids for an instanced-lane layer (#105 N7c-2) — read by a lane's companion highlight
   *  strategy to draw the persistent selection ring. Empty/undefined ⇒ draw none. */
  protected selectedIds(layer: string): ReadonlySet<string | number> | undefined {
    return this.selected.get(layer);
  }
  /** Transient hover/manual-highlight ids for an instanced-lane layer (#105 N7c-2) — the hover ring. */
  protected hoveredIds(layer: string): ReadonlySet<string | number> | undefined {
    return this.laneHilite.get(layer);
  }
  /** Selected ids a live subtract-marquee currently covers (#140) — ringed red ("will be removed"). */
  protected removeIds(layer: string): ReadonlySet<string | number> | undefined {
    return this.laneRemove.get(layer);
  }
  /** Whether anything is currently highlighted on `layer` (selection or hover) — lets a lane's
   *  highlight strategy short-circuit to an empty visible set (O(1)) when nothing is shown. */
  protected hasHighlight(layer: string): boolean {
    return (this.selected.get(layer)?.size ?? 0) > 0 || (this.laneHilite.get(layer)?.size ?? 0) > 0;
  }

  /**
   * Resolved `selection.others` dim opacity for an instanced-lane layer (#162) — the lane analogue of
   * a Scene layer's `others` dimming, which lanes apply as a per-instance alpha multiply in their emit
   * (see `map/selection-dim.ts`). Returns the layer's `selection.others.opacity` (default `0.3`,
   * matching Scene `_applySelect`) when a selection is active on `layer`, else `null` (no dim — the
   * emit short-circuits). Lanes honor only the opacity component of `others`; a colour override there
   * is ignored on lanes. Hover does NOT dim (matching Scene, where only `select()` dims) — so this
   * keys off the persistent selection set alone. */
  protected othersDim(layer: string): number | null {
    if ((this.selected.get(layer)?.size ?? 0) === 0) return null;
    const others = this.laneInteractiveFor(layer)?.ix.options.selection?.others;
    const op = others === undefined ? 0.3 : others.opacity ?? 1;
    return op < 1 ? op : null;
  }

  /** Drop any managed selection + hover highlight for `layer` — e.g. when an engine disables that
   *  layer's interaction (so a stale selection can't survive as un-highlightable ghost state). */
  protected clearLayerSelection(layer: string): void {
    this.selected.delete(layer);
    this.laneHilite.delete(layer);
    if (this.laneHoverLayer === layer) this.laneHoverLayer = null;
  }

  /** Find the interactive lane that owns the dispatch layer `layer` (its `interactive.layer`), or null. */
  private laneInteractiveFor(layer: string): { name: string; entry: InstancedLaneEntry; ix: LaneInteractive } | null {
    for (const [name, entry] of this.instancedLanes) {
      if (entry.interactive?.layer === layer) return { name, entry, ix: entry.interactive };
    }
    return null;
  }

  /** Re-emit the companion highlight lane for an interactive layer after its selection/hover set
   *  changed — refreshes only the ring overlay (reuses the source lane's retained visible set; no
   *  base-buffer re-upload) and repaints. No-op when the layer isn't a (highlight-capable) lane.
   *  The repaint is essential: this runs at a STATIC transform (a click/hover, not a zoom), so unlike
   *  `setTransform` — which emits then renders — nothing else would draw the freshly-pushed ring. */
  private emitHighlightFor(layer: string): void {
    const found = this.laneInteractiveFor(layer);
    if (!found || !this.instancedLanes.has(found.ix.highlightLane)) return;
    this.emitInstancedLane(found.ix.highlightLane);
    this.render();
  }

  /** Re-emit BOTH an interactive lane's base layers and its highlight overlay — used when the
   *  **selection** set changes, so the base lane re-applies (or clears) `selection.others` dimming
   *  (#162) on its glyphs/links, not just the ring overlay. A hover-only change instead uses
   *  {@link emitHighlightFor} (ring overlay alone), which leaves the dimmed base untouched — keeping
   *  pointermove cheap. No-op when `layer` isn't an interactive lane. */
  private emitSelectionFor(layer: string): void {
    const found = this.laneInteractiveFor(layer);
    if (!found) return;
    this.emitInstancedLane(found.name); // base lane: re-applies/clears the per-instance others-dim
    if (this.instancedLanes.has(found.ix.highlightLane)) this.emitInstancedLane(found.ix.highlightLane);
    this.render();
  }

  /** Re-emit after the HOVER set changed: the ring overlay always; the base lane too when the lane sets
   *  {@link InstancedLaneEntry.hoverDirtiesBase} (#162) — network recolours the hovered node's existing
   *  links there. Cheaper than {@link emitSelectionFor} for lanes that don't style by hover (plot). */
  private emitHoverFor(layer: string): void {
    const found = this.laneInteractiveFor(layer);
    if (!found) return;
    if (found.entry.hoverDirtiesBase) this.emitInstancedLane(found.name);
    if (this.instancedLanes.has(found.ix.highlightLane)) this.emitInstancedLane(found.ix.highlightLane);
    this.render();
  }

  /** Hook: an interactive lane's HOVER set changed (#162). Default re-emits the ring overlay (+ the base
   *  lane if `hoverDirtiesBase`). An engine with shader-driven highlight (network) overrides this to set
   *  a uniform instead — so a hover on a full (LOD-off) draw costs no geometry rebuild. */
  protected onLaneHoverChanged(layer: string): void { this.emitHoverFor(layer); }
  /** Hook: an interactive lane's SELECTION set changed. Default re-emits base + ring. */
  protected onLaneSelectionChanged(layer: string): void { this.emitSelectionFor(layer); }
  /** Hook: called after an instanced lane's layers were (re)emitted (#162). Lets an engine re-apply
   *  shader-highlight uniforms that a fresh `setInstancedLayer` reset to defaults. Default no-op. */
  protected onInstancedLaneEmitted(_name: string): void {}

  /** Does any registered lane opt into hover/tooltip (`"hover"`) or click-select (`"selectable"`)?
   *  Lets the pointer-move/up handlers fire for lane-only engines (no Scene specs carry the option). */
  private anyLaneInteractive(kind: "hover" | "selectable"): boolean {
    for (const e of this.instancedLanes.values()) {
      const o = e.interactive?.options;
      if (!o) continue;
      if (kind === "selectable" ? !!o.selectable : (!!o.hover || !!o.tooltip)) return true;
    }
    return false;
  }

  /** Resolve a layer's selectability. An interactive lane takes precedence over a same-named Scene
   *  spec — on WebGL the network keeps empty placeholder specs ("nodes" etc.) that must not shadow
   *  the lane that actually draws + picks those glyphs. */
  private selectableOf(layer: string): { on: boolean; multi: boolean } {
    const ix = this.laneInteractiveFor(layer)?.ix;
    const sel = ix ? ix.options.selectable : this.specs.find((s) => s.name === layer)?.selectable;
    if (!sel) return { on: false, multi: false };
    return { on: true, multi: sel !== true && sel.multi === true };
  }

  /** Show the hover ring for one instanced-lane glyph (`id`), clearing the previous lane hover.
   *  `layer = null` clears any lane hover. Hover shows exactly one glyph at a time. */
  private setLaneHover(layer: string | null, id: string | number | null): void {
    if (this.laneHoverLayer && this.laneHoverLayer !== layer) {
      const prev = this.laneHoverLayer;
      this.laneHilite.delete(prev);
      this.onLaneHoverChanged(prev); // clear the previous layer's hover styling
    }
    this.laneHoverLayer = layer;
    if (!layer) return;
    const set = this.laneHilite.get(layer);
    if (id == null) {
      if (set?.size) { this.laneHilite.delete(layer); this.onLaneHoverChanged(layer); }
    } else if (!set || set.size !== 1 || !set.has(id)) {
      this.laneHilite.set(layer, new Set([id]));
      this.onLaneHoverChanged(layer);
    }
  }

  /** The source ids a Scene-layer glyph represents (#105 N7c-2): for a decluttered layer, itself plus
   *  the glyphs absorbed under it (from the declutter `winners`); otherwise `[id]`. Lazy — only on a
   *  `members()` call. Maps id → declutter group → absorbed groups → the drawable ids in those groups. */
  private sceneMembers(layer: string, id: string | number): (string | number)[] {
    const winners = this.declutterWinners.get(layer);
    const di = this.layerIds.get(layer)?.get(id);
    if (!winners || di == null) return [id];
    const { groupOf } = this.scene.declutterIndex(layer);
    const myGroup = groupOf[di];
    if (myGroup == null || myGroup < 0) return [id];
    const memberGroups = new Set<number>([myGroup]);
    for (let g = 0; g < winners.length; g++) if (winners[g] === myGroup) memberGroups.add(g);
    const drawables = this.scene.drawables(layer);
    const out: (string | number)[] = [];
    for (let d = 0; d < groupOf.length && d < drawables.length; d++) {
      if (memberGroups.has(groupOf[d]!)) out.push(drawables[d]!.id);
    }
    return out.length ? out : [id];
  }

  /** Register/replace a layer: build its Scene group, apply accessors, index, push.
   *  The generic overload is the typed→erased seam: engines construct a `LayerSpec<D>` with
   *  their concrete datum; storage is datum-erased (`LayerSpec<unknown>`) because the engine
   *  only ever pairs `spec.data[i]` with the same spec's accessors — it never inspects a datum. */
  protected registerLayer<D>(spec: LayerSpec<D>): void;
  protected registerLayer(spec: LayerSpec): void {
    if (spec.name.endsWith(HIGHLIGHT_SUFFIX)) throw new Error(`layer name suffix "${HIGHLIGHT_SUFFIX}" is reserved`);
    this.scene.group(spec.name, spec.build);
    this.applyAccessors(spec);
    this.reapplyOverrides(spec); // rebuilds (rotation/projection) keep overrides
    const at = this.specs.findIndex((s) => s.name === spec.name);
    if (at >= 0) this.specs[at] = spec;
    else this.specs.push(spec);
    // pickable:false skips the hit index entirely (no Entry-per-drawable) — for big
    // non-interactive layers. pick() simply can't return that layer (get()?.pick → skip).
    if (spec.pickable !== false) this.hitIndexes.set(spec.name, new HitIndex(this.scene.drawables(spec.name), 1, spec.sizeMode === "screen"));
    else this.hitIndexes.delete(spec.name);
    // Seed the incremental id map from the full (re)built spec (O(total) here, but a
    // register/rebuild is already O(total); appends then stay O(new)). Raw ids (no
    // String()) so numeric-id layers don't allocate a string per drawable.
    this.layerIds.set(spec.name, new Map(spec.ids.map((id, i) => [id, i])));
    // A rebuild (rotation/projection) re-projected the source geometry: rebuild the
    // overlay from the stored ids so the highlight tracks it. (A re-DECLARED layer had
    // its highlight dropped by dropInteractionState first.)
    const active = this.highlights.get(spec.name);
    if (active) this.buildHighlight(spec, active.ids, active.styleOrDraw);
    // Attach pointer listeners if this layer needs auto-hover or tooltip (idempotent via same ref).
    if (spec.hover || spec.tooltip) this.attachPointer();
    // Attach pointer down/up when the layer is selectable (idempotent via same ref).
    if (spec.selectable) this.attachSelectPointer();
    this.pushLayers();
  }

  /** Remove a Scene layer entirely: drop its spec, indexes, interaction state, and Scene group, then
   *  re-push (setLayers rebuilds from `specs`, so the layer is gone). Used when a points layer is
   *  promoted to the instanced lane (the lane owns draw + interaction; a stale Scene spec of the same
   *  name would otherwise double-draw and shadow the lane in pick/selection dispatch). No-op if absent. */
  protected removeLayer(name: string): void {
    const at = this.specs.findIndex((s) => s.name === name);
    if (at < 0) return;
    this.specs.splice(at, 1);
    this.hitIndexes.delete(name);
    this.layerIds.delete(name);
    this.dropInteractionState(name);
    this.scene.remove(name);
    this.pushLayers();
  }

  /** Register a pass-through layer (called by subclasses for passThrough:true).
   *  Always stores the spec so a not-ready registration is replayed on backend install.
   *  When a backend IS live: activate it if supported, else remove the spec + throw
   *  (an explicit unsupported backend, e.g. SVG). When no backend is live yet: defer.
   *  The generic overload is the typed→erased seam (see {@link registerLayer}). */
  protected registerPassThrough<D>(spec: PassThroughSpec<D>): void;
  protected registerPassThrough(spec: PassThroughSpec): void {
    this.ptSpecs.set(spec.name, spec);
    if (!this.handle) return; // not ready: keep the spec; install replay activates it
    if (!this.handle.backend.supportsPassThrough) {
      this.ptSpecs.delete(spec.name);
      throw new Error(
        `passThrough is not supported by the "${this.currentBackend}" backend (use the canvas or webgl backend)`,
      );
    }
    this.handle.backend.setPassThroughLayer?.({ name: spec.name, sizeMode: spec.sizeMode, clipTo: spec.clipTo });
    // Repaints the whole pass-through set, not just this layer: the shared accumulation surface
    // is cleared once per cycle, so the layers already on it must be redrawn with the new one (#110).
    this.repaintPassThrough();
  }

  /** Incremental draw: project just this batch and draw it on top (O(new)). */
  protected appendPassThrough(name: string, items: readonly unknown[]): void {
    const spec = this.ptSpecs.get(name);
    if (!spec || !this.handle) return;
    const batch = buildBatch(items, spec.buildItem);
    this.handle.backend.drawPassThrough?.(name, batch, "append");
  }

  /** Resolve the current data array for a pass-through layer. */
  private ptData(spec: PassThroughSpec): readonly unknown[] {
    return typeof spec.source === "function" ? spec.source() : spec.source;
  }

  /**
   * Full repaint of EVERY pass-through layer as ONE cycle, TIME-SLICED so a multi-million-item
   * fill never freezes the main thread: walk the layers in registration order, re-pulling each
   * one's data as its turn comes, and project + draw in PT_CHUNK-item slices across
   * requestAnimationFrame frames. The FIRST slice runs synchronously (so the caller sees the
   * result immediately); later slices are scheduled on rAF.
   *
   * **The clear is cycle-scoped, not layer-scoped (#110).** Exactly the first `drawPassThrough`
   * of a cycle uses `"replace-first"` — which clears the shared accumulation surface (WebGL: the
   * PT framebuffer; Canvas: the whole canvas, then redraws the retained base) — and every later
   * draw of the same cycle uses `"replace-rest"` (draw-on-top, no clear). That is what lets two
   * or more pass-through layers coexist on ONE shared surface with **no extra framebuffer**: they
   * accumulate into it in registration order. Per-layer repaint used to clear per layer, so
   * registering a second pass-through layer silently erased the first.
   *
   * The corollary is that a pass-through layer cannot be repainted alone: the shared surface has
   * no per-layer channel to erase, so any invalidation (`recolor()`, a re-registration, a resize,
   * a settle transform) repaints the whole set. That is O(sum of all pass-through layers' items)
   * — identical to today's cost while there is one layer, which is the streaming case. Appends
   * stay O(new) (they never clear; see {@link appendPassThrough}).
   *
   * Cancellable as a unit: each call captures a fresh {@link ptCycleToken}; a running slice loop
   * bails the moment that token changes — i.e. when a newer cycle starts, an interaction begins
   * (setInteracting bumps it), or the engine is destroyed.
   */
  protected repaintPassThrough(): void {
    if (!this.handle || this.ptSpecs.size === 0) return;
    const token = ++this.ptCycleToken;
    // Snapshot the layer ORDER once: the cycle's draw order (= z-order within the shared
    // surface) must not shift if a layer is registered mid-fill — that registration starts
    // its own cycle, which cancels this one via the token.
    const names = [...this.ptSpecs.keys()];
    let li = 0;                                  // index into `names`
    let cursor = 0;                              // item cursor within the current layer
    let data: readonly unknown[] | null = null;  // current layer's data, pulled when its turn starts
    let cleared = false;                         // has this cycle issued its one "replace-first" yet?
    const step = (): void => {
      // Cancelled by a newer cycle, an interaction, or a destroyed engine.
      if (token !== this.ptCycleToken || !this.handle) return;
      let drawn = 0;
      // One rAF frame draws at most PT_CHUNK items TOTAL across layers (not per layer), so the
      // frame budget is independent of how many pass-through layers are registered.
      while (li < names.length && drawn < BaseEngine.PT_CHUNK) {
        const name = names[li];
        const spec = name === undefined ? undefined : this.ptSpecs.get(name);
        if (name === undefined || !spec) { li++; cursor = 0; data = null; continue; } // removed mid-cycle
        data ??= this.ptData(spec);
        const end = Math.min(cursor + (BaseEngine.PT_CHUNK - drawn), data.length);
        // Whole-layer slice: hand the array straight through instead of copying it.
        const slice = cursor === 0 && end === data.length ? data : data.slice(cursor, end);
        const batch = buildBatch(slice, spec.buildItem);
        this.handle.backend.drawPassThrough?.(name, batch, cleared ? "replace-rest" : "replace-first");
        cleared = true;
        drawn += end - cursor;
        cursor = end;
        if (cursor >= data.length) { li++; cursor = 0; data = null; } // layer done → next layer
      }
      if (li < names.length) requestAnimationFrame(step);
    };
    step();
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
  protected appendToLayer(name: string, items: readonly unknown[], ids: readonly (string | number)[], build: (g: GroupBuilder) => void): void {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) throw new Error(`unknown layer: ${name}`);
    if (items.length === 0) return;
    // ids and items must stay parallel — a mismatch would desync spec.data/spec.ids
    // (which applyAccessors and pick index in lockstep).
    if (ids.length !== items.length) throw new Error(`appendToLayer: ids.length (${ids.length}) !== items.length (${items.length})`);
    // Validate against the PERSISTENT id set (O(new)); a from-scratch
    // `new Set(spec.ids…)` here would be O(total) every batch and make streaming
    // quadratic. Don't mutate the set until validation passes (keeps append atomic).
    const existing = this.layerIds.get(name) ?? new Map(spec.ids.map((id, i) => [id, i]));
    const seen = new Set<string | number>();
    for (const id of ids) {
      if (existing.has(id) || seen.has(id)) throw new Error(`duplicate drawable id: ${String(id)}`);
      seen.add(id);
    }
    const drawOffset = this.scene.drawableCount(name); // drawables, not data (culling may differ)
    const dataStart = spec.data.length;
    this.scene.appendToGroup(name, build);
    // NB: never `push(...items)` — spreading a large batch (the batch-size control goes
    // to 1M) exceeds the argument-count limit and throws RangeError. Loop instead.
    for (const it of items) spec.data.push(it);
    for (const id of ids) spec.ids.push(id);
    ids.forEach((id, j) => existing.set(id, dataStart + j)); // commit ids to the persistent map
    this.layerIds.set(name, existing);
    // Which appended ids actually produced a drawable (culling may drop some)?
    // (DrawableVector copies its color into a fresh tuple at read time, so we must
    //  color the scene FIRST, then read the drawables we hand to the hit index /
    //  backend — otherwise they'd carry the default transparent fill and not paint.)
    const present = new Set(this.scene.drawables(name, drawOffset).map((d) => d.id));
    this.applyAccessors(spec, dataStart, present);
    const newDrawables = this.scene.drawables(name, drawOffset); // O(new), colored
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
    // Pass-through layers aren't in `specs` (no retained Scene geometry); their color comes
    // from the data callback each repaint, so a repaint IS the recolor.
    // (Repaints the whole pass-through set — see {@link repaintPassThrough}: one shared surface.)
    if (this.ptSpecs.has(name)) { this.repaintPassThrough(); return this; }
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    this.applyAccessors(spec);
    this.reapplyOverrides(spec);
    this.pushStyles(spec); // styles-only: geometry can't have changed under a recolor
    return this;
  }

  /** Override the style of one drawable or a set (replaces any previous override for
   *  those ids — last write wins). O(ids) compose + one styles-only push. */
  setStyle(name: string, ids: string | number | readonly (string | number)[], override: StyleOverride): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    const list: readonly (string | number)[] = Array.isArray(ids) ? ids : [ids as string | number];
    let map = this.styleOverrides.get(name);
    if (!map) { map = new Map(); this.styleOverrides.set(name, map); }
    for (const id of list) map.set(id, override);
    this.restyle(spec, list);
    this.pushStyles(spec);
    return this;
  }

  /** Remove overrides (all of the layer's when `ids` is omitted) and restore base styles. */
  clearStyle(name: string, ids?: string | number | readonly (string | number)[]): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    const map = this.styleOverrides.get(name);
    if (!map || map.size === 0) return this;
    const list: readonly (string | number)[] =
      ids === undefined ? [...map.keys()] : Array.isArray(ids) ? ids : [ids as string | number];
    for (const id of list) map.delete(id);
    this.restyle(spec, list);
    this.pushStyles(spec);
    return this;
  }

  /**
   * Select a set of drawables: style members with the layer's `selection.selected`
   * (default: keep base style) and the complement with `selection.others` (default
   * `{ opacity: 0.3 }`). One O(n) compose + one styles-only push — click-time cost
   * only, nothing per frame. `null` clears. NOTE: selection rewrites the layer's
   * whole override map, so it replaces earlier setStyle overrides (one table, last
   * write wins) — and select(null) restores plain base styles.
   *
   * Also updates the managed selection set and fires `on("select")` with `ev = undefined`
   * (programmatic — no PointerEvent), so callers can observe programmatic selection the
   * same way they observe gesture selection.
   *
   * The predicate overload is generic over the layer's datum type `D` — annotate the
   * parameter (`(d: MyDatum) => …`) or pass `select<MyDatum>(…)` to get a typed datum,
   * mirroring d3-selection's caller-asserted datum generics. Prefer the layer handle's
   * {@link LayerHandle.select}, which already knows `D` from registration.
   */
  select(name: string, set: readonly (string | number)[] | null): this;
  select<D = unknown>(name: string, predicate: (d: D, i: number) => boolean): this;
  select(name: string, set: readonly (string | number)[] | ((d: unknown, i: number) => boolean) | null): this {
    // Lane-first: an interactive lane takes precedence over a same-named (empty placeholder) Scene spec.
    if (this.laneInteractiveFor(name)) {
      // Instanced lane: update the managed set + refresh the ring overlay (no Scene drawables to style).
      if (typeof set === "function") throw new Error(`select(${name}, fn): function selectors are Scene-layer only; pass an id array for instanced lanes`);
      if (set === null) this.selected.delete(name);
      else this.selected.set(name, new Set(set));
      this.onLaneSelectionChanged(name);
      this.selectCb?.(this.selection(), undefined);
      return this;
    }
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    // Resolve function selectors to an id set once (stored + used for styling).
    const resolved: Set<string | number> | null = set === null ? null
      : typeof set === "function"
        ? new Set(spec.ids.filter((_, i) => set(spec.data[i], i)))
        : new Set(set);
    // Update managed selection set (mirrors what the gesture does).
    if (resolved === null) this.selected.delete(name);
    else this.selected.set(name, resolved);
    // Apply styling.
    this._applySelect(name, resolved);
    // Fire the observer (ev undefined = programmatic).
    this.selectCb?.(this.selection(), undefined);
    return this;
  }

  /** Internal: apply selection styling for `name` given a resolved id set (or null to clear).
   *  Does NOT touch `this.selected` or fire `selectCb`. Used by both the public `select()`
   *  (which manages the set + fires the event) and `applySelectionStyles` (which reads
   *  `this.selected` and refreshes styling after a gesture). */
  private _applySelect(name: string, resolved: Set<string | number> | readonly (string | number)[] | null): void {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return;
    this.styleOverrides.delete(name);
    if (resolved !== null) {
      const members = resolved instanceof Set ? resolved : new Set(resolved);
      const selectedStyle = spec.selection?.selected;
      const others = spec.selection?.others ?? { opacity: 0.3 };
      const map = new Map<string | number, StyleOverride>();
      for (const id of spec.ids) {
        const o = members.has(id) ? selectedStyle : others;
        if (o) map.set(id, o);
      }
      this.styleOverrides.set(name, map);
    }
    this.restyle(spec, spec.ids);
    this.pushStyles(spec);
  }

  /**
   * Highlight one drawable / a set of drawables of `name` by drawing them into a tiny
   * internal overlay layer on top (inheriting the source's clipTo/sizeMode) — the base
   * layer's buffers are untouched, so the per-change cost is tessellating the
   * highlighted items only. `styleOrDraw` falls back to the layer's `hover` option,
   * then to the default white outline. `null` clears.
   *
   * The draw-fn overload is generic over the layer's datum type `D` (caller-asserted,
   * like {@link select}'s predicate) so a custom highlight draw sees a typed datum.
   */
  highlight(name: string, idOrIds: string | number | readonly (string | number)[] | null, style?: HighlightStyle): this;
  highlight<D = unknown>(name: string, idOrIds: string | number | readonly (string | number)[] | null, draw: HighlightDraw<D>): this;
  highlight(
    name: string,
    idOrIds: string | number | readonly (string | number)[] | null,
    styleOrDraw?: HighlightStyle | HighlightDraw,
  ): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    if (idOrIds == null) {
      if (!this.highlights.delete(name)) return this; // nothing shown: keep it a no-op
      this.buildHighlight(spec, []);
      this.pushHighlight(spec);
      return this;
    }
    const ids = Array.isArray(idOrIds) ? [...idOrIds] : [idOrIds as string | number];
    this.highlights.set(name, { ids, styleOrDraw });
    this.buildHighlight(spec, ids, styleOrDraw);
    this.pushHighlight(spec);
    return this;
  }

  /** (Re)build the overlay group for `spec` from already-projected Scene geometry. */
  private buildHighlight(spec: LayerSpec, ids: readonly (string | number)[], styleOrDraw?: HighlightStyle | HighlightDraw): void {
    const hlName = spec.name + HIGHLIGHT_SUFFIX;
    const colors: PendingColor[] = [];
    const index = this.layerIds.get(spec.name);
    this.scene.group(hlName, (g) => {
      for (const id of ids) {
        const d = this.scene.drawableOf(spec.name, id);
        if (!d) continue; // unknown or culled id: nothing to highlight
        const b = new HighlightBuilder(g, d, colors);
        const draw = resolveHighlight(styleOrDraw ?? hoverParts(spec.hover).hovered);
        const i = index?.get(id) ?? -1;
        draw(i >= 0 ? spec.data[i] : null, b);
      }
    });
    // Colors must wait for the group build to commit (Scene.setFill resolves the group).
    for (const c of colors) {
      if (c.fill) this.scene.setFill(hlName, c.id, c.fill);
      if (c.stroke) this.scene.setStroke(hlName, c.id, c.stroke);
    }
  }

  /** Push one overlay layer (tiny buffers — O(highlighted items), not O(layer)). */
  private pushHighlight(spec: LayerSpec): void {
    // A hidden-mid-gesture source isn't in the backend's layer set; its overlay would
    // float over nothing. The gesture-end pushLayers re-pushes overlays anyway.
    if (this.interacting && spec.hideOnInteraction) return;
    const backend = this.handle?.backend;
    if (!backend) return; // pre-install: installBackend pushes overlays with setLayers
    backend.updateLayer(spec.name + HIGHLIGHT_SUFFIX, this.overlayRenderLayer(spec));
    this.render();
  }

  private overlayRenderLayer(spec: LayerSpec): RenderLayer {
    const hlName = spec.name + HIGHLIGHT_SUFFIX;
    return { name: hlName, buffers: this.scene.buffers(hlName), drawables: this.scene.drawables(hlName), clipTo: spec.clipTo, sizeMode: spec.sizeMode };
  }

  /** Overlay layers to render after all user layers (skipping hidden-mid-gesture sources). */
  private overlayRenderLayers(): RenderLayer[] {
    const out: RenderLayer[] = [];
    for (const name of this.highlights.keys()) {
      const spec = this.specs.find((s) => s.name === name);
      if (!spec || (this.interacting && spec.hideOnInteraction)) continue;
      out.push(this.overlayRenderLayer(spec));
    }
    return out;
  }

  /** Everything the backend should draw: user layers in declaration order, then
   *  highlight overlays on top. */
  private allRenderLayers(): RenderLayer[] {
    return [...this.renderSpecs().map((s) => this.renderLayer(s)), ...this.overlayRenderLayers()];
  }

  /** Recompose + write the effective colors for `ids`: base accessor value with the
   *  current override (if any) applied. Ids without a drawable (culled) are skipped.
   *  When neither base nor override exists, composeColor returns null; we write
   *  "transparent" so clearing an override on a layer with no base fill accessor
   *  correctly restores the transparent default instead of leaving a stale color. */
  private restyle(spec: LayerSpec, ids: readonly (string | number)[]): void {
    const map = this.styleOverrides.get(spec.name);
    const index = this.layerIds.get(spec.name);
    for (const id of ids) {
      const i = index?.get(id);
      if (i === undefined || this.scene.drawableOf(spec.name, id) === null) continue;
      const o = map?.get(id) ?? {};
      const d = spec.data[i]!;
      const fill = composeColor(this.resolve(spec.fill, d, i), o.fill, o.opacity);
      this.scene.setFill(spec.name, id, fill ?? "transparent");
      const stroke = composeColor(this.resolve(spec.stroke, d, i), o.stroke, o.opacity);
      this.scene.setStroke(spec.name, id, stroke ?? "transparent");
    }
  }

  /** Re-write all of a layer's overrides (after applyAccessors reset the tables). */
  private reapplyOverrides(spec: LayerSpec): void {
    const map = this.styleOverrides.get(spec.name);
    if (map && map.size > 0) this.restyle(spec, [...map.keys()]);
  }

  /** Styles-only backend push (tables + refreshed vector views); falls back to a full
   *  updateLayer for backends without the fast path. Skips hidden-mid-gesture layers
   *  (the gesture-end rebuild re-pushes them). */
  private pushStyles(spec: LayerSpec): void {
    if (this.interacting && spec.hideOnInteraction) return;
    const backend = this.handle?.backend;
    if (!backend) return;
    if (backend.updateLayerStyles) {
      backend.updateLayerStyles(spec.name, this.scene.styleTables(spec.name), this.scene.drawables(spec.name));
    } else {
      backend.updateLayer(spec.name, this.renderLayer(spec));
    }
    this.render();
  }

  /** Forget per-layer interaction state (overrides, highlights). Called when a
   *  layer is RE-DECLARED (its ids may change) — not on a rebuild of the same data. */
  protected dropInteractionState(name: string): void {
    this.styleOverrides.delete(name);
    this.highlights.delete(name);
    this.selected.delete(name);
    this.declutterWinners.delete(name); // stale on a re-declare; cullDeclutter rebuilds next zoom
    // The hover tracking may point at this layer's now-dropped overlay; reset it so the
    // next pointermove re-evaluates instead of taking the same-target cheap exit (the
    // pointer often hasn't moved when a layer is re-declared on a data update).
    if (this.lastHover?.layer === name) this.lastHover = null;
    if (this.autoHover === name) this.autoHover = null;
    // A re-declared layer may carry new tooltip content; hide any stale tip immediately
    // rather than leaving it visible until the next pointer event (unbounded dwell time
    // on a stationary mouse when the layer is re-declared on a background data push).
    this.tooltipEl?.hide();
  }
  setClip(name: string, clipTo?: string): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    spec.clipTo = clipTo;
    this.pushLayers();
    return this;
  }
  /** True when `type` names the backend already live — so switching to it would be pure
   *  churn (recreate the same backend, re-push, re-render). Notably, once "auto" has
   *  upgraded to WebGL the live backend IS "webgl", so an explicit setBackend("webgl") is a
   *  no-op. Excludes "auto" (always an action) and the in-flight upgrade window (where the
   *  live "canvas" is about to become "webgl", so a pick must still take effect). */
  protected isCurrentBackend(type: BackendType): boolean {
    return type !== "auto" && type === this.currentBackend && !this.upgrading;
  }
  setBackend(type: BackendType): this {
    if (this.isCurrentBackend(type)) return this; // already live on this backend — no churn
    // An explicit pick supersedes any in-flight "auto" upgrade (the token bump below makes
    // installBackend tear the WebGL handle down), so nothing is provisional any more: clear the
    // placeholder state BEFORE the swap so the install's onBackendChanged re-emits at full detail
    // — otherwise an explicit setBackend("canvas") mid-upgrade would keep withholding geometry.
    this.upgrading = false;
    this.withheldFromPlaceholder = false;
    if (type === "auto") { this.ready = Promise.resolve(); this.enterAutoMode(); }
    else this.ready = this.swapBackend(type);
    return this;
  }
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
    if (v) this.clearHoverState(); // a drag/zoom hides hover artifacts immediately
    if (this.specs.some((s) => s.hideOnInteraction)) this.pushLayers();
    if (this.ptSpecs.size > 0) {
      if (v) {
        // Gesture start: cancel any in-flight time-sliced fill (bump the cycle token so a
        // running step() no-ops on its next frame) BEFORE snapshotting — otherwise a stale
        // slice could draw onto the canvas we're about to freeze for snapshot-pan.
        this.ptCycleToken++;
        // Capture the current accumulation so the backend can snapshot-pan.
        this.handle?.backend.snapshotPassThrough?.();
      } else {
        // Settle: re-pull + crisp redraw of every pass-through layer.
        // Known benign double-repaint: if a hideOnInteraction retained layer coexists with
        // a pass-through layer, pushLayers() above already started a repaint cycle (to restore
        // PT pixels after render() cleared them). The call here starts another — correct output;
        // the first cycle's remaining slices are simply cancelled by this second token bump. Do
        // NOT add a dedup guard: the pushLayers repaint is necessary in the general case
        // (retained-layer rebuild without settle).
        this.repaintPassThrough();
      }
    }
  }
  setTransform(t: ViewTransform): this {
    this.transform = t;
    // A PROGRAMMATIC view change (fit, zoomToModule, a centering translate) must carry d3-zoom's
    // internal transform with it. `enableZoom` seeds that transform once, at call time; without this
    // the next wheel/drag computes its delta from the stale seed and the view visibly snaps back
    // before zooming (#202). Skipped during a gesture — that setTransform came FROM d3-zoom and is
    // already in step, and re-seeding there would add a `behavior.transform` apply per zoom frame.
    // No-ops when zoom isn't enabled.
    if (!this.inZoomGesture) this.syncZoomToView();
    this.handle?.backend.setTransform(t);
    for (const [name, entry] of this.instancedLanes) if (entry.dynamic) this.emitInstancedLane(name);
    for (const spec of this.specs) if (spec.declutter) this.declutterLayer(spec, t);
    // Refresh view-tracking overlays/labels BEFORE the render, so a backend that draws labels into the
    // frame (Canvas `fillText`) paints the current labels in the SAME render — not one frame stale.
    // Runs after lanes re-emit, so a subclass can read a lane's freshly-cut `visible` set.
    this.afterTransform();
    this.render();
    // Pass-through layers. While interacting, the backend composites its accumulation
    // buffer with the live transform (snapshot-pan) — nothing to repaint here. On a
    // programmatic/settle transform, re-pull + crisp redraw every layer. The size check keeps
    // the zoom path of a retained-only chart free of even the call (#110 kept it deliberately).
    if (this.ptSpecs.size > 0 && !this.interacting) this.repaintPassThrough();
    return this;
  }

  /** Called by {@link setTransform} just before the render (zoom frame or programmatic), after lanes
   *  re-emit. Re-places the plot/geo data labels (#223); subclasses may override to re-place their own
   *  view-tracking overlays/labels — e.g. the network's frontier label layer (#105 N7b) — so a backend
   *  that bakes labels into the frame draws them now. */
  protected afterTransform(): void { this.refreshDataLabels(); }

  // ── Engine-owned labels (#105 N7b, #223) ─────────────────────────────────────────────────────
  // The overlay + placement/routing is shared by every engine; `network.labels()` builds its own
  // (LOD-frontier) anchors, while plot/geo build data-driven anchors here from d3-style accessors.

  /** Ensure the host is positioned and (re)create the label overlay with the resolved inline style,
   *  storing the backend-native text style used to route labels on SVG/Canvas (so they survive
   *  export). Styling lands once per element at creation — {@link routeLabels} adds no per-frame
   *  restyle. Shared by `network.labels()` and the plot/geo data-label API. */
  protected createLabelOverlay(
    className: string | undefined,
    style: LabelStyle | undefined,
    text: { font?: string; color?: string; halo?: { color: string; width: number } },
  ): void {
    if (typeof getComputedStyle === "function" && getComputedStyle(this.host).position === "static") {
      this.host.style.position = "relative";
    }
    this.labelLayer?.destroy();
    this.labelLayer = new LabelLayer(this.host, (a) => a.text, className, resolveLabelStyle(className, style));
    this.labelText = text;
  }

  /** Tear down the label overlay and clear any backend-native label set (including the WebGL
   *  export-only stash — the next export must not carry stale labels). */
  protected clearLabelOverlay(): void {
    this.labelLayer?.destroy();
    this.labelLayer = null;
    this.labelText = null;
    this.exportAnchors = [];
    this.backend()?.setTextLayer?.([]);
  }

  /**
   * Place + route a fully-built label anchor set to the active backend (#105 N7b-2). A backend that
   * draws text natively AND live (SVG `<text>` / Canvas `fillText`) renders the culled survivors —
   * so labels appear in `toSVG()`/`toPNG()`; otherwise — WebGL, whose `setTextLayer` is an
   * export-only stash ({@link Backend.textLayerMode}, #219) — the HTML overlay owns the screen and
   * the anchor set is retained (reference only, zero added per-frame work) so {@link toSVG}/
   * {@link toPNG} can feed the stash at export time. Project + cull is shared ({@link placeLabels})
   * so both paths place identically. Native text is positioned from the SAME box the culler used
   * ({@link toTextData}) — the anchor's own `textAnchor`/`baseline` — so the two never disagree.
   */
  protected routeLabels(anchors: readonly LabelAnchor[]): void {
    const layer = this.labelLayer;
    if (!layer) return;
    const viewport = { width: this.width, height: this.height };
    const backend = this.backend();
    if (backend?.setTextLayer && backend.textLayerMode !== "export-only") {
      const survivors = placeLabels(anchors, this.transform, viewport, this.labelCull);
      backend.setTextLayer(this.toTextData(survivors));
      layer.update([], this.transform, viewport); // keep the overlay empty on a native-text backend
    } else {
      layer.update(anchors, this.transform, viewport);
      // Retain the anchor set (reference only — the array was built above regardless) so an
      // export-only text backend can be fed the placed labels at toPNG()/toSVG() time (#219).
      // Nothing is placed or allocated here — zero added per-frame work.
      this.exportAnchors = anchors;
    }
  }

  /** Map placed label boxes to backend {@link TextData} — the one shape both the live native-text
   *  path (SVG/Canvas) and the export-only push (WebGL, #219) emit, so exports match across backends.
   *  Position and alignment come from the box's declared placement: `x` IS the anchor for the box's
   *  own `textAnchor` (start ⇒ left edge, middle ⇒ centre, end ⇒ right edge) and `y` is the box's
   *  vertical centre for the backends' "middle" baseline ({@link labelTextY}). */
  private toTextData(survivors: readonly LabelBox[]): TextData[] {
    const text = this.labelText;
    return survivors.map((b) => ({
      x: b.x,
      y: labelTextY(b),
      text: String(b.text),
      align: b.textAnchor ?? "start",
      font: text?.font,
      color: text?.color,
      halo: text?.halo,
      opacity: b.opacity as number | undefined,
    }));
  }

  /** Feed the placed labels to an export-only text backend (#219) right before an export, so a WebGL
   *  toPNG()/toSVG() includes what the HTML overlay shows — for network frontier labels AND plot/geo
   *  data labels (#223) alike. Runs ONLY at export time (O(anchors in view) once per call), never per
   *  frame; no-op on live-text backends (their set is already pushed). */
  private pushExportLabels(): void {
    const backend = this.backend();
    if (!backend?.setTextLayer || backend.textLayerMode !== "export-only") return;
    const active = this.labelLayer !== null;
    const survivors = active ? placeLabels(this.exportAnchors, this.transform, { width: this.width, height: this.height }, this.labelCull) : [];
    backend.setTextLayer(this.toTextData(survivors));
  }

  /**
   * Feed the instanced lanes' **vector view** to an export-only geometry backend (#200) right before
   * a `toSVG()`, so a WebGL export contains the glyphs the GPU lanes drew (network nodes/links, LOD
   * aggregates, decluttered plot points) instead of only the retained Scene — which on a lane-only
   * engine is empty, and produced the `<defs/><g/>` document the issue reports.
   *
   * Each lane is re-selected at the LIVE transform and its emit converted to drawables, so the export
   * is exactly the current view. Runs ONLY at export time — O(visible glyphs) once per call, never per
   * frame; no-op on Canvas/SVG (no `setExportLayers`, and those backends draw the same content as
   * retained Scene layers, so it is already in their export).
   */
  private pushExportGeometry(): void {
    const backend = this.backend();
    if (!backend?.setExportLayers) return;
    const layers: VectorLayer[] = [];
    for (const entry of this.instancedLanes.values()) {
      const emitted = entry.lane.update(this.transform, this.width, this.height);
      layers.push(...instancedVectorLayers(emitted, this.transform.k, this.curveTolerance));
    }
    backend.setExportLayers(layers);
  }

  /**
   * Set (or, with `false`, clear) engine-owned data labels for plot/geoMap (#223). Measures each
   * label's text ONCE here (never per frame), building a retained anchor set that {@link afterTransform}
   * re-places on every pan/zoom. Plain labels are vertically centred on the anchor+offset (the measured
   * height folds into the box); {@link DataLabelOptions.rotationOf} switches to the oriented model.
   * Re-call to rebuild after the underlying data/positions change. O(data) to build + measure (a
   * data-change/control cost, not per frame); measurement dedupes repeated label texts within the call.
   */
  protected setDataLabels<D>(data: readonly D[] | false, opts?: DataLabelOptions<D>): void {
    if (data === false || !opts) {
      this.dataLabels = null;
      this.clearLabelOverlay();
      this.render();
      return;
    }
    // Native-text (SVG/Canvas export) style — derived to match the overlay when explicit opts are
    // absent, so one `style` object styles both. Also the font used to MEASURE the label boxes.
    const font = canvasFont(opts.font ?? opts.style?.font ?? DEFAULT_LABEL_TEXT.font);
    const color = opts.color ?? opts.style?.color ?? DEFAULT_LABEL_TEXT.color;
    const halo = opts.halo ?? (opts.style?.textShadow === "none" ? undefined : DEFAULT_LABEL_TEXT.halo);
    this.createLabelOverlay(opts.className, opts.style, { font, color, halo });

    const offsetOf = typeof opts.offset === "function" ? opts.offset : (): [number, number] => (opts.offset as [number, number]) ?? [0, 0];
    const measured = new Map<string, { width: number; height: number }>(); // dedupe repeated texts (once each)
    const anchors: LabelAnchor[] = [];
    for (let i = 0; i < data.length; i++) {
      const d = data[i]!;
      const text = opts.labelOf(d, i);
      if (!text) continue; // no label for this datum
      const anchor = opts.anchorOf(d, i);
      if (!anchor) continue; // e.g. a geoMap point off the projected globe
      let box = measured.get(text);
      if (!box) { box = measureText(text, font); measured.set(text, box); }
      const rotation = opts.rotationOf?.(d, i);
      const [ox, oy] = offsetOf(d, i);
      // Plain labels: the box is top-left, so shift up by height/2 to sit centred on the anchor+offset.
      // Oriented labels: labelGeometry already centres vertically, so the offset is used as given.
      const offset: [number, number] = rotation === undefined ? [ox, oy - box.height / 2] : [ox, oy];
      anchors.push({
        id: i,
        refX: anchor[0],
        refY: anchor[1],
        text,
        width: box.width,
        height: box.height,
        priority: opts.importanceOf?.(d, i) ?? 0,
        offset,
        rotation,
        textAnchor: opts.textAnchor,
        keepUpright: opts.keepUpright,
      });
    }
    this.dataLabels = { anchors, max: opts.max ?? Infinity };
    this.refreshDataLabels();
    this.render(); // bake just-set labels into the frame (Canvas); no-op-ish for the live-DOM backends
  }

  /** Re-place the retained data labels at the current transform (#223). No-op when off. Default path
   *  (no `max`) passes the whole set straight to {@link routeLabels}, whose {@link placeLabels} already
   *  viewport-filters + culls collisions — so the only per-frame work is that O(anchors) project+cull,
   *  the same the raw `LabelLayer` did before (no regression; #204/#236's grid is the scale path). A
   *  finite `max` adds an O(anchors) in-view rank+cap first. */
  private refreshDataLabels(): void {
    const state = this.dataLabels;
    if (!state || !this.labelLayer) return;
    const all = state.anchors;
    if (all.length <= state.max) { this.routeLabels(all); return; }
    // Cap to the top-k by importance among the in-view candidates (screen-space filter).
    const { k, x, y } = this.transform;
    const W = this.width, H = this.height;
    const inView: LabelAnchor[] = [];
    for (const a of all) {
      const sx = k * a.refX + x + (a.offset?.[0] ?? 0);
      const sy = k * a.refY + y + (a.offset?.[1] ?? 0);
      if (sx >= 0 && sx <= W && sy >= 0 && sy <= H) inView.push(a);
    }
    inView.sort((p, q) => (q.priority ?? 0) - (p.priority ?? 0));
    this.routeLabels(inView.slice(0, state.max));
  }

  /**
   * Hide anchored glyphs that overlap in screen space, keeping earlier (e.g. larger-clade)
   * ones. Drawables sharing an exact anchor (a pie's wedges) are one unit. Runs on every
   * zoom/pan, so the whole pass is allocation-free and toggles visibility flags only (no
   * geometry rebuild).
   *
   * The anchor grouping is transform-independent and cached on the Scene (built once); only
   * the projection + binning below runs per frame. Binning uses a **flat** uniform grid (cell
   * size = radius) over the viewport plus a one-cell margin, indexed by a reused `Int32Array`
   * of cell heads with an intrusive linked list of kept points — no per-frame Map or bucket
   * allocation (the Map-based version was the dominant per-frame cost at high node counts).
   * Anchors projecting beyond the margin can't occlude (or be occluded by) anything on-screen,
   * so they're kept and skipped; a pan re-evaluates them next frame.
   */
  private declutterLayer(spec: LayerSpec, t: ViewTransform): void {
    if (!this.cullDeclutter(spec, t)) return; // wrote visibility flags into the Scene
    // Only visibility bits moved — colours and geometry did not. Preferred path (#208): hand
    // the backend the Scene's persistent typed flags view BY REFERENCE (zero copies, zero
    // per-frame allocation). WebGL rewrites only the flags texture (drawableCount bytes, not
    // the 9× of a full styleTables push); Canvas/SVG patch their retained vector views in
    // place instead of re-materializing a fresh drawables array. No render() here —
    // setTransform() renders right after the declutter loop.
    const backend = this.handle?.backend;
    if (!backend) return;
    if (backend.updateLayerFlags) {
      backend.updateLayerFlags(spec.name, this.scene.flagsView(spec.name));
    } else if (backend.updateLayerStyles) {
      // Fallback for backends without the flags-only entry point: full styles push.
      // The vector view (`drawables`) is what Canvas/SVG repaint from, but WebGL only stashes it
      // for `toSVG` export — `updateColors` drives the GPU from the flag table. So on a backend
      // that doesn't render from it, skip the (O(n)) materialization while interacting and let
      // the settle frame refresh the export snapshot. Saves a full drawables() build per frame.
      const needDrawables = backend.stylesNeedDrawables !== false || !this.interacting;
      backend.updateLayerStyles(
        spec.name,
        this.scene.styleTables(spec.name),
        needDrawables ? this.scene.drawables(spec.name) : undefined,
      );
    } else {
      backend.updateLayer(spec.name, this.renderLayer(spec));
    }
  }

  /**
   * Run the screen-space declutter cull and write the result into the Scene's visibility flags
   * (no backend push). Returns false when there's nothing to cull (radius off / no anchored
   * drawables). Called by {@link declutterLayer} on every zoom AND by {@link pushLayers} before
   * the initial upload, so the FIRST draw already reflects declutter (not just after the first
   * interaction).
   */
  private cullDeclutter(spec: LayerSpec, t: ViewTransform): boolean {
    const exclusion = spec.declutter!;
    if (!(exclusion > 0)) return false;
    const { ax, ay } = this.scene.declutterIndex(spec.name);
    const G = ax.length;
    if (G === 0) return false; // no anchored drawables ⇒ nothing to cull (all stay visible)

    // Reuse scratch across frames (declutter runs on every zoom). Project anchors to screen px, then
    // run the shared greedy declutter — the same engine the network LOD frontier uses (core/declutter).
    let sx = this.dcSx, sy = this.dcSy, vis = this.dcVisible;
    if (!sx || sx.length < G) {
      sx = this.dcSx = new Float64Array(G);
      sy = this.dcSy = new Float64Array(G);
      vis = this.dcVisible = new Uint8Array(G);
    }
    for (let i = 0; i < G; i++) {
      sx![i] = t.k * ax[i]! + t.x;
      sy![i] = t.k * ay[i]! + t.y;
    }
    // Per-layer `winners` (group → kept survivor) so a hit can enumerate the glyphs absorbed under
    // it (`members()`, #105 N7c-2). Reused per layer across zooms (allocated once per anchor count).
    let win = this.declutterWinners.get(spec.name);
    if (!win || win.length < G) { win = new Int32Array(G); this.declutterWinners.set(spec.name, win); }
    // `declutter` is the centre-to-centre exclusion distance, so the per-glyph radius is half of it
    // (two glyphs collide when dist < rᵢ + rⱼ = exclusion). Visited in index (data) order — the survivor
    // of a cluster is the earliest registered. Off-screen anchors are kept and don't occlude.
    declutterScreen(G, sx!, sy!, exclusion / 2, undefined, this.width, this.height, 1, vis!, this.dcScratch, undefined, win);
    this.scene.writeDeclutterFlags(spec.name, vis!);
    return true;
  }
  /**
   * Enable scroll-to-zoom / drag-to-pan via d3-zoom, clamped to `extent`. The optional
   * `onTransform` callback fires after each `setTransform` during zoom — use it to keep an
   * HTML overlay (e.g. a `LabelLayer`) aligned with the GPU geometry as the view changes.
   */
  enableZoom(extent: [number, number] = [1, 100], onTransform?: (t: ViewTransform) => void): this {
    this.disableInteraction();
    const sel = select<Element, unknown>(this.host);
    const behavior = d3zoom<Element, unknown>().scaleExtent(extent)
      // Reserve shift+drag for the marquee (#159) only when something is marquee-selectable — otherwise
      // keep d3-zoom's default (which pans on shift+drag). Shift+wheel still zooms (wheel is exempt).
      .filter((e: Event) => {
        const me = e as MouseEvent;
        if (me.shiftKey && e.type !== "wheel" && this.marqueeCapable()) return false;
        // A plain primary drag starting ON a draggable glyph is a node-drag (#140), not a pan — let
        // d3-zoom decline it so `onPointerDown` grabs the node. d3-zoom starts a pan on `mousedown`
        // (its registered event is `mousedown.zoom`, not pointerdown), so the hit-test must run there;
        // wheel/dblclick keep zooming. (onPointerDown re-resolves the hit to actually start the drag.)
        if ((e.type === "mousedown" || e.type === "pointerdown") && !me.shiftKey && !me.ctrlKey && !me.button && this.draggableAtEvent(me)) return false;
        return (!me.ctrlKey || e.type === "wheel") && !me.button;
      })
      .on("start", () => this.setInteracting(true))
      .on("zoom", (e: D3ZoomEvent<Element, unknown>) => {
        if (this.suppressZoomEmit) return; // a programmatic syncZoomToView() re-seed — don't recurse
        const t: ViewTransform = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        this.inZoomGesture = true;
        try {
          this.setTransform(t);
        } finally {
          this.inZoomGesture = false;
        }
        onTransform?.(t);
      })
      .on("end", () => this.setInteracting(false));
    sel.call(behavior);
    this.zoomSel = sel;
    this.zoomBehavior = behavior;
    // Seed d3-zoom's internal transform from the engine's CURRENT view so a non-identity base
    // (e.g. a centering translate set via setTransform before enableZoom) is respected, and
    // zoom-to-cursor deltas measure from it rather than from identity.
    const t = this.transform;
    sel.call(behavior.transform, zoomIdentity.translate(t.x, t.y).scale(t.k));
    this.interactionCleanup = () => { sel.on(".zoom", null); this.zoomSel = null; this.zoomBehavior = null; };
    return this;
  }

  /**
   * Re-seed the zoom gesture's internal transform to the engine's CURRENT view, without firing the
   * zoom handler. A programmatic view change made after {@link enableZoom} (e.g. fit-on-layout, which
   * reframes the camera each streamed layout frame) otherwise leaves d3-zoom's internal transform at
   * its seed value, so the next user gesture measures its delta from a stale base and jumps. Calling
   * this after such a change keeps the gesture continuous. No-op when zoom isn't enabled.
   */
  protected syncZoomToView(): void {
    const sel = this.zoomSel;
    const behavior = this.zoomBehavior;
    if (!sel || !behavior) return;
    const t = this.transform;
    this.suppressZoomEmit = true;
    sel.call(behavior.transform, zoomIdentity.translate(t.x, t.y).scale(t.k));
    this.suppressZoomEmit = false;
  }
  on(event: "hover" | "click", cb: (hit: HoverHit | null, ev: PointerEvent) => void): this;
  on(event: "select", cb: (selected: HoverHit[], ev?: PointerEvent) => void): this;
  on(event: "hover" | "click" | "select", cb: ((hit: HoverHit | null, ev: PointerEvent) => void) | ((selected: HoverHit[], ev?: PointerEvent) => void)): this {
    if (event === "hover") {
      this.hoverCb = cb as (hit: HoverHit | null, ev: PointerEvent) => void;
      this.attachPointer();
    } else if (event === "click") {
      this.clickCb = cb as (hit: HoverHit | null, ev: PointerEvent) => void;
      // Re-calling on("click") swaps the callback; the addEventListener calls below are
      // no-ops when the same handler refs are already registered — intentional.
      this.host.addEventListener("pointerdown", this.onPointerDown);
      this.host.addEventListener("pointerup", this.onPointerUp);
      this.host.addEventListener("pointercancel", this.onPointerCancel);
    } else if (event === "select") {
      // Pure observer — registering on("select") does NOT attach gesture listeners.
      // Gesture attachment happens in registerLayer when a layer has `selectable` set.
      this.selectCb = cb as (selected: HoverHit[], ev?: PointerEvent) => void;
    }
    return this;
  }
  pick(x: number, y: number, exact = true): HoverHit | null {
    // x,y are SCREEN (CSS px); the HitIndex applies the transform itself (per-mode: invert for
    // world layers, project-the-anchor for screen layers — so screen geometry picks at its
    // rendered pixel size at any zoom, not a hit area that scales with the view transform).
    // `exact` (#141): hover passes false → GPU link readback may use its stall-free async path
    // (previous-frame result); click/programmatic pick defaults true → synchronous, current pixel.
    const t = this.transform;
    // Instanced lanes (topmost = last registered) — resolved before Scene specs. Guarded on
    // size so the common empty-registry case (geoMap/plot, pick() per pointermove) allocates nothing.
    if (this.instancedLanes.size > 0) {
      const lanes = [...this.instancedLanes.values()];
      for (let i = lanes.length - 1; i >= 0; i--) {
        const idx = lanes[i]!.lane.pick(x, y, t);
        if (idx >= 0) {
          const hit = lanes[i]!.resolve(idx);
          if (hit) {
            const ix = lanes[i]!.interactive;
            if (ix) hit.members = () => ix.members(hit.id); // lazy: subtree leaves / absorbed set
            return hit;
          }
        }
      }
      // GPU-readback link picking (#141): the CPU lane.pick above resolves nodes (circles) — exact on
      // the screen-bounded frontier. Links are thin strips / half-arrows the CPU picker can't be exact
      // on, so a lane that opted in resolves them pixel-exactly over the drawn geometry via the backend
      // pick FBO. Runs only after every CPU node pick missed (nodes are drawn on top, so they win).
      const backend = this.handle?.backend;
      if (backend?.pickInstanced) {
        for (let i = lanes.length - 1; i >= 0; i--) {
          const gp = lanes[i]!.gpuPick;
          if (!gp) continue;
          const id = backend.pickInstanced(x, y, exact);
          if (id != null && id >= 0) {
            const hit = gp(id);
            if (hit) return hit;
          }
          break; // one pickable instanced lane backs the shared pick FBO (topmost wins); see #141 follow-up.
        }
      }
    }
    for (let i = this.specs.length - 1; i >= 0; i--) {
      const spec = this.specs[i]!;
      const id = this.hitIndexes.get(spec.name)?.pick(x, y, t);
      if (id == null) continue;
      // Visually clipped away ⇒ not a hit: with clipTo, the point must also fall on the
      // clip source's geometry. Skipped when the source has no hit index (pickable:false).
      if (spec.clipTo) {
        const clip = this.hitIndexes.get(spec.clipTo);
        if (clip && clip.pick(x, y, t) == null) continue;
      }
      const di = this.layerIds.get(spec.name)?.get(id) ?? -1;
      return { layer: spec.name, id, datum: di >= 0 ? spec.data[di] : null, members: () => this.sceneMembers(spec.name, id) };
    }
    return null;
  }
  render(): this {
    if (this.skipPlaceholderPaint()) return this; // #273: the throwaway "auto" placeholder stays blank at scale
    this.handle?.backend.render();
    return this;
  }
  // Exports feed the export-only stashes first: labels (#219) — a WebGL backend never draws them live
  // (the HTML overlay does) — and, for toSVG, the instanced lanes' vector view (#200), which has no
  // retained Scene to serialize. Both are pushed once at export time, never per frame. toPNG needs
  // only the labels: it is a GPU readback, so the lanes are already in the pixels.
  toSVG(): string { this.pushExportLabels(); this.pushExportGeometry(); return this.handle?.backend.toSVG() ?? ""; }
  toPNG(): string { this.pushExportLabels(); return this.handle?.backend.toPNG() ?? ""; }
  destroy(): void {
    this.destroyed = true;
    this.sizingObserver?.disconnect();
    this.sizingObserver = undefined;
    if (this.resizeRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.resizeRaf);
    this.resizeRaf = 0;
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
    this.host.removeEventListener("pointerdown", this.onPointerDown);
    this.host.removeEventListener("pointerup", this.onPointerUp);
    this.host.removeEventListener("pointercancel", this.onPointerCancel);
    this.endMarquee(); // drop any in-flight marquee overlay + its window listeners
    this.marqueeEl?.remove(); this.marqueeEl = null; // remove the reused overlay box + badge from the DOM
    this.marqueeBadge?.remove(); this.marqueeBadge = null;
    this.nodeDrag?.session?.end(); this.endNodeDrag(); // release a held drag + its window listeners (#140)
    this.tooltipEl?.destroy(); this.tooltipEl = null;
    this.labelLayer?.destroy(); this.labelLayer = null; // engine-owned label overlay (#105 N7b, #223)
    this.handle?.backend.destroy();
    if (this.handle && this.handle.element !== this.host) this.handle.element.remove();
    this.handle = null;
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.interacting || this.marquee || this.nodeDrag) return; // gesture / marquee / node-drag frames skip hover picking entirely
    if (!this.hoverCb && !this.specs.some((s) => s.hover || s.tooltip) && !this.anyLaneInteractive("hover")) return;
    const r = this.host.getBoundingClientRect();
    // Hover: exact=false lets GPU link picking (#141) use its stall-free async readback (the result may
    // lag the cursor by one pointer event — imperceptible — instead of flushing the GPU per move).
    const hit = this.pick(e.clientX - r.left, e.clientY - r.top, false);
    this.hoverCb?.(hit, e);
    if (hit?.layer !== this.lastHover?.layer || hit?.id !== this.lastHover?.id) {
      this.lastHover = hit;
      this.applyAutoHover(hit);
      this.updateTooltip(hit);
    }
    this.tooltipEl?.move(e.clientX - r.left, e.clientY - r.top);
  };

  /** Show the hover-option highlight for the picked drawable; clear the previous one.
   *  NOTE: if a manual highlight() was called on the same layer, the next pointermove
   *  that changes target will overwrite/clear it — the hover option owns that layer's overlay. */
  private applyAutoHover(hit: HoverHit | null): void {
    const layer = hit?.layer ?? null;
    // An interactive lane takes precedence over a same-named Scene spec (empty WebGL placeholders).
    const ix = layer ? this.laneInteractiveFor(layer)?.ix : undefined;
    const spec = layer && !ix ? this.specs.find((s) => s.name === layer) : undefined;
    // Scene-layer hover: redraw the hovered drawable into the tiny overlay layer.
    const sceneTarget = spec?.hover ? spec.name : null;
    if (this.autoHover && this.autoHover !== sceneTarget) this.highlight(this.autoHover, null);
    if (sceneTarget && hit) this.highlight(sceneTarget, hit.id);
    this.autoHover = sceneTarget;
    // Instanced-lane hover: drive the companion highlight ring.
    const laneTarget = ix?.options.hover ? layer : null;
    this.setLaneHover(laneTarget, laneTarget && hit ? hit.id : null);
  }

  /** Fill/show or hide the tooltip for the (changed) hover target. An interactive lane's tooltip
   *  takes precedence over a same-named Scene spec's. */
  private updateTooltip(hit: HoverHit | null): void {
    const ix = hit ? this.laneInteractiveFor(hit.layer)?.ix : undefined;
    const tip = ix ? ix.options.tooltip : hit ? this.specs.find((s) => s.name === hit.layer)?.tooltip : undefined;
    const content = tip && hit ? tip(hit.datum, hit.id) : null;
    if (content == null) { this.tooltipEl?.hide(); return; }
    (this.tooltipEl ??= new Tooltip(this.host, this.tooltipClass)).show(content);
  }

  private onPointerLeave = (e: PointerEvent): void => {
    this.hoverCb?.(null, e);
    this.clearHoverState();
  };

  /** Drop transient hover artifacts (auto-highlight; lane hover ring; tooltip). */
  private clearHoverState(): void {
    this.lastHover = null;
    if (this.autoHover) { this.highlight(this.autoHover, null); this.autoHover = null; }
    if (this.laneHoverLayer) this.setLaneHover(null, null);
    this.tooltipEl?.hide();
  }
  private onPointerDown = (e: PointerEvent): void => {
    this.downAt = [e.clientX, e.clientY];
    // shift+drag over a marquee-selectable lane starts a region selection instead of a pan (#159).
    if (e.shiftKey && this.marqueeCapable()) { this.startMarquee(e); return; }
    // A plain primary drag starting ON a draggable glyph grabs it (#140). The d3-zoom filter declined
    // the pan for the same condition; the actual pin/reheat is deferred to the first real move.
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey && e.button === 0) {
      const hit = this.draggableAtEvent(e);
      if (hit) this.startNodeDrag(hit, e);
    }
  };
  /** An interrupted gesture (e.g. setPointerCapture takeover, scroll) must not leave a stale
   *  down-position that would validate the next unrelated pointerup as a click. */
  private onPointerCancel = (): void => { this.downAt = null; this.endMarquee(); this.nodeDrag?.session?.end(); this.endNodeDrag(); };
  private onPointerUp = (e: PointerEvent): void => {
    const d = this.downAt;
    this.downAt = null;
    // A real node-drag (#140) ended here — not a click. The CLICK_SLOP test below alone misses a drag
    // that loops back to within slop of its start (the node still moved + reheated), so it would
    // double-fire a click-select; bail on the active session. (This host pointerup fires before the
    // window onNodeDragUp that clears the session.) A no-drag click leaves `session` null and proceeds.
    if (this.nodeDrag?.session) return;
    const hasSelectableLayer = this.specs.some((s) => s.selectable) || this.anyLaneInteractive("selectable");
    if (!d || (!this.clickCb && !hasSelectableLayer)) return;
    if (Math.hypot(e.clientX - d[0], e.clientY - d[1]) > BaseEngine.CLICK_SLOP) return;
    const r = this.host.getBoundingClientRect();
    const hit = this.pick(e.clientX - r.left, e.clientY - r.top);
    // on("click") fires first (raw escape hatch), then selection update for selectable layers.
    this.clickCb?.(hit, e);
    if (hasSelectableLayer) this.applySelectionGesture(hit, e);
  };

  // ── Node-drag (#140) ──────────────────────────────────────────────────────────────────────────
  /**
   * The draggable glyph under a pointer event (host CSS px), or null. Gates the d3-zoom pan filter
   * and the pointerdown grab. Default: never (no node-drag). `network()` overrides it to resolve the
   * node/aggregate under the cursor when `interactive({ draggable: true })` is set.
   */
  protected pickDraggable(_x: number, _y: number): HoverHit | null { return null; }
  /**
   * Begin dragging `hit`, grabbed at host CSS px (sx, sy). Return a {@link NodeDragSession} to drive,
   * or null to decline (→ no drag this gesture). Called once, when the pointer first travels past
   * {@link CLICK_SLOP} — so a plain click never reheats the layout. Default: declines (no node-drag).
   */
  protected beginNodeDrag(_hit: HoverHit, _sx: number, _sy: number): NodeDragSession | null { return null; }

  /** Resolve {@link pickDraggable} for a pointer event (converts viewport → host CSS px). */
  private draggableAtEvent(e: MouseEvent): HoverHit | null {
    const r = this.host.getBoundingClientRect();
    return this.pickDraggable(e.clientX - r.left, e.clientY - r.top);
  }
  /** Arm a node-drag: remember the grabbed hit + start point and listen on `window` so the drag
   *  survives the pointer leaving the host (like the marquee). The session — and the pin/reheat —
   *  is created lazily on the first real move (so a no-drag click never reheats). */
  private startNodeDrag(hit: HoverHit, e: PointerEvent): void {
    this.nodeDrag = { hit, startClientX: e.clientX, startClientY: e.clientY, session: null };
    window.addEventListener("pointermove", this.onNodeDragMove);
    window.addEventListener("pointerup", this.onNodeDragUp);
  }
  private onNodeDragMove = (e: PointerEvent): void => {
    const d = this.nodeDrag;
    if (!d) return;
    const r = this.host.getBoundingClientRect();
    if (!d.session) {
      // First real move: cross CLICK_SLOP before grabbing, so a click-with-jitter stays a click.
      if (Math.hypot(e.clientX - d.startClientX, e.clientY - d.startClientY) <= BaseEngine.CLICK_SLOP) return;
      d.session = this.beginNodeDrag(d.hit, d.startClientX - r.left, d.startClientY - r.top);
      if (!d.session) { this.endNodeDrag(); return; } // engine declined — leave the gesture be
    }
    d.session.move(e.clientX - r.left, e.clientY - r.top);
  };
  private onNodeDragUp = (): void => {
    this.nodeDrag?.session?.end();
    this.endNodeDrag();
  };
  /** Drop the window listeners + clear node-drag state. Idempotent. Does NOT call `session.end()`
   *  (the caller decides whether the drag completed or was cancelled). */
  private endNodeDrag(): void {
    if (!this.nodeDrag) return;
    window.removeEventListener("pointermove", this.onNodeDragMove);
    window.removeEventListener("pointerup", this.onNodeDragUp);
    this.nodeDrag = null;
  }

  // ── Marquee (shift+drag region) selection (#159) ──────────────────────────────────────────────
  /** Any registered lane that is **multi**-selectable — the prerequisite for a marquee (a box selecting
   *  many glyphs only makes sense on a multi-select lane). Gates both the d3-zoom shift filter and start. */
  private marqueeCapable(): boolean {
    for (const e of this.instancedLanes.values()) {
      const ix = e.interactive;
      if (ix && this.selectableOf(ix.layer).multi) return true;
    }
    return false;
  }
  /** Begin a marquee: track the viewport-space start and listen on `window` so the drag survives the
   *  pointer leaving the host. The overlay rect is created lazily on the first real move (so a shift+click
   *  never flashes a 0-size box). d3-zoom already declined this gesture (its filter rejects shift+drag). */
  private startMarquee(e: PointerEvent): void {
    this.endMarquee(); // defensive: never stack a new marquee over a stale (un-cleaned) one
    this.marquee = { startClientX: e.clientX, startClientY: e.clientY, shown: false };
    window.addEventListener("pointermove", this.onMarqueeMove);
    window.addEventListener("pointerup", this.onMarqueeUp);
    // Robust teardown on ANY interruption (#162): a ctrl-click context menu, a cancelled pointer, the
    // window losing focus, or Esc must each tear the marquee down — else its overlay box + mode badge
    // (and the live preview rings) leak, and a duplicate accumulates on the next gesture.
    window.addEventListener("pointercancel", this.onMarqueeAbort);
    window.addEventListener("contextmenu", this.onMarqueeAbort);
    window.addEventListener("blur", this.onMarqueeAbort);
    window.addEventListener("keydown", this.onMarqueeKey);
  }
  /** The reused marquee box + badge, created on first use and made visible. Returns both refs (no
   *  re-creation — one pair for the engine's lifetime), so the move handler stays non-null-safe. */
  private marqueeOverlay(): { el: HTMLElement; badge: HTMLElement } {
    const el = this.marqueeEl ?? (this.marqueeEl = makeOverlayDiv("d3gl-marquee", "border:1px dashed rgba(255,255,255,0.9);background:rgba(120,170,255,0.18)"));
    // Mode badge that follows the cursor: "+" (additive, default) or "−" (alt held → subtract), like Illustrator.
    const badge = this.marqueeBadge ?? (this.marqueeBadge = makeOverlayDiv("d3gl-marquee-badge", "width:14px;height:14px;line-height:13px;text-align:center;font:700 12px/13px ui-monospace,monospace;color:#fff;border-radius:3px;box-shadow:0 0 0 1px rgba(0,0,0,0.35)"));
    el.style.display = "block";
    badge.style.display = "block";
    return { el, badge };
  }
  private onMarqueeMove = (e: PointerEvent): void => {
    const m = this.marquee;
    if (!m) return;
    if (!m.shown) {
      if (Math.hypot(e.clientX - m.startClientX, e.clientY - m.startClientY) <= BaseEngine.CLICK_SLOP) return;
      m.shown = true;
    }
    const { el, badge } = this.marqueeOverlay();
    el.style.left = `${Math.min(m.startClientX, e.clientX)}px`;
    el.style.top = `${Math.min(m.startClientY, e.clientY)}px`;
    el.style.width = `${Math.abs(e.clientX - m.startClientX)}px`;
    el.style.height = `${Math.abs(e.clientY - m.startClientY)}px`;
    // Mode badge: "−" while alt/option is held (subtract), else "+" (add). Neutral gray in both modes (#162).
    const sub = e.altKey;
    badge.textContent = sub ? "−" : "+";
    badge.style.background = "#4b5563"; // neutral gray (#4b5563)
    badge.style.left = `${e.clientX + 10}px`;
    badge.style.top = `${e.clientY + 10}px`;
    // Live preview: ring the glyphs the box currently covers — blue "will-add", or (alt) red "will-remove".
    this.previewMarquee(this.marqueeRect(m.startClientX, m.startClientY, e.clientX, e.clientY), e.altKey);
  };
  private onMarqueeUp = (e: PointerEvent): void => {
    const m = this.marquee;
    if (!m) return;
    const box = m.shown && Math.hypot(e.clientX - m.startClientX, e.clientY - m.startClientY) > BaseEngine.CLICK_SLOP;
    const rect = this.marqueeRect(m.startClientX, m.startClientY, e.clientX, e.clientY);
    this.endMarquee(); // also clears the live preview rings
    // A real drag → region select; a no-drag shift+click is left to onPointerUp's click path.
    if (box) this.finalizeMarquee(rect, e);
  };
  /** Tear down on a non-commit interruption (#162): context menu / pointer cancel / window blur. */
  private onMarqueeAbort = (): void => { this.endMarquee(); };
  /** Esc cancels an in-flight marquee (no selection committed), like dismissing any drag gesture. */
  private onMarqueeKey = (e: KeyboardEvent): void => { if (e.key === "Escape") this.endMarquee(); };
  /** Remove all window listeners, HIDE (not remove) the reused overlay, drop the live preview rings, and
   *  clear marquee state. Idempotent — safe to call from any interruption and again on pointerup. */
  private endMarquee(): void {
    const m = this.marquee;
    if (!m) return;
    window.removeEventListener("pointermove", this.onMarqueeMove);
    window.removeEventListener("pointerup", this.onMarqueeUp);
    window.removeEventListener("pointercancel", this.onMarqueeAbort);
    window.removeEventListener("contextmenu", this.onMarqueeAbort);
    window.removeEventListener("blur", this.onMarqueeAbort);
    window.removeEventListener("keydown", this.onMarqueeKey);
    if (this.marqueeEl) this.marqueeEl.style.display = "none";
    if (this.marqueeBadge) this.marqueeBadge.style.display = "none";
    this.marquee = null;
    this.clearMarqueePreview();
  }
  /** Host-relative (CSS px) rect for a marquee from two viewport-space points, clamped to the canvas —
   *  the same screen space `pickRegion` projects into. */
  private marqueeRect(aClientX: number, aClientY: number, bClientX: number, bClientY: number): ScreenRect {
    const r = this.host.getBoundingClientRect();
    const cx = (v: number) => Math.max(0, Math.min(this.width, v - r.left));
    const cy = (v: number) => Math.max(0, Math.min(this.height, v - r.top));
    const ax = cx(aClientX), ay = cy(aClientY), bx = cx(bClientX), by = cy(bClientY);
    return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
  }
  /** For each multi-selectable lane, the ids whose centre is inside `rect` (resolved through the lane). */
  private marqueeIdsByLayer(rect: ScreenRect): Map<string, Set<string | number>> {
    const t = this.transform;
    const byLayer = new Map<string, Set<string | number>>();
    for (const entry of this.instancedLanes.values()) {
      const ix = entry.interactive;
      if (!ix || !this.selectableOf(ix.layer).multi) continue; // marquee = multi-select lanes only
      for (const idx of entry.lane.pickRegion(rect, t)) {
        const hit = entry.resolve(idx);
        if (!hit) continue;
        let set = byLayer.get(hit.layer);
        if (!set) byLayer.set(hit.layer, (set = new Set()));
        set.add(hit.id);
      }
    }
    return byLayer;
  }
  /** Live marquee preview, updated as the box grows. **Additive** (default): ring the box's glyphs with
   *  the hover ring (blue, "will add") via `laneHilite` — already-selected glyphs keep their own ring.
   *  **Subtract** (alt held): ring the box's *selected* glyphs red ("will remove") via `laneRemove` and
   *  show no blue (subtract adds nothing). Re-emits a lane's ring overlay only when its sets changed (a
   *  drag fires many moves). */
  private previewMarquee(rect: ScreenRect, subtract: boolean): void {
    const byLayer = this.marqueeIdsByLayer(rect);
    // Update layers in the box, and clear any previewed layer no longer in it.
    for (const layer of this.marqueePreview) if (!byLayer.has(layer)) byLayer.set(layer, new Set());
    // Treat undefined and empty as equal so an empty→empty pass doesn't re-emit.
    const same = (cur: ReadonlySet<string | number> | undefined, want: Set<string | number>) =>
      (cur?.size ?? 0) === 0 ? want.size === 0 : setsEqual(cur, want);
    for (const [layer, boxIds] of byLayer) {
      let hilite: Set<string | number>; // blue "will-add"
      let remove: Set<string | number>; // red "will-remove"
      if (subtract) {
        const sel = this.selected.get(layer);
        hilite = new Set();
        remove = sel ? new Set([...boxIds].filter((id) => sel.has(id))) : new Set();
      } else {
        hilite = boxIds;
        remove = new Set();
      }
      if (same(this.laneHilite.get(layer), hilite) && same(this.laneRemove.get(layer), remove)) continue;
      if (hilite.size) this.laneHilite.set(layer, hilite); else this.laneHilite.delete(layer);
      if (remove.size) this.laneRemove.set(layer, remove); else this.laneRemove.delete(layer);
      if (hilite.size || remove.size) this.marqueePreview.add(layer); else this.marqueePreview.delete(layer);
      this.emitHighlightFor(layer);
    }
  }
  /** Drop the live preview rings (on marquee end / cancel). */
  private clearMarqueePreview(): void {
    if (this.marqueePreview.size === 0) return;
    for (const layer of this.marqueePreview) { this.laneHilite.delete(layer); this.laneRemove.delete(layer); this.emitHighlightFor(layer); }
    this.marqueePreview.clear();
  }
  /** Apply a finished marquee box to the selection of every multi-selectable lane, then refresh styling
   *  and fire `on("select")`. Additive by default (like shift+click); with **alt/option** held it
   *  **subtracts** — removes the box's glyphs from the selection (the Illustrator gesture, #140 feedback). */
  private finalizeMarquee(rect: ScreenRect, e: PointerEvent): void {
    const subtract = e.altKey;
    const touched = new Set<string>();
    for (const [layer, ids] of this.marqueeIdsByLayer(rect)) {
      const set = this.getOrCreateLayerSet(layer);
      if (subtract) for (const id of ids) set.delete(id);
      else for (const id of ids) set.add(id);
      touched.add(layer);
    }
    if (touched.size === 0) return;
    this.applySelectionStyles(touched);
    this.selectCb?.(this.selection(), e);
  }
  /** Apply selection styling for layers listed in `touched`, reading the current id set from
   *  `this.selected`. Scene layers restyle their drawables (`selected`/`others`); instanced lanes
   *  refresh their companion ring overlay instead (no Scene drawables to recolor). */
  private applySelectionStyles(touched: Set<string>): void {
    for (const n of touched) {
      // Lane-first: an interactive lane restyles via its selection hook (shader uniforms / re-emit);
      // otherwise a Scene layer restyles.
      if (this.laneInteractiveFor(n)) {
        this.onLaneSelectionChanged(n);
      } else {
        const ids = this.selected.get(n);
        this._applySelect(n, ids && ids.size ? ids : null);
      }
    }
  }
  /** Apply click-driven selection gesture. Only processes hit layers that have `selectable` set;
   *  a plain click on a non-selectable layer (e.g. a hover-only layer) is ignored for selection.
   *  Plain click replaces; shift/cmd/ctrl on a multi-selectable layer toggles. */
  private applySelectionGesture(hit: HoverHit | null, ev: PointerEvent): void {
    const additive = ev.shiftKey || ev.metaKey || ev.ctrlKey;
    const touched = new Set<string>(); // layers whose styling must refresh

    if (!hit) {
      // Click on empty space: clear all selectable layers' selections.
      if (!additive) {
        for (const n of this.selected.keys()) touched.add(n);
        this.selected.clear();
      }
      // additive + null hit = no-op
    } else {
      // Check if the hit layer is selectable (Scene spec or instanced lane).
      const { on, multi: isMulti } = this.selectableOf(hit.layer);
      if (!on) return; // hit a non-selectable layer — no selection change
      if (!additive || !isMulti) {
        // Plain click (or additive on a single-select layer): replace whole selection with this hit
        for (const n of this.selected.keys()) touched.add(n);
        this.selected.clear();
        this.getOrCreateLayerSet(hit.layer).add(hit.id);
        touched.add(hit.layer);
      } else {
        // Additive on a multi-select layer: toggle this hit
        const set = this.getOrCreateLayerSet(hit.layer);
        if (set.has(hit.id)) set.delete(hit.id); else set.add(hit.id);
        touched.add(hit.layer);
      }
    }
    this.applySelectionStyles(touched);
    this.selectCb?.(this.selection(), ev);
  }
  /** Get (or create) the per-layer id set. */
  private getOrCreateLayerSet(layer: string): Set<string | number> {
    let set = this.selected.get(layer);
    if (!set) { set = new Set(); this.selected.set(layer, set); }
    return set;
  }
  /** Flatten the retained selection into HoverHit[], resolving datums + `members()` via the layer's
   *  Scene spec or its interactive lane (so a selected aggregate's leaf ids are reachable, #105 N7c-2). */
  selection(): HoverHit[] {
    const out: HoverHit[] = [];
    for (const [layer, ids] of this.selected) {
      // Lane-first: an interactive lane resolves datum + members; otherwise the Scene spec does.
      const ix = this.laneInteractiveFor(layer)?.ix;
      if (ix) {
        for (const id of ids) out.push({ layer, id, datum: ix.datumOf(id), members: () => ix.members(id) });
      } else {
        const spec = this.specs.find((s) => s.name === layer);
        const index = this.layerIds.get(layer);
        for (const id of ids) {
          const di = index?.get(id) ?? -1;
          out.push({ layer, id, datum: di >= 0 && spec ? spec.data[di] : null, members: () => this.sceneMembers(layer, id) });
        }
      }
    }
    return out;
  }
  /** Resolve a color accessor for one datum. Color-valued only (`string`), so the
   *  constant/function union discriminates by `typeof` with no cast. */
  private resolve(a: Accessor<unknown, string> | undefined, d: unknown, i: number): string | undefined {
    return typeof a === "function" ? a(d, i) : a;
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
    // Apply declutter to the Scene flags BEFORE the upload, so the first draw is already
    // decluttered (setTransform's per-zoom pass otherwise wouldn't run until the first gesture).
    // Runs even when the push below is withheld: the flags are Scene state the incoming WebGL
    // backend reads too, so skipping them would only move identical work later (the #201 rule).
    for (const spec of this.specs) if (spec.declutter) this.cullDeclutter(spec, this.transform);
    // #273: a large scene is not worth pushing to `"auto"`'s throwaway placeholder canvas —
    // `allRenderLayers()` alone materializes one DrawableVector per drawable, and the paint that
    // follows is discarded by the WebGL install ~100-200 ms later.
    if (this.skipPlaceholderPaint()) return;
    this.handle?.backend.setLayers(this.allRenderLayers());
    this.handle?.backend.setTransform(this.transform);
    this.render();
    // render() above clears the canvas and redraws ONLY the retained layers — it has no
    // pass-through point data, so any pass-through pixels are wiped. Repaint the PT layers
    // back on top. repaintPassThrough() no-ops when there are none, so retained-only maps keep
    // their zero-overhead path (and no recursion: repaintPassThrough →
    // backend.drawPassThrough("replace-first") calls backend.render() directly, never back
    // through pushLayers).
    this.repaintPassThrough();
  }
  /**
   * Post-swap hook: called after a backend SWAP completes (an existing handle was
   * replaced) — NOT on the first install. Subclasses override to react to a change of
   * the live backend (e.g. re-evaluate GPU-globe eligibility and re-dispatch interaction).
   * Default: no-op.
   */
  protected onBackendSwapped(): void {}

  /**
   * Backend-changed hook: called after EVERY backend install (first install AND swaps),
   * after setLayers/setTransform/passThrough-repaint, but before the blanket instanced-lane
   * re-emit. Subclasses override to re-evaluate which layers should be lane vs. Scene paths
   * (e.g. Plot re-syncs points() layers so canvas→WebGL upgrades promote eligible layers to
   * the instanced lane). Default: no-op.
   */
  protected onBackendChanged(): void {}

  /**
   * Install `next` as the live backend (shared by swapBackend and the "auto" upgrade).
   * Honors the swap-supersede / destroyed guards. Destroys + detaches the previous
   * handle, pushes the current specs + transform, renders, and — only if it REPLACED an
   * existing handle — fires onBackendSwapped(). The first install (old === null) does NOT
   * notify, so it is safe to call synchronously during construction (before a subclass has
   * finished initializing its own fields, e.g. GeoMap's projection).
   */
  private installBackend(next: BackendHandle, token: number, type: BackendType): void {
    // A newer swap superseded this one, or the engine was destroyed mid-flight: tear down
    // the freshly created backend so it never orphans an element.
    if (token !== this.swapToken || this.destroyed) {
      next.backend.destroy();
      if (next.element !== this.host) next.element.remove();
      return;
    }
    const old = this.handle;
    // Keep the rendering surface at the OLD surface's DOM position instead of at the end of
    // the host, where makeCanvas() appended the new canvas. This makes the canvas a stable
    // base layer: anything the caller appended to the host AFTER it (e.g. an HTML stats
    // overlay) keeps painting on top across a backend swap, with no z-index needed. SVG draws
    // into the host itself (element === host), so there is no child surface to reposition.
    if (
      old &&
      old.element !== this.host &&
      next.element !== this.host &&
      old.element.parentNode === this.host &&
      next.element.parentNode === this.host
    ) {
      this.host.insertBefore(next.element, old.element);
    }
    old?.backend.destroy();
    if (old && old.element !== this.host) old.element.remove();
    this.handle = next;
    this.currentBackend = type;
    // #273: the same withhold as pushLayers(), for the install that CREATES the placeholder —
    // `setBackend("auto")` on an engine that already carries a large scene. The placeholder is
    // left correctly sized but blank; the WebGL install right after runs this with
    // `currentBackend === "webgl"`, so the real first paint is never skipped. `setTransform` runs
    // either way (O(1), and it keeps the surface correctly framed), in its original position.
    const paint = !this.skipPlaceholderPaint();
    if (paint) next.backend.setLayers(this.allRenderLayers());
    next.backend.setTransform(this.transform);
    if (paint) next.backend.render();
    // Replay retained pass-through layers onto the freshly-installed backend (mirrors the
    // retained setLayers re-push above). A deferred/not-ready registration is activated here.
    if (this.ptSpecs.size > 0) {
      if (!next.backend.supportsPassThrough) {
        throw new Error(
          `passThrough is not supported by the "${type}" backend (use the canvas or webgl backend)`,
        );
      }
      // Register every layer FIRST, then repaint them as one cycle — the cycle clears the new
      // backend's accumulation surface once and draws all layers into it in order (#110).
      for (const spec of this.ptSpecs.values())
        next.backend.setPassThroughLayer?.({ name: spec.name, sizeMode: spec.sizeMode, clipTo: spec.clipTo });
      this.repaintPassThrough();
    }
    if (old) this.onBackendSwapped();
    // Notify subclasses that the backend changed (both first-install and swaps), then
    // re-emit all registered instanced lanes for the new backend. onBackendChanged() runs
    // first so a subclass can register/unregister lanes before the blanket re-emit here.
    this.onBackendChanged();
    if (this.handle?.backend.setInstancedLayer) {
      for (const name of [...this.instancedLanes.keys()]) this.emitInstancedLane(name);
    }
  }

  private async swapBackend(type: BackendType): Promise<void> {
    const token = ++this.swapToken;
    const next = await createBackend(type, this.host, this.width, this.height);
    this.installBackend(next, token, type);
  }

  /** Thin override point so tests can stub the WebGL creation without fighting ESM live bindings. */
  protected createWebGLBackend(): Promise<BackendHandle> {
    return createBackend("webgl", this.host, this.width, this.height);
  }

  /**
   * How many elements the **placeholder** Canvas backend of `"auto"` mode may draw while the
   * WebGL upgrade is in flight (see {@link skipPlaceholderEmit}). An "element" is one thing the
   * engine would have to tessellate into the retained Scene *only* for that placeholder — a
   * network node/link, a decluttered plot point — NOT geometry the WebGL backend also renders.
   *
   * Calibrated in #201 against the cost the placeholder is covering for: creating the WebGL
   * device and emitting a 611k-edge network through the instanced lane takes ~135 ms end to end
   * (headless Chromium), while the Canvas2D full-detail path costs ~13 µs per network edge per
   * rebuild (measured 5k→100k edges: 150→4173 ms over three rebuilds). So ~10k elements is the
   * break-even: below it the placeholder paints in ≲100 ms and genuinely beats waiting for
   * WebGL; above it, it costs strictly more than the upgrade it is bridging.
   *
   * Module-internal (no public API); tests stub it via the static field, as with {@link PT_CHUNK}.
   */
  protected static AUTO_PLACEHOLDER_MAX_ELEMENTS = 10_000;

  /**
   * Should an engine withhold `elements` worth of retained-Scene geometry from the live backend?
   *
   * True only while `"auto"` mode's **placeholder** Canvas backend is live and a WebGL upgrade is
   * in flight, for a count above {@link AUTO_PLACEHOLDER_MAX_ELEMENTS}. Callers are the two places
   * that materialize Scene geometry *purely because the live backend has no instanced lane* — the
   * network's full-graph/frontier Scene and Plot's decluttered points fallback. That geometry is
   * discarded by the very next backend install, so at scale emitting it is pure waste: a 611k-edge
   * graph blocks the main thread for ~9.5 s (#201) painting a canvas that is replaced ~1 s later.
   *
   * NOT a general "skip drawing" switch: geometry the WebGL backend renders too (every `geoMap`
   * layer, `plot.layer()`, non-decluttered points) must still be built — withholding it would only
   * move the same work later. Small inputs keep `"auto"`'s instant canvas first paint untouched.
   */
  protected skipPlaceholderEmit(elements: number): boolean {
    if (!this.upgrading || elements <= BaseEngine.AUTO_PLACEHOLDER_MAX_ELEMENTS) return false;
    this.withheldFromPlaceholder = true;
    return true;
  }

  /**
   * The PAINT half of {@link skipPlaceholderEmit} (#273) — should the live backend be left blank?
   *
   * `skipPlaceholderEmit` withholds Scene geometry that exists *only* for a vector backend. This
   * one covers the geometry WebGL renders too — every `geoMap` layer, `plot.layer()`, every
   * non-decluttered `points()` layer. That geometry must still be BUILT (withholding it would only
   * move identical work later), but pushing and painting it on `"auto"`'s placeholder canvas is
   * pure waste: `allRenderLayers()` materializes one `DrawableVector` per drawable and
   * `CanvasBackend.render()` then runs `drawShapes` over all of them, ~0.7 µs each, for a frame the
   * WebGL install discards ~100-200 ms later. Above {@link AUTO_PLACEHOLDER_MAX_ELEMENTS} the
   * placeholder is therefore left correctly sized but EMPTY. Nothing about page layout depends on
   * it — backend canvases are `position:absolute` (out of flow, see `backend-factory.makeCanvas`),
   * so the host box comes from the consumer's CSS and never moves.
   *
   * Reuses the one budget deliberately: a second, painting-specific threshold would be a knob
   * nobody can calibrate, and 10k drawables paint in ≲10 ms either way.
   *
   * Cost on the hot path: ONE boolean field read (`upgrading` is false except during the upgrade
   * window), so `render()` — which runs per zoom frame — is unchanged in practice. Inside the
   * window it is O(layers) (≈1-10), each term an O(1) `Scene.drawableCount`; it never touches the
   * O(total-drawables) `Scene.drawables()` materialization.
   *
   * `currentBackend !== "canvas"` is load-bearing: `installBackend` assigns `currentBackend` before
   * it paints, and it runs for the WebGL handle while `upgrading` is still true — without this the
   * upgrade's own first frame would be skipped. An explicit `setBackend()` mid-upgrade is safe for
   * the same reason it is safe for `skipPlaceholderEmit`: it clears `upgrading` before swapping.
   */
  private skipPlaceholderPaint(): boolean {
    if (!this.upgrading || this.currentBackend !== "canvas") return false;
    let elements = 0;
    for (const spec of this.specs) {
      if (this.interacting && spec.hideOnInteraction) continue; // mirrors renderSpecs(), without its allocation
      elements += this.scene.drawableCount(spec.name);
    }
    return this.skipPlaceholderEmit(elements);
  }

  /** Enter "auto" mode: install a Canvas backend synchronously (instant first paint, no
   *  await, no onBackendSwapped — it is the first install / a fresh canvas), then start the
   *  background WebGL upgrade. Bumping swapToken invalidates any in-flight prior swap.
   *
   *  `upgrading` is raised BEFORE the install (rather than only inside {@link upgradeToWebGL})
   *  so the install itself already sees the canvas as a placeholder. That only matters for
   *  `setBackend("auto")` on an engine that already holds a scene — from the constructor there
   *  are no layers yet. */
  private enterAutoMode(): void {
    this.upgrading = true;
    const handle = createCanvasBackend(this.host, this.width, this.height);
    this.installBackend(handle, ++this.swapToken, "canvas");
    this.upgradeDone = this.upgradeToWebGL();
  }

  /** Background upgrade: create the WebGL device, then swap it in via installBackend (which
   *  destroys the canvas handle and fires onBackendSwapped, since it replaces a live handle).
   *  On failure, keep the canvas and warn — the map keeps working. While in flight, `upgrading`
   *  is true so a same-type setBackend isn't treated as a no-op (a "canvas" pick during the
   *  window must still cancel the upgrade via the normal swap's token bump) AND so engines treat
   *  the live canvas as a placeholder ({@link skipPlaceholderEmit}).
   *
   *  If the upgrade never installs WebGL while something WAS withheld, the placeholder turns out
   *  to be the final backend — so re-install canvas through the normal swap. That fires
   *  onBackendSwapped/onBackendChanged with `upgrading` already false, which is exactly the
   *  notification every engine uses to re-emit, now at full detail. */
  private async upgradeToWebGL(): Promise<void> {
    this.upgrading = true;
    let installed = false;
    try {
      installed = await this.createAndInstallWebGL();
    } finally {
      this.upgrading = false;
    }
    if (installed || !this.withheldFromPlaceholder || this.destroyed) return;
    this.withheldFromPlaceholder = false;
    this.ready = this.swapBackend("canvas");
    await this.ready;
  }

  /** The upgrade's create+install step. Returns whether the WebGL handle actually became live
   *  (false when creation failed, the target can't do pass-through, or the swap was superseded). */
  private async createAndInstallWebGL(): Promise<boolean> {
    const token = ++this.swapToken;
    let next: BackendHandle;
    try {
      next = await this.createWebGLBackend();
    } catch (err) {
      if (!this.destroyed) console.warn("d3gl: WebGL upgrade failed, staying on canvas", err);
      return false;
    }
    // Defensive guard for any upgrade target that lacks pass-through support. (The real WebGL
    // backend DOES support pass-through, so this no longer fires for it — but a future/headless
    // backend might not.) If pass-through layers exist and the target can't render them, aborting
    // the transparent auto-upgrade is the only safe move — installBackend would destroy the canvas
    // handle (losing the pass-through raster) and then THROW at its unsupported-backend check.
    // Tear down the just-created handle (mirroring the createWebGLBackend failure path), keep the
    // live canvas + currentBackend untouched, and warn. (An EXPLICIT setBackend to an unsupported
    // backend still throws via installBackend — only this silent upgrade stays on canvas.)
    if (this.ptSpecs.size > 0 && !next.backend.supportsPassThrough) {
      next.backend.destroy();
      if (next.element !== this.host) next.element.remove();
      if (!this.destroyed)
        console.warn("d3gl: pass-through layers kept on the canvas backend (the upgrade target does not support pass-through)");
      return false;
    }
    this.installBackend(next, token, "webgl");
    return this.handle === next;
  }
}

/** Same-membership test for the marquee-preview change guard (avoids re-emitting an unchanged ring set). */
function setsEqual(a: ReadonlySet<string | number> | undefined, b: ReadonlySet<string | number>): boolean {
  if (!a || a.size !== b.size) return false;
  for (const v of b) if (!a.has(v)) return false;
  return true;
}

/** A fixed, click-through overlay `div` appended to `document.body` — the marquee box / mode badge (#159). */
function makeOverlayDiv(className: string, extraCss: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  el.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;${extraCss}`;
  document.body.appendChild(el);
  return el;
}
