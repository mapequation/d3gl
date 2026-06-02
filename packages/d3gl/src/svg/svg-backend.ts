import type { Backend, RenderLayer, ViewTransform } from "../core/index.js";
import { svgFromLayers } from "./serialize.js";

export class SvgBackend implements Backend {
  private layers: RenderLayer[] = [];
  private transform: ViewTransform = { k: 1, x: 0, y: 0 };
  private root: SVGSVGElement;

  constructor(private host: HTMLElement, private width: number, private height: number) {
    this.root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.root.setAttribute("width", String(width));
    this.root.setAttribute("height", String(height));
    host.appendChild(this.root);
  }
  setLayers(layers: RenderLayer[]): void { this.layers = layers; }
  updateLayer(name: string, layer: RenderLayer): void {
    const i = this.layers.findIndex((l) => l.name === name);
    if (i >= 0) this.layers[i] = layer; else this.layers.push(layer);
  }
  setTransform(t: ViewTransform): void { this.transform = t; }
  render(): void {
    // Re-serialize the body into the live root svg (innerHTML of the inner markup).
    const full = svgFromLayers(this.width, this.height, this.layers, this.transform);
    const inner = full.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
    this.root.innerHTML = inner;
  }
  toSVG(): string { return svgFromLayers(this.width, this.height, this.layers, this.transform); }
  toPNG(): string {
    throw new Error("SvgBackend.toPNG: rasterize via a raster backend (canvas/webgl); SVG export is toSVG()");
  }
  destroy(): void { this.root.remove(); this.layers = []; }
}
