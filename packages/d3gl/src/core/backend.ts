import type { GroupBuffers, GroupBufferDelta, DrawableVector } from "./scene.js";

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

/**
 * An incremental append for one layer: only the drawables added at/after
 * `buffers.fromDrawable`. `buffers` are the delta GPU buffers (for WebGL), `drawables`
 * the matching new vector views (for Canvas/SVG draw-on-top). Index values in
 * `buffers` are group-absolute, so a backend whose buffers mirror the group appends
 * verbatim. `clipTo`/`sizeMode` mirror the layer's current settings.
 */
export interface RenderDelta {
  name: string;
  buffers: GroupBufferDelta;
  drawables: DrawableVector[];
  clipTo?: string;
  sizeMode?: "world" | "screen";
}

/** A renderer for a Scene, implemented per target (WebGL / Canvas / SVG). */
export interface Backend {
  setLayers(layers: RenderLayer[]): void;
  updateLayer(name: string, layer: RenderLayer): void;
  /**
   * Append-only fast path (optional). Same observable result as a full re-upload,
   * but the backend uploads/draws only the appended tail (`delta`) — O(new) instead
   * of O(total). Backends that don't implement it are driven via `updateLayer`
   * (full re-upload); the engine still calls `updateLayer` for non-append changes.
   */
  appendToLayer?(delta: RenderDelta): void;
  setTransform(t: ViewTransform): void;
  render(): void;
  toPNG(): string;
  toSVG(): string;
  destroy(): void;
}
