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

/** SoA for a batch of instanced circles (e.g. network nodes). Plain typed arrays. */
export interface InstancedCirclesData {
  /** [x, y] world coords per circle, length `2 * count`. */
  centers: Float32Array;
  /** radius per circle, length `count`. */
  radii: Float32Array;
  /** RGBA bytes per circle, length `4 * count`. */
  colors: Uint8Array;
  /**
   * Optional flow-border ring (#104 N6): per-circle thickness as a fraction of the radius
   * (`0`/absent ⇒ no ring, a plain filled disc), length `count`.
   */
  borders?: Float32Array;
  /** Optional RGBA ring colour bytes per circle, length `4 * count`. Paired with {@link borders}. */
  borderColors?: Uint8Array;
  count: number;
}

/** SoA for a batch of instanced lines (e.g. network links); straight, or bent via {@link bends}. */
export interface InstancedLinesData {
  /** [x, y] world source per line, length `2 * count`. */
  sources: Float32Array;
  /** [x, y] world target per line, length `2 * count`. */
  targets: Float32Array;
  /** width per line, length `count`. */
  widths: Float32Array;
  /** RGBA bytes per line, length `4 * count`. */
  colors: Uint8Array;
  /**
   * Optional per-line **bend** (#104 N6c): the quadratic-bezier control offset ⟂ to the chord, as a
   * fraction of chord length (`0`/absent ⇒ straight). Length `count`.
   */
  bends?: Float32Array;
  /**
   * Path samples (M) for the strip — `2` (straight, default) up to ~16–32 for a smooth bend. A draw
   * setting, not per-instance; bent layers raise it, straight layers keep `2` to stay cheap at scale.
   */
  samples?: number;
  count: number;
}

/** SoA for a batch of instanced triangle arrowheads (directed-link tips). */
export interface InstancedArrowsData {
  /** [x, y] source centre per arrow (for orientation), length `2 * count`. */
  sources: Float32Array;
  /** [x, y] target *centre* per arrow, length `2 * count`; the tip is set back by `radii` in-shader. */
  targets: Float32Array;
  /** Target node radius per arrow (active sizeMode units), length `count` — the boundary setback. */
  radii: Float32Array;
  /** arrow size (active sizeMode units) per arrow, length `count`. */
  sizes: Float32Array;
  /** RGBA bytes per arrow, length `4 * count`. */
  colors: Uint8Array;
  /** Optional per-arrow bend (#104 N6c), matching the link's, so the head aligns with the bent end tangent. */
  bends?: Float32Array;
  /** Draw a one-sided **half** arrowhead (#104 N6c) — for bent map links, so reciprocal heads don't collide. */
  half?: boolean;
  count: number;
}

/**
 * SoA for a batch of instanced **half-arrow** links (#104 N6) — the "map of networks" directed-link
 * glyph: one filled shape per link, pinched to the source centre and ending in a barbed arrowhead on
 * the target boundary, bowed around a shared centre curve (see network/half-link.ts). All world units.
 */
export interface InstancedHalfArrowsData {
  /** [x, y] world source centre per link, length `2 * count`. */
  sources: Float32Array;
  /** [x, y] world target centre per link, length `2 * count`. */
  targets: Float32Array;
  /** [r0, r1] source/target node radii per link, length `2 * count` (the tip lands on r1). */
  radii: Float32Array;
  /** [width, oppositeWidth] per link, length `2 * count` (opposite width spaces the source foot). */
  widths: Float32Array;
  /** Bend per link (absolute world-unit ⟂ offset; sign picks the bow side), length `count`. */
  bends: Float32Array;
  /** RGBA bytes per link, length `4 * count`. */
  colors: Uint8Array;
  /** Path samples (M) per bezier edge of the strip; a draw setting, not per-instance. Default 24. */
  samples?: number;
  count: number;
}

/** A named GPU-instanced primitive layer — the network rendering lane (#100). */
export type InstancedLayer =
  | { name: string; sizeMode?: "world" | "screen"; primitive: "circles"; circles: InstancedCirclesData }
  | { name: string; sizeMode?: "world" | "screen"; primitive: "lines"; lines: InstancedLinesData }
  | { name: string; sizeMode?: "world" | "screen"; primitive: "arrows"; arrows: InstancedArrowsData }
  | { name: string; sizeMode?: "world" | "screen"; primitive: "half-arrows"; halfArrows: InstancedHalfArrowsData };

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
   *
   * `drawables` may be omitted (`undefined`): the caller does this on a backend that doesn't
   * render from the vector view (see {@link stylesNeedDrawables}) to skip an O(n) rebuild on a
   * hot path (e.g. per-frame declutter). Such a backend must keep its previously-stored vector
   * view; consumers that read it (e.g. `toSVG`) may then lag the tables until the next update
   * that does pass `drawables`.
   */
  updateLayerStyles?(name: string, tables: StyleTables, drawables?: DrawableVector[]): void;
  /**
   * Whether {@link updateLayerStyles} actually *renders* from its `drawables` argument (Canvas
   * and SVG repaint from the vector view) vs. only stashing it for export (WebGL draws from the
   * GPU flag/color tables). When `false`, the engine may omit `drawables` on hot paths. Absent
   * ⇒ treated as `true` (safe default: always pass the vector view).
   */
  readonly stylesNeedDrawables?: boolean;
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
  /**
   * Register/replace a GPU-instanced primitive layer (the network rendering lane).
   * Optional — only the WebGL backend implements it; other backends omit it, so network
   * instanced rendering is WebGL-only (small-N / export go through the PathContext emitter).
   */
  setInstancedLayer?(layer: InstancedLayer): void;
  /**
   * Update an instanced layer in place when the primitive supports it (circles), or fall
   * back to destroy+recreate otherwise. Optional — only the WebGL backend implements it;
   * when absent, `emitInstancedLane` falls back to `setInstancedLayer`. Non-circles
   * primitives (lines/arrows/half-arrows) always recreate via `setInstancedLayer`.
   */
  updateInstancedLayer?(layer: InstancedLayer): void;
  /** Remove an instanced primitive layer by name. */
  removeInstancedLayer?(name: string): void;
  setTransform(t: ViewTransform): void;
  /**
   * Resize the rendering surface to a new CSS size (px). Re-reads the device pixel ratio
   * and reconciles the backing buffer / framebuffers; the engine re-pushes layers and
   * re-renders afterwards. A no-op when the size is unchanged.
   */
  resize(width: number, height: number): void;
  render(): void;
  toPNG(): string;
  toSVG(): string;
  destroy(): void;
}
