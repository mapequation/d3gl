import type { GroupBuffers, DrawableVector } from "./scene.js";

/** View transform applied on top of project-once geometry: scale k, translate (x, y). */
export interface ViewTransform {
  k: number;
  x: number;
  y: number;
}

/** One named layer handed to a backend: GPU buffers + the vector view + optional clip. */
export interface RenderLayer {
  name: string;
  buffers: GroupBuffers;
  drawables: DrawableVector[];
  /** Name of an earlier layer whose filled silhouette clips this one. */
  clipTo?: string;
}

/** A renderer for a Scene, implemented per target (WebGL / Canvas / SVG). */
export interface Backend {
  setLayers(layers: RenderLayer[]): void;
  updateLayer(name: string, layer: RenderLayer): void;
  setTransform(t: ViewTransform): void;
  render(): void;
  toPNG(): string;
  toSVG(): string;
  destroy(): void;
}
