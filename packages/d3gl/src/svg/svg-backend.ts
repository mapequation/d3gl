import type { Backend, RenderLayer, ViewTransform, StyleTables, DrawableVector, TextData, HoverText } from "../core/index.js";
import { svgBody, svgFromLayers, serializeTexts, serializeHoverText, viewTransform } from "./serialize.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export class SvgBackend implements Backend {
  /** SVG has no raster surface for pass-through; the engine rejects it before calling us. */
  readonly supportsPassThrough = false;

  private layers: RenderLayer[] = [];
  private transform: ViewTransform = { k: 1, x: 0, y: 0 };
  private root: SVGSVGElement;
  // Persistent children so a pan/zoom only updates `view`'s transform attribute
  // instead of re-serializing the whole document. `defs` holds clipPaths, `view`
  // holds world-coordinate content (transformed by its `transform` attr), `screen`
  // holds constant-pixel content whose coords already bake in the transform.
  private defs: SVGDefsElement;
  private view: SVGGElement;
  private screen: SVGGElement;
  /** Screen-space `<text>` labels (#105 N7b-2), drawn on top in their own group (coords are screen px). */
  private text: SVGGElement;
  private textData: readonly TextData[] = [];
  /** The one hovered label shown in full (#496), in a group of its own above the placed text, so a hover
   *  change rewrites this one element and never the placed set. */
  private hoverG: SVGGElement;
  private hoverText: HoverText | null = null;
  /** The highlight overlays (#519), in a group of their own between the scene and the labels (where
   *  WebGL draws them under its HTML labels), so a hover change rewrites this group's markup and never
   *  the scene's. `overlayView` holds the world content under the view transform. */
  private overlayG: SVGGElement;
  private overlayView: SVGGElement;
  private overlayRest: SVGGElement;
  private overlays: readonly RenderLayer[] = [];
  /** Some overlay is screen sizeMode, so a move must re-serialize the overlays too. */
  private overlayHasScreen = false;
  /** `overlayView` holds world content. Only then does a zoom write its transform: with nothing
   *  highlighted a zoom stays ONE attribute write on `view` (the retained-document guard, #264). */
  private overlayHasWorld = false;
  private overlayDirty = false;
  /** True when some layer is screen sizeMode → `view`/strokes depend on the transform,
   *  so a move must re-serialize (no O(1) transform fast path). */
  private hasScreen = false;
  /** Content (not just the transform) changed since the last render, so `render()`
   *  must re-serialize. The engine calls `render()` after every `setTransform`; this
   *  lets that call be a no-op for an all-world pan/zoom (the retained DOM stands,
   *  only the view group's transform attribute changed). */
  private dirty = true;

  constructor(private host: HTMLElement, private width: number, private height: number) {
    this.root = document.createElementNS(SVG_NS, "svg");
    this.root.setAttribute("width", String(width));
    this.root.setAttribute("height", String(height));
    // A viewBox defines the user-coordinate system (0,0..W,H) the markup is drawn in and
    // lets the SVG scale to fit its viewport the way a <canvas> raster buffer does, so CSS
    // resizing (e.g. a docs theme's `svg { max-width:100% }`) doesn't shift/zoom it vs the
    // canvas/webgl backends. `xMidYMid meet` keeps the same centered uniform fit.
    this.root.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.root.setAttribute("preserveAspectRatio", "xMidYMid meet");
    this.defs = document.createElementNS(SVG_NS, "defs");
    this.view = document.createElementNS(SVG_NS, "g");
    this.screen = document.createElementNS(SVG_NS, "g");
    this.text = document.createElementNS(SVG_NS, "g");
    this.hoverG = document.createElementNS(SVG_NS, "g");
    this.overlayG = document.createElementNS(SVG_NS, "g");
    this.overlayView = document.createElementNS(SVG_NS, "g");
    this.overlayRest = document.createElementNS(SVG_NS, "g");
    this.overlayG.append(this.overlayView, this.overlayRest);
    this.root.append(this.defs, this.view, this.screen, this.overlayG, this.text, this.hoverG);
    host.appendChild(this.root);
  }

  setLayers(layers: RenderLayer[]): void { this.layers = layers; this.dirty = true; }
  updateLayer(name: string, layer: RenderLayer): void {
    const i = this.layers.findIndex((l) => l.name === name);
    if (i >= 0) this.layers[i] = layer; else this.layers.push(layer);
    this.dirty = true;
  }

  /** Styles-only update: swap the stored vector view and re-serialize on next render(). SVG
   *  renders from `drawables`, so it always needs them ({@link stylesNeedDrawables} default). */
  updateLayerStyles(name: string, _tables: StyleTables, drawables?: DrawableVector[]): void {
    const i = this.layers.findIndex((l) => l.name === name);
    if (i < 0 || !drawables) return;
    this.layers[i] = { ...this.layers[i]!, drawables };
    this.dirty = true;
  }

  /** Flags-only update (#208): patch the retained vector view's flag bytes IN PLACE — no new
   *  objects or arrays (vs updateLayerStyles, which swaps in a freshly materialized view) —
   *  and mark dirty: visibility changed, so the next render() re-serializes, exactly as
   *  before. The length guard is defensive: any drawable-set change reaches this backend as
   *  updateLayer/appendToLayer/setLayers first. */
  updateLayerFlags(name: string, flags: Uint8Array): void {
    const layer = this.layers.find((l) => l.name === name);
    if (!layer || layer.drawables.length !== flags.length) return;
    const ds = layer.drawables;
    for (let i = 0; i < ds.length; i++) ds[i]!.flags = flags[i]!;
    this.dirty = true;
  }

  /** Screen-space text labels (#105 N7b-2). Coords are already in screen px (no view transform), so a
   *  pan/zoom re-pushes the set; rendered into the dedicated `text` group + included in toSVG(). */
  setTextLayer(texts: readonly TextData[]): void {
    this.textData = texts;
    this.text.innerHTML = serializeTexts(texts);
  }

  /** The one-label hover slot (#496): one element written, the placed text group untouched. */
  setHoverText(hover: HoverText | null): void {
    this.hoverText = hover;
    this.hoverG.innerHTML = serializeHoverText(hover);
  }

  /** Replace the highlight overlays; {@link renderOverlays} (or the next render()) writes them. */
  setOverlays(layers: readonly RenderLayer[]): void {
    this.overlays = layers;
    this.overlayDirty = true;
  }

  /** Rewrite only the overlay group's markup (#519): O(overlay drawables), whatever the scene. A clipped
   *  overlay also writes its clip silhouette (O(that clip layer)). */
  renderOverlays(): void {
    const { defs, world, screen, hasScreen } = svgBody(this.overlays, this.transform, this.layers);
    this.overlayView.innerHTML = world;
    // Its transform follows setTransform only while it has world content, so (re)point it here; an
    // emptied group drops it, back to the pristine element a zoom never touches.
    const hadWorld = this.overlayHasWorld;
    this.overlayHasWorld = world !== "";
    if (this.overlayHasWorld) this.overlayView.setAttribute("transform", viewTransform(this.transform));
    else if (hadWorld) this.overlayView.removeAttribute("transform");
    this.overlayRest.innerHTML = defs ? `<defs>${defs}</defs>${screen}` : screen;
    this.overlayHasScreen = hasScreen;
    this.overlayDirty = false;
  }

  setTransform(t: ViewTransform): void {
    this.transform = t;
    if (this.overlayHasWorld) this.overlayView.setAttribute("transform", viewTransform(t));
    if (this.overlayHasScreen) this.overlayDirty = true;
    // O(1) for the common (all-world) case: just re-point the view group, and DON'T mark
    // dirty — the engine's following render() then no-ops (the retained DOM stands). With
    // screen-mode content the coords/strokes bake the transform, so a re-serialize is due.
    this.view.setAttribute("transform", viewTransform(t));
    if (this.hasScreen) this.dirty = true;
  }

  /** Resize the root <svg> + its viewBox. The markup is drawn in a (0,0..W,H) user-coordinate
   *  system pinned by the viewBox, so existing nodes keep their positions; the engine re-renders
   *  after to fill the new box. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.root.setAttribute("width", String(width));
    this.root.setAttribute("height", String(height));
    this.root.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.dirty = true;
    this.overlayDirty = true;
  }

  render(): void {
    if (this.overlayDirty) this.renderOverlays();
    if (!this.dirty) return; // only the transform changed (already applied in setTransform)
    const { defs, world, screen, hasScreen } = svgBody(this.layers, this.transform);
    this.defs.innerHTML = defs;
    this.view.innerHTML = world;
    this.view.setAttribute("transform", viewTransform(this.transform));
    this.screen.innerHTML = screen;
    this.hasScreen = hasScreen;
    this.dirty = false;
  }

  // The overlays export after the scene, as WebGL's overlay layers do; the hover label is transient (as on WebGL).
  toSVG(): string { return svgFromLayers(this.width, this.height, [...this.layers, ...this.overlays], this.transform, this.textData); }
  toPNG(): string {
    throw new Error("SvgBackend.toPNG: rasterize via a raster backend (canvas/webgl); SVG export is toSVG()");
  }
  destroy(): void { this.root.remove(); this.layers = []; }
}
