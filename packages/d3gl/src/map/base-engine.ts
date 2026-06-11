import { select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type D3ZoomEvent } from "d3-zoom";
import { Scene, HitIndex, type Backend, type GroupBuilder, type RenderLayer, type ViewTransform } from "../core/index.js";
import { createBackend, createCanvasBackend, type BackendType, type BackendHandle } from "./backend-factory.js";
import { buildBatch, type DrawItem } from "./draw-batch.js";
import { composeColor, type StyleOverride, type SelectionOptions } from "./style-overrides.js";
import { HighlightBuilder, resolveHighlight, HIGHLIGHT_SUFFIX, type HighlightStyle, type HighlightDraw, type HoverOption, type PendingColor } from "./highlight.js";

export type Accessor<D, T> = T | ((d: D, i: number) => T);
export interface HoverHit { layer: string; id: string | number; datum: unknown; }

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

export abstract class BaseEngine {
  protected scene = new Scene();
  protected specs: LayerSpec[] = [];
  protected hitIndexes = new Map<string, HitIndex>();
  /** Pass-through layers: no Scene entry, no retained geometry. */
  protected ptSpecs = new Map<string, PassThroughSpec>();
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
  /** pointerdown position; a pointerup within CLICK_SLOP px of it is a click. */
  private downAt: [number, number] | null = null;
  /** Max pointer travel (px) between down and up for a click — suppresses pan/rotate drags. */
  private static readonly CLICK_SLOP = 4;
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

  constructor(protected host: HTMLElement, protected width: number, protected height: number, backend: BackendType) {
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
    if (backend === "auto") {
      // Instant canvas first paint; whenReady() resolves now. WebGL is built in the background.
      this.ready = Promise.resolve();
      this.enterAutoMode();
    } else {
      this.ready = this.swapBackend(backend);
    }
  }
  whenReady(): Promise<void> { return this.ready; }
  /** The currently-active backend type (set by the constructor / installBackend). */
  protected backendType(): BackendType { return this.currentBackend; }
  /** The live backend instance, or null before the first swap resolves. */
  protected backend(): Backend | null { return this.handle?.backend ?? null; }

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
    if (spec.pickable !== false) this.hitIndexes.set(spec.name, new HitIndex(this.scene.drawables(spec.name)));
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
   */
  select(name: string, set: readonly (string | number)[] | ((d: any, i: number) => boolean) | null): this {
    const spec = this.specs.find((s) => s.name === name);
    if (!spec) return this;
    this.styleOverrides.delete(name);
    if (set !== null) {
      const members = typeof set === "function"
        ? new Set(spec.ids.filter((_, i) => set(spec.data[i], i)))
        : new Set(set);
      const selected = spec.selection?.selected;
      const others = spec.selection?.others ?? { opacity: 0.3 };
      const map = new Map<string | number, StyleOverride>();
      for (const id of spec.ids) {
        const o = members.has(id) ? selected : others;
        if (o) map.set(id, o);
      }
      this.styleOverrides.set(name, map);
    }
    this.restyle(spec, spec.ids);
    this.pushStyles(spec);
    return this;
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
    for (const spec of this.specs) if (spec.declutter) this.declutterLayer(spec, t);
    this.render();
    // Pass-through layers. While interacting, the backend composites its accumulation
    // buffer with the live transform (snapshot-pan) — nothing to repaint here. On a
    // programmatic/settle transform, re-pull + crisp redraw each layer.
    if (this.ptSpecs.size > 0 && !this.interacting) {
      for (const name of this.ptSpecs.keys()) this.repaintPassThrough(name);
    }
    return this;
  }

  /**
   * Hide anchored glyphs that overlap in screen space, keeping earlier (e.g. larger-clade)
   * ones. Drawables sharing an exact anchor (a pie's wedges) are one unit. A uniform grid
   * of cell size = radius makes neighbour checks O(1) average, so this is cheap enough to run
   * on every zoom; it only toggles visibility flags (no geometry rebuild).
   */
  private declutterLayer(spec: LayerSpec, t: ViewTransform): void {
    const radius = spec.declutter!;
    if (!(radius > 0)) return;
    const draws = this.scene.drawables(spec.name);
    const groups = new Map<string, { ax: number; ay: number; ids: (string | number)[] }>();
    for (const d of draws) {
      if (!d.anchor) continue;
      const key = `${d.anchor[0]},${d.anchor[1]}`;
      const g = groups.get(key) ?? { ax: d.anchor[0], ay: d.anchor[1], ids: [] };
      g.ids.push(d.id);
      groups.set(key, g);
    }
    if (groups.size === 0) return;
    const r2 = radius * radius;
    const grid = new Map<string, { x: number; y: number }[]>();
    const visible = new Set<string | number>();
    for (const g of groups.values()) {
      const sx = t.k * g.ax + t.x, sy = t.k * g.ay + t.y;
      const cx = Math.floor(sx / radius), cy = Math.floor(sy / radius);
      let occluded = false;
      for (let i = -1; i <= 1 && !occluded; i++)
        for (let j = -1; j <= 1 && !occluded; j++) {
          for (const p of grid.get(`${cx + i},${cy + j}`) ?? []) {
            const dx = p.x - sx, dy = p.y - sy;
            if (dx * dx + dy * dy < r2) { occluded = true; break; }
          }
        }
      if (!occluded) {
        (grid.get(`${cx},${cy}`) ?? grid.set(`${cx},${cy}`, []).get(`${cx},${cy}`)!).push({ x: sx, y: sy });
        for (const id of g.ids) visible.add(id);
      }
    }
    for (const d of draws) this.scene.setFlag(spec.name, d.id, !d.anchor || visible.has(d.id) ? 1 : 0);
    this.handle?.backend.updateLayer(spec.name, this.renderLayer(spec));
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
  on(event: "hover" | "click", cb: (hit: HoverHit | null, ev: PointerEvent) => void): this {
    if (event === "hover") {
      this.hoverCb = cb;
      this.host.addEventListener("pointermove", this.onPointerMove);
      this.host.addEventListener("pointerleave", this.onPointerLeave);
    } else if (event === "click") {
      this.clickCb = cb;
      // Re-calling on("click") swaps the callback; the addEventListener calls below are
      // no-ops when the same handler refs are already registered — intentional.
      this.host.addEventListener("pointerdown", this.onPointerDown);
      this.host.addEventListener("pointerup", this.onPointerUp);
      this.host.addEventListener("pointercancel", this.onPointerCancel);
    }
    return this;
  }
  pick(x: number, y: number): HoverHit | null {
    const px = (x - this.transform.x) / this.transform.k;
    const py = (y - this.transform.y) / this.transform.k;
    for (let i = this.specs.length - 1; i >= 0; i--) {
      const spec = this.specs[i]!;
      const id = this.hitIndexes.get(spec.name)?.pick(px, py);
      if (id == null) continue;
      // Visually clipped away ⇒ not a hit: with clipTo, the point must also fall on the
      // clip source's geometry. Skipped when the source has no hit index (pickable:false).
      if (spec.clipTo) {
        const clip = this.hitIndexes.get(spec.clipTo);
        if (clip && clip.pick(px, py) == null) continue;
      }
      const di = this.layerIds.get(spec.name)?.get(id) ?? -1;
      return { layer: spec.name, id, datum: di >= 0 ? spec.data[di] : null };
    }
    return null;
  }
  render(): this { this.handle?.backend.render(); return this; }
  toSVG(): string { return this.handle?.backend.toSVG() ?? ""; }
  toPNG(): string { return this.handle?.backend.toPNG() ?? ""; }
  destroy(): void {
    this.destroyed = true;
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
    this.handle?.backend.destroy();
    if (this.handle && this.handle.element !== this.host) this.handle.element.remove();
    this.handle = null;
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.hoverCb) return;
    const r = this.host.getBoundingClientRect();
    this.hoverCb(this.pick(e.clientX - r.left, e.clientY - r.top), e);
  };
  private onPointerLeave = (e: PointerEvent): void => { this.hoverCb?.(null, e); };
  private onPointerDown = (e: PointerEvent): void => { this.downAt = [e.clientX, e.clientY]; };
  /** An interrupted gesture (e.g. setPointerCapture takeover, scroll) must not leave a stale
   *  down-position that would validate the next unrelated pointerup as a click. */
  private onPointerCancel = (): void => { this.downAt = null; };
  private onPointerUp = (e: PointerEvent): void => {
    const d = this.downAt;
    this.downAt = null;
    if (!d || !this.clickCb) return;
    if (Math.hypot(e.clientX - d[0], e.clientY - d[1]) > BaseEngine.CLICK_SLOP) return;
    const r = this.host.getBoundingClientRect();
    this.clickCb(this.pick(e.clientX - r.left, e.clientY - r.top), e);
  };
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
