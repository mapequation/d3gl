import type { Backend, RenderLayer, ViewTransform, StyleTables, DrawableVector } from "../core/index.js";
import { svgBody, svgFromLayers, viewTransform } from "./serialize.js";

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
    this.root.append(this.defs, this.view, this.screen);
    host.appendChild(this.root);
  }

  setLayers(layers: RenderLayer[]): void { this.layers = layers; this.dirty = true; }
  updateLayer(name: string, layer: RenderLayer): void {
    const i = this.layers.findIndex((l) => l.name === name);
    if (i >= 0) this.layers[i] = layer; else this.layers.push(layer);
    this.dirty = true;
  }

  /** Styles-only update: swap the stored vector view and re-serialize on next render(). */
  updateLayerStyles(name: string, _tables: StyleTables, drawables: DrawableVector[]): void {
    const i = this.layers.findIndex((l) => l.name === name);
    if (i < 0) return;
    this.layers[i] = { ...this.layers[i]!, drawables };
    this.dirty = true;
  }

  setTransform(t: ViewTransform): void {
    this.transform = t;
    // O(1) for the common (all-world) case: just re-point the view group, and DON'T mark
    // dirty — the engine's following render() then no-ops (the retained DOM stands). With
    // screen-mode content the coords/strokes bake the transform, so a re-serialize is due.
    this.view.setAttribute("transform", viewTransform(t));
    if (this.hasScreen) this.dirty = true;
  }

  render(): void {
    if (!this.dirty) return; // only the transform changed (already applied in setTransform)
    const { defs, world, screen, hasScreen } = svgBody(this.layers, this.transform);
    this.defs.innerHTML = defs;
    this.view.innerHTML = world;
    this.view.setAttribute("transform", viewTransform(this.transform));
    this.screen.innerHTML = screen;
    this.hasScreen = hasScreen;
    this.dirty = false;
  }

  toSVG(): string { return svgFromLayers(this.width, this.height, this.layers, this.transform); }
  toPNG(): string {
    throw new Error("SvgBackend.toPNG: rasterize via a raster backend (canvas/webgl); SVG export is toSVG()");
  }
  destroy(): void { this.root.remove(); this.layers = []; }
}
