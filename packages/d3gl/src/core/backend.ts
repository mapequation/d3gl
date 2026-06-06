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
  /**
   * "world" (default): geometry scales with zoom. "screen": constant pixel size — points and
   * anchored glyphs keep a constant radius/size around their projected anchor, and strokes
   * keep a constant pixel width about their world centerline. Applies to all geometry types.
   */
  sizeMode?: "world" | "screen";
}

/** A renderer for a Scene, implemented per target (WebGL / Canvas / SVG). */
export interface Backend {
  setLayers(layers: RenderLayer[]): void;
  updateLayer(name: string, layer: RenderLayer): void;
  /**
   * Append-only fast path (optional). Same observable result as
   * `updateLayer(name, layer)`, but a backend MAY upload only the tail of each
   * buffer — the drawables/vertices added at or after `addedFrom` (the drawable
   * index where the appended range begins). Backends that don't implement this are
   * driven via `updateLayer` (full re-upload). No backend implements it yet.
   */
  appendToLayer?(name: string, layer: RenderLayer, addedFrom: number): void;
  setTransform(t: ViewTransform): void;
  render(): void;
  toPNG(): string;
  toSVG(): string;
  destroy(): void;
}
