import type { GroupBuffers, GroupBufferDelta, DrawableVector, StyleTables } from "./scene.js";
import type { Subpath } from "./path-context.js";

/** Transient, GPU/Canvas-ready point data. Owned by no one — built per repaint and discarded. */
export interface PointBatch {
  /** [x, y] per point, in projected world coords (pre view-transform). */
  positions: Float32Array;
  /** radius (reference px) per point. */
  radii: Float32Array;
  /** RGBA bytes per point (4 per point), parallel to positions. */
  colors: Uint8Array;
  /** number of points actually packed (after culling). */
  count: number;
}

/** One projected path feature, ready to draw. Canvas draws natively; WebGL tessellates per frame. */
export interface ProjectedPath {
  subpaths: Subpath[];
  fill: [number, number, number, number] | null;   // RGBA bytes; null = no fill
  stroke: [number, number, number, number] | null; // RGBA bytes; null = no stroke
  lineWidth: number;                                // 0 = no stroke geometry
}

/** Generalized transient pass-through payload (built per repaint, discarded). */
export interface DrawBatch {
  points: PointBatch | null;
  paths: ProjectedPath[] | null;
}

/** What a PassThroughSpec yields per datum (generalizes the point-only project()). */
export type DrawItem =
  | { kind: "points"; centers: [number, number][]; radius: number; color: string }
  | { kind: "path"; subpaths: Subpath[]; fill: string | null; stroke: string | null; lineWidth: number };

/** Identifies a pass-through layer to a backend (no retained geometry). */
export interface PassThroughLayer {
  name: string;
  sizeMode?: "world" | "screen";
  clipTo?: string;
}

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
   * Styles-only fast path (optional): the per-drawable color/flag tables changed but
   * geometry did not (recolor / dim / show-hide). `drawables` is the refreshed vector
   * view (same drawables, same order) so vector-reading consumers (Canvas redraw, SVG
   * serialize, toSVG export) stay in sync with the raster output. Backends without it
   * are driven through `updateLayer` (full re-upload).
   */
  updateLayerStyles?(name: string, tables: StyleTables, drawables: DrawableVector[]): void;
  /**
   * Append-only fast path (optional). Same observable result as a full re-upload,
   * but the backend uploads/draws only the appended tail (`delta`) — O(new) instead
   * of O(total). Backends that don't implement it are driven via `updateLayer`
   * (full re-upload); the engine still calls `updateLayer` for non-append changes.
   */
  appendToLayer?(delta: RenderDelta): void;
  /** Register/replace a pass-through layer (no buffers). Backends opt in. */
  setPassThroughLayer?(layer: PassThroughLayer): void;
  /** Remove a pass-through layer. */
  removePassThroughLayer?(name: string): void;
  /**
   * Draw a batch into the layer's accumulation buffer.
   * `mode: "replace-first"` clears the layer's buffer first (start of a full repaint),
   * `"replace-rest"` continues a chunked full repaint without clearing,
   * `"append"` draws on top (incremental).
   */
  drawPassThrough?(name: string, batch: DrawBatch, mode: "replace-first" | "replace-rest" | "append"): void;
  /** Snapshot current accumulation for snapshot-pan (called on interaction start). */
  snapshotPassThrough?(): void;
  /** True if this backend supports pass-through (canvas/webgl yes, svg no). */
  readonly supportsPassThrough?: boolean;
  setTransform(t: ViewTransform): void;
  render(): void;
  toPNG(): string;
  toSVG(): string;
  destroy(): void;
}
