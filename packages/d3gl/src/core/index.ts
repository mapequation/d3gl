/**
 * The backend-agnostic scene model: a retained {@link Scene} that records vector
 * geometry through a {@link PathContext}, flattens curves, groups rings, tessellates
 * fills, expands strokes, and packs everything into GPU-ready buffers with per-drawable
 * color/flag side-tables. {@link HitIndex} provides CPU hit-testing over the same data.
 *
 * ```ts
 * import { Scene } from "@mapequation/d3gl";
 *
 * const scene = new Scene(0.5);
 * scene.group("shapes", (g) => g.drawable("a", (ctx) => { ctx.rect(0, 0, 10, 10); }));
 * scene.setFill("shapes", "a", "#3366cc");
 * const buffers = scene.buffers("shapes"); // GPU-ready typed arrays
 * ```
 *
 * @packageDocumentation
 */
export type { PathContext, Subpath } from "./path-context.js";
export { PathRecorder } from "./path-recorder.js";
export { flattenCubic, flattenQuadratic, flattenArc } from "./flatten.js";
export { tessellateFill } from "./tessellate.js";
export type { FillGeometry } from "./tessellate.js";
export { signedArea, pointInRing, groupRings } from "./rings.js";
export type { RingGroup } from "./rings.js";
export { expandStroke, DEFAULT_MITER_LIMIT } from "./stroke.js";
export type { StrokeGeometry, StrokeOptions, LineJoin, LineCap } from "./stroke.js";
export { Scene } from "./scene.js";
export type { GroupBuffers, GroupBufferDelta, GroupBuilder, DrawableRange, DrawableOpts, DrawableVector, StyleTables } from "./scene.js";
export type { Backend, RenderLayer, RenderDelta, ViewTransform, PointBatch, PassThroughLayer, DrawBatch, ProjectedPath, DrawItem, InstancedLayer, InstancedCirclesData, InstancedLinesData } from "./backend.js";
export { HitIndex } from "./hit-test.js";
export { version } from "./version.js";
