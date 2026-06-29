import { select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type D3ZoomEvent } from "d3-zoom";
import { Scene, HitIndex, declutterScreen, declutterScratch, type Backend, type GroupBuilder, type RenderLayer, type ViewTransform, type DeclutterScratch } from "../core/index.js";
import { InstancedLane, type ScreenRect } from "../core/instanced-lane.js";
import { createBackend, createCanvasBackend, type BackendType, type BackendHandle } from "./backend-factory.js";
import { buildBatch, type DrawItem } from "./draw-batch.js";
import { composeColor, type StyleOverride, type SelectionOptions } from "./style-overrides.js";
import { HighlightBuilder, resolveHighlight, HIGHLIGHT_SUFFIX, type HighlightStyle, type HighlightDraw, type HoverOption, type PendingColor } from "./highlight.js";
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

/** A registered instanced selection lane (#108-B). BaseEngine drives its re-emit + resolves its picks. */
export interface InstancedLaneEntry {
  lane: InstancedLane;
  /** The instanced layer names this lane emits — cleared then re-added in this order each emit (draw order). */
  layerNames: readonly string[];
  /** Re-select + re-emit on every setTransform (zoom-dependent: LOD cut / declutter). Static lanes emit once at register. */
  dynamic: boolean;
  /** Map a picked source index (from `lane.pick`) to a HoverHit for hover/click dispatch; null = treat as a miss. */
  resolve(index: number): HoverHit | null;
  /**
   * Opt this lane into hover/selection (#105 N7c-2). When present, the lane's glyphs participate in
   * the same `on("select")` / `selection()` / hover-highlight machinery as Scene layers — styling is
   * a ring overlay drawn by a companion highlight lane (instanced glyphs have no Scene drawables to
   * recolor). Absent ⇒ pick-only (the pre-N7c-2 behavior: `on("hover"|"click")` fire, but no
   * managed selection or visual highlight).
   */
  interactive?: LaneInteractive;
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
export interface LaneInteractive {
  /** The `hit.layer` value this lane owns — the key under which selection/hover ids are tracked. */
  layer: string;
  /** Per-layer interaction options (selectable / hover / tooltip / selection). */
  options: InteractiveLayerOptions;
  /** Companion highlight lane re-emitted when this layer's selection/hover set changes (the ring overlay). */
  highlightLane: string;
  /** Datum for a selected/hovered id — used to rebuild hits in {@link BaseEngine.selection}. */
  datumOf(id: string | number): unknown;
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
export interface InteractiveLayerOptions<D = any> {
  /** Styles for {@link BaseEngine.select}: the selected set and its complement.
   *  Defaults: selected keeps the base style; others `{ opacity: 0.3 }`. */
  selection?: SelectionOptions;
  /** Hover-highlight: `true` = default white outline, a {@link HighlightStyle} = redraw the
   *  hovered item with it, or a custom `(datum, HighlightBuilder)` draw fn. Rendered in a tiny
   *  overlay layer — O(hovered item) per change, the base layer is untouched. */
  hover?: HoverOption<D>;
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

export interface LayerSpec {
  name: string;
  data: any[];
  ids: (string | number)[];
  fill?: Accessor<any, string>;
  stroke?: Accessor<any, string>;
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
  /** Hover-highlight for this layer: true = default style, a HighlightStyle = replay
   *  with it, a function = custom draw of the hovered item (see HighlightBuilder). */
  hover?: HoverOption;
  /** Tooltip content for the hovered drawable (string / element / null = hide). */
  tooltip?: (d: any, id: string | number) => string | HTMLElement | null;
  /** Opt this layer into click-driven selection (see {@link InteractiveLayerOptions.selectable}). */
  selectable?: boolean | { multi?: boolean };
  build: (g: GroupBuilder) => void;   // rebuilds the Scene group (geo or draw)
}

export interface PassThroughSpec {
  name: string;
  /** User data source: an array, or a function re-invoked each full repaint. */
  source: unknown[] | (() => unknown[]);
  /** Build the draw item for a datum, or null to cull. Built by the subclass. */
  buildItem: (d: unknown, i: number) => DrawItem | null;
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
}

/** Fallback CSS size used only when a responsive host can't be measured yet (detached / zero
 *  box); the ResizeObserver corrects it on the first real layout. Matches the <canvas> defaults. */
const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 150;

export abstract class BaseEngine {
  protected scene = new Scene();
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
  /** Active shift+drag marquee (#159): viewport-space start + lazily-created overlay rect. Null when idle. */
  private marquee: { startClientX: number; startClientY: number; el: HTMLElement | null } | null = null;
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
   *  same-backend no-op in setBackend so a backend pick during the upgrade still swaps. */
  private upgrading = false;
  /** True while the user is interacting (a rotation drag, or a zoom/pan gesture).
   *  Layers flagged hideOnInteraction are excluded from the render while this is true. */
  protected interacting = false;
  /** Detaches the currently-attached interaction (zoom or rotation), if any. */
  private interactionCleanup: (() => void) | null = null;
  /** Per-pass-through-layer repaint token. A time-sliced repaint captures the current
   *  token for its layer; each rAF step bails if a newer repaint (or an interaction) has
   *  bumped that layer's token. Per-LAYER (not a single shared token) so two PT layers
   *  repainting in the same `for … of ptSpecs.keys()` loop don't cancel each other — a
   *  shared token would let the second layer's `++token` abort the first layer's in-flight
   *  loop, so only the last layer would paint. */
  private ptRepaintTokens = new Map<string, number>();
  /** Rows projected+drawn per rAF slice. Big enough that a few-hundred-k layer finishes
   *  in one or two frames, small enough that a multi-million-point fill never blocks the
   *  main thread. Module-internal (no public API); tests stub it via the static field. */
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
    for (const name of this.ptSpecs.keys()) this.repaintPassThrough(name);
    return this;
  }

  /** Subclass hook fired by setSize() after the backend resized but before the re-render.
   *  GeoMap overrides it to refit its projection into the new box. Default: no-op (Plot's
   *  world coords are size-independent). */
  protected onResize(_prevW: number, _prevH: number, _width: number, _height: number): void {}

  whenReady(): Promise<void> { return this.ready; }
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
  protected interactionFields(opts: InteractiveLayerOptions): Pick<LayerSpec, "selection" | "hover" | "tooltip" | "selectable"> {
    return { selection: opts.selection, hover: opts.hover, tooltip: opts.tooltip, selectable: opts.selectable };
  }

  /** Register (or replace) an instanced selection lane and emit it once if a backend is ready. */
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
  /** Whether anything is currently highlighted on `layer` (selection or hover) — lets a lane's
   *  highlight strategy short-circuit to an empty visible set (O(1)) when nothing is shown. */
  protected hasHighlight(layer: string): boolean {
    return (this.selected.get(layer)?.size ?? 0) > 0 || (this.laneHilite.get(layer)?.size ?? 0) > 0;
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
    return { on: true, multi: sel !== true && (sel as { multi?: boolean }).multi === true };
  }

  /** Show the hover ring for one instanced-lane glyph (`id`), clearing the previous lane hover.
   *  `layer = null` clears any lane hover. Hover shows exactly one glyph at a time. */
  private setLaneHover(layer: string | null, id: string | number | null): void {
    if (this.laneHoverLayer && this.laneHoverLayer !== layer) {
      const prev = this.laneHoverLayer;
      this.laneHilite.delete(prev);
      this.emitHighlightFor(prev);
    }
    this.laneHoverLayer = layer;
    if (!layer) return;
    const set = this.laneHilite.get(layer);
    if (id == null) {
      if (set?.size) { this.laneHilite.delete(layer); this.emitHighlightFor(layer); }
    } else if (!set || set.size !== 1 || !set.has(id)) {
      this.laneHilite.set(layer, new Set([id]));
      this.emitHighlightFor(layer);
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

  /** Register/replace a layer: build its Scene group, apply accessors, index, push. */
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
   *  (an explicit unsupported backend, e.g. SVG). When no backend is live yet: defer. */
  protected registerPassThrough(spec: PassThroughSpec): void {
    this.ptSpecs.set(spec.name, spec);
    if (!this.handle) return; // not ready: keep the spec; install replay activates it
    if (!this.handle.backend.supportsPassThrough) {
      this.ptSpecs.delete(spec.name);
      this.ptRepaintTokens.delete(spec.name); // prune stale token (no active repaint, but keep the map clean)
      throw new Error(
        `passThrough is not supported by the "${this.currentBackend}" backend (use the canvas or webgl backend)`,
      );
    }
    this.handle.backend.setPassThroughLayer?.({ name: spec.name, sizeMode: spec.sizeMode, clipTo: spec.clipTo });
    this.repaintPassThrough(spec.name);
  }

  /** Incremental draw: project just this batch and draw it on top (O(new)). */
  protected appendPassThrough(name: string, items: unknown[]): void {
    const spec = this.ptSpecs.get(name);
    if (!spec || !this.handle) return;
    const batch = buildBatch(items, spec.buildItem);
    this.handle.backend.drawPassThrough?.(name, batch, "append");
  }

  /** Resolve the current data array for a pass-through layer. */
  private ptData(spec: PassThroughSpec): unknown[] {
    return typeof spec.source === "function" ? spec.source() : spec.source;
  }

  /**
   * Full repaint of a pass-through layer, TIME-SLICED so a multi-million-point fill never
   * freezes the main thread: re-pull the data, then project + draw it in PT_CHUNK-row
   * slices across requestAnimationFrame frames. The FIRST slice runs synchronously (so the
   * caller sees points immediately and the retained base is redrawn via "replace-first");
   * later slices are scheduled on rAF and stack on top via "replace-rest" (no clear).
   *
   * Cancellable per layer: each call captures a fresh token for `name`; a running slice
   * loop bails the moment that token changes — i.e. when a NEWER repaint of the same layer
   * starts, or an interaction begins (setInteracting bumps every layer's token). Using a
   * per-layer token Map (not one shared counter) keeps layers independent: the settle /
   * setTransform loops repaint every PT layer in turn, and a shared `++token` would let the
   * second layer cancel the first's in-flight loop, so only the last layer would paint.
   *
   * Phase-1 multi-layer note: "replace-first" clears + redraws the retained base (the canvas
   * backend calls render()), so two PT layers each starting with "replace-first" would clobber
   * each other's pixels. The streaming use case is a SINGLE pass-through layer; multi-PT-layer
   * compositing is out of scope here (would need a per-layer offscreen buffer in the backend).
   */
  protected repaintPassThrough(name: string): void {
    const spec = this.ptSpecs.get(name);
    if (!spec || !this.handle) return;
    // Closing over `spec` here is safe: if the same layer is re-registered, registerPassThrough
    // calls repaintPassThrough again (bumping this layer's token), which cancels any in-flight
    // step() before it can execute another slice with the now-stale spec.
    const data = this.ptData(spec);
    const token = (this.ptRepaintTokens.get(name) ?? 0) + 1;
    this.ptRepaintTokens.set(name, token);
    const total = data.length;
    let cursor = 0;
    const step = (): void => {
      // Cancelled by a newer repaint of this layer, an interaction, or a destroyed engine.
      if (token !== this.ptRepaintTokens.get(name) || !this.handle) return;
      const end = Math.min(cursor + BaseEngine.PT_CHUNK, total);
      const slice = data.slice(cursor, end);
      const batch = buildBatch(slice, spec.buildItem);
      this.handle.backend.drawPassThrough?.(name, batch, cursor === 0 ? "replace-first" : "replace-rest");
      cursor = end;
      if (cursor < total) requestAnimationFrame(step);
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
  protected appendToLayer(name: string, items: readonly any[], ids: readonly (string | number)[], build: (g: GroupBuilder) => void): void {
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
    if (this.ptSpecs.has(name)) { this.repaintPassThrough(name); return this; }
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
   */
  select(name: string, set: readonly (string | number)[] | ((d: any, i: number) => boolean) | null): this {
    // Lane-first: an interactive lane takes precedence over a same-named (empty placeholder) Scene spec.
    if (this.laneInteractiveFor(name)) {
      // Instanced lane: update the managed set + refresh the ring overlay (no Scene drawables to style).
      if (typeof set === "function") throw new Error(`select(${name}, fn): function selectors are Scene-layer only; pass an id array for instanced lanes`);
      if (set === null) this.selected.delete(name);
      else this.selected.set(name, new Set(set));
      this.emitHighlightFor(name);
      this.selectCb?.(this.selection(), undefined);
      return this;
    }
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    // Resolve function selectors to an id set once (stored + used for styling).
    const resolved: Set<string | number> | null = set === null ? null
      : typeof set === "function"
        ? new Set(spec.ids.filter((_, i) => (set as (d: any, i: number) => boolean)(spec.data[i], i)))
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
   */
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
        const draw = resolveHighlight(styleOrDraw ?? spec.hover);
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
        // Gesture start: cancel any in-flight time-sliced fill (bump each layer's token so
        // a running step() no-ops on its next frame) BEFORE snapshotting — otherwise a
        // stale slice could draw onto the canvas we're about to freeze for snapshot-pan.
        for (const name of this.ptSpecs.keys())
          this.ptRepaintTokens.set(name, (this.ptRepaintTokens.get(name) ?? 0) + 1);
        // Capture the current accumulation so the backend can snapshot-pan.
        this.handle?.backend.snapshotPassThrough?.();
      } else {
        // Settle: re-pull + crisp redraw of every pass-through layer.
        // Known benign double-repaint: if a hideOnInteraction retained layer coexists with
        // a pass-through layer, pushLayers() above already called repaintPassThrough for
        // each PT layer (to restore PT pixels after render() cleared them). The loop here
        // repaints them again — correct output; the first-slice from pushLayers is simply
        // cancelled by this second token bump. Do NOT add a dedup guard: the pushLayers
        // repaint is necessary in the general case (retained-layer rebuild without settle).
        for (const name of this.ptSpecs.keys()) this.repaintPassThrough(name);
      }
    }
  }
  setTransform(t: ViewTransform): this {
    this.transform = t;
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
    // programmatic/settle transform, re-pull + crisp redraw each layer.
    if (this.ptSpecs.size > 0 && !this.interacting) {
      for (const name of this.ptSpecs.keys()) this.repaintPassThrough(name);
    }
    return this;
  }

  /** Called by {@link setTransform} just before the render (zoom frame or programmatic), after lanes
   *  re-emit. Subclasses override to re-place view-tracking overlays/labels — e.g. the network's
   *  frontier label layer (#105 N7b) — so a backend that bakes labels into the frame draws them now. */
  protected afterTransform(): void {}

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
    // Flags-only change: push just the style tables (the styles-only path). No render() here —
    // setTransform() renders right after the declutter loop. updateLayer would re-upload the
    // full geometry per zoom frame for nothing.
    const backend = this.handle?.backend;
    if (backend?.updateLayerStyles) {
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
      backend?.updateLayer(spec.name, this.renderLayer(spec));
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
    const sel = select(this.host as Element);
    const behavior = d3zoom<Element, unknown>().scaleExtent(extent)
      // Reserve shift+drag for the marquee (#159) only when something is marquee-selectable — otherwise
      // keep d3-zoom's default (which pans on shift+drag). Shift+wheel still zooms (wheel is exempt).
      .filter((e: Event) => {
        const me = e as MouseEvent;
        if (me.shiftKey && e.type !== "wheel" && this.marqueeCapable()) return false;
        // A plain primary drag starting ON a draggable glyph is a node-drag (#140), not a pan — let
        // d3-zoom decline it so `onPointerDown` grabs the node. Only a pointerdown does this hit-test;
        // wheel/dblclick keep zooming. (onPointerDown re-resolves the hit to actually start the drag.)
        if (e.type === "pointerdown" && !me.shiftKey && !me.ctrlKey && !me.button && this.draggableAtEvent(me)) return false;
        return (!me.ctrlKey || e.type === "wheel") && !me.button;
      })
      .on("start", () => this.setInteracting(true))
      .on("zoom", (e: D3ZoomEvent<Element, unknown>) => {
        const t: ViewTransform = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        this.setTransform(t);
        onTransform?.(t);
      })
      .on("end", () => this.setInteracting(false));
    (sel as any).call(behavior);
    // Seed d3-zoom's internal transform from the engine's CURRENT view so a non-identity base
    // (e.g. a centering translate set via setTransform before enableZoom) is respected, and
    // zoom-to-cursor deltas measure from it rather than from identity.
    const t = this.transform;
    (sel as any).call(behavior.transform, zoomIdentity.translate(t.x, t.y).scale(t.k));
    this.interactionCleanup = () => { (sel as any).on(".zoom", null); };
    return this;
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
  render(): this { this.handle?.backend.render(); return this; }
  toSVG(): string { return this.handle?.backend.toSVG() ?? ""; }
  toPNG(): string { return this.handle?.backend.toPNG() ?? ""; }
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
    this.nodeDrag?.session?.end(); this.endNodeDrag(); // release a held drag + its window listeners (#140)
    this.tooltipEl?.destroy(); this.tooltipEl = null;
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
    this.marquee = { startClientX: e.clientX, startClientY: e.clientY, el: null };
    window.addEventListener("pointermove", this.onMarqueeMove);
    window.addEventListener("pointerup", this.onMarqueeUp);
  }
  private onMarqueeMove = (e: PointerEvent): void => {
    const m = this.marquee;
    if (!m) return;
    if (!m.el) {
      if (Math.hypot(e.clientX - m.startClientX, e.clientY - m.startClientY) <= BaseEngine.CLICK_SLOP) return;
      const el = document.createElement("div");
      el.className = "d3gl-marquee";
      el.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:1px dashed rgba(255,255,255,0.9);background:rgba(120,170,255,0.18)";
      document.body.appendChild(el);
      m.el = el;
    }
    m.el.style.left = `${Math.min(m.startClientX, e.clientX)}px`;
    m.el.style.top = `${Math.min(m.startClientY, e.clientY)}px`;
    m.el.style.width = `${Math.abs(e.clientX - m.startClientX)}px`;
    m.el.style.height = `${Math.abs(e.clientY - m.startClientY)}px`;
    // Live preview: ring the glyphs the box currently covers (the hover ring), updated as it grows.
    this.previewMarquee(this.marqueeRect(m.startClientX, m.startClientY, e.clientX, e.clientY));
  };
  private onMarqueeUp = (e: PointerEvent): void => {
    const m = this.marquee;
    if (!m) return;
    const box = m.el != null && Math.hypot(e.clientX - m.startClientX, e.clientY - m.startClientY) > BaseEngine.CLICK_SLOP;
    const rect = this.marqueeRect(m.startClientX, m.startClientY, e.clientX, e.clientY);
    this.endMarquee(); // also clears the live preview rings
    // A real drag → region select; a no-drag shift+click is left to onPointerUp's click path.
    if (box) this.finalizeMarquee(rect, e);
  };
  /** Remove the overlay + window listeners, drop the live preview rings, and clear marquee state. Idempotent. */
  private endMarquee(): void {
    const m = this.marquee;
    if (!m) return;
    window.removeEventListener("pointermove", this.onMarqueeMove);
    window.removeEventListener("pointerup", this.onMarqueeUp);
    m.el?.remove();
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
  /** Live marquee preview: show the will-be-selected glyphs with the hover ring (blue), updated as the
   *  box grows. Reuses the lane's transient hover set (`laneHilite`) — selected glyphs keep their own
   *  ring colour. Re-emits a lane's ring overlay only when its set changed (a drag fires many moves). */
  private previewMarquee(rect: ScreenRect): void {
    const byLayer = this.marqueeIdsByLayer(rect);
    // Update layers in the box, and clear any previewed layer no longer in it.
    for (const layer of this.marqueePreview) if (!byLayer.has(layer)) byLayer.set(layer, new Set());
    for (const [layer, ids] of byLayer) {
      if (setsEqual(this.laneHilite.get(layer), ids)) continue;
      if (ids.size) { this.laneHilite.set(layer, ids); this.marqueePreview.add(layer); }
      else { this.laneHilite.delete(layer); this.marqueePreview.delete(layer); }
      this.emitHighlightFor(layer);
    }
  }
  /** Drop the live preview rings (on marquee end / cancel). */
  private clearMarqueePreview(): void {
    if (this.marqueePreview.size === 0) return;
    for (const layer of this.marqueePreview) { this.laneHilite.delete(layer); this.emitHighlightFor(layer); }
    this.marqueePreview.clear();
  }
  /** Add every multi-selectable lane's glyphs in the box to the selection (additive, like shift+click),
   *  then refresh styling and fire `on("select")`. */
  private finalizeMarquee(rect: ScreenRect, e: PointerEvent): void {
    const touched = new Set<string>();
    for (const [layer, ids] of this.marqueeIdsByLayer(rect)) {
      const set = this.getOrCreateLayerSet(layer);
      for (const id of ids) set.add(id);
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
      // Lane-first: an interactive lane refreshes its ring overlay; otherwise a Scene layer restyles.
      if (this.laneInteractiveFor(n)) {
        this.emitHighlightFor(n);
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
  private resolve<T>(a: Accessor<any, T> | undefined, d: any, i: number): T | undefined {
    return typeof a === "function" ? (a as (d: any, i: number) => T)(d, i) : a;
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
    for (const spec of this.specs) if (spec.declutter) this.cullDeclutter(spec, this.transform);
    this.handle?.backend.setLayers(this.allRenderLayers());
    this.handle?.backend.setTransform(this.transform);
    this.render();
    // render() above clears the canvas and redraws ONLY the retained layers — it has no
    // pass-through point data, so any pass-through pixels are wiped. Repaint each PT layer
    // back on top. Gated on ptSpecs.size so retained-only maps keep their zero-overhead path
    // (and no recursion: repaintPassThrough → backend.drawPassThrough("replace-first") calls
    // backend.render() directly, never back through pushLayers).
    if (this.ptSpecs.size > 0)
      for (const name of this.ptSpecs.keys()) this.repaintPassThrough(name);
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
    next.backend.setLayers(this.allRenderLayers());
    next.backend.setTransform(this.transform);
    next.backend.render();
    // Replay retained pass-through layers onto the freshly-installed backend (mirrors the
    // retained setLayers re-push above). A deferred/not-ready registration is activated here.
    if (this.ptSpecs.size > 0) {
      if (!next.backend.supportsPassThrough) {
        throw new Error(
          `passThrough is not supported by the "${type}" backend (use the canvas or webgl backend)`,
        );
      }
      for (const spec of this.ptSpecs.values()) {
        next.backend.setPassThroughLayer?.({ name: spec.name, sizeMode: spec.sizeMode, clipTo: spec.clipTo });
        this.repaintPassThrough(spec.name);
      }
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

  /** Enter "auto" mode: install a Canvas backend synchronously (instant first paint, no
   *  await, no onBackendSwapped — it is the first install / a fresh canvas), then start the
   *  background WebGL upgrade. Bumping swapToken invalidates any in-flight prior swap. */
  private enterAutoMode(): void {
    const handle = createCanvasBackend(this.host, this.width, this.height);
    this.installBackend(handle, ++this.swapToken, "canvas");
    this.upgradeDone = this.upgradeToWebGL();
  }

  /** Background upgrade: create the WebGL device, then swap it in via installBackend (which
   *  destroys the canvas handle and fires onBackendSwapped, since it replaces a live handle).
   *  On failure, keep the canvas and warn — the map keeps working. While in flight, `upgrading`
   *  is true so a same-type setBackend isn't treated as a no-op (a "canvas" pick during the
   *  window must still cancel the upgrade via the normal swap's token bump). */
  private async upgradeToWebGL(): Promise<void> {
    this.upgrading = true;
    try {
      const token = ++this.swapToken;
      let next: BackendHandle;
      try {
        next = await this.createWebGLBackend();
      } catch (err) {
        if (!this.destroyed) console.warn("d3gl: WebGL upgrade failed, staying on canvas", err);
        return;
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
        return;
      }
      this.installBackend(next, token, "webgl");
    } finally {
      this.upgrading = false;
    }
  }
}

/** Same-membership test for the marquee-preview change guard (avoids re-emitting an unchanged ring set). */
function setsEqual(a: ReadonlySet<string | number> | undefined, b: ReadonlySet<string | number>): boolean {
  if (!a || a.size !== b.size) return false;
  for (const v of b) if (!a.has(v)) return false;
  return true;
}
