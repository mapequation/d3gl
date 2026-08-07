import { PathRecorder } from "./path-recorder.js";
import { groupRings } from "./rings.js";
import { tessellateFill } from "./tessellate.js";
import { expandStroke, DEFAULT_MITER_LIMIT, type LineJoin, type LineCap } from "./stroke.js";
import { rgb } from "d3-color";
import type { Subpath } from "./path-context.js";

/**
 * Contiguous slice a drawable occupies within a group's shared buffers.
 *
 * A drawable may legitimately have an empty fill or stroke (e.g. an open polyline
 * has no fill): in that case `vertexCount`/`indexCount` are 0 and `*Offset` is the
 * cursor at the time of registration. Consumers must treat `indexCount === 0` as
 * "nothing to draw" and skip it — never issue a draw over `[offset, offset)`.
 */
export interface DrawableRange {
  fill: { vertexOffset: number; vertexCount: number; indexOffset: number; indexCount: number };
  stroke: { vertexOffset: number; vertexCount: number; indexOffset: number; indexCount: number };
}

/**
 * GPU-ready typed arrays for one group. Vertices are [x, y, drawableId].
 *
 * `drawableId` is stored as a Float32 component and indexes the per-drawable
 * side-tables (`fillColors`/`strokeColors`/`flags`). Float32 represents integers
 * exactly only up to 2^24 (~16.7M), which caps the number of drawables per group;
 * far above realistic use, but the shader's integer cast of this component would
 * silently break past that ceiling.
 *
 * SHARING (#207): every array except `pointCenters` is a LIVE subarray view of the
 * Scene's typed storage — NOT a detached copy. Consumers must not mutate them, and
 * must not assume snapshot semantics: a later restyle (`setFill`/`setFlag`) is
 * visible through the views, and an append to the group makes them stale (the
 * drawable set change always reaches a backend as a fresh `setLayers`/`updateLayer`/
 * `appendToLayer` call, so a consumer that re-reads on those events never observes
 * staleness). `pointCenters` interleaves per-circle data with the drawableId, so it
 * cannot be a subarray view — it is assembled once per drawable set and then RETAINED
 * and shared (#280), under the same read-only contract.
 */
export interface GroupBuffers {
  fillVertices: Float32Array;
  fillIndices: Uint32Array;
  strokeVertices: Float32Array;
  strokeIndices: Uint32Array;
  /** RGBA bytes per drawable, indexed by drawableId. */
  fillColors: Uint8Array;
  strokeColors: Uint8Array;
  /** One byte of flags per drawable (bit 0 = visible). */
  flags: Uint8Array;
  drawableCount: number;
  /** Stride-4 float array: [x, y, radius, drawableId] per circle. */
  pointCenters: Float32Array;
  /** Total number of circles across all drawables. */
  pointCount: number;
  /** Per-fill-vertex anchor [x, y] (parallel to fillVertices) for screen sizeMode. */
  fillAnchors: Float32Array;
  /** Per-stroke-vertex anchor [x, y] (parallel to strokeVertices) for screen sizeMode. */
  strokeAnchors: Float32Array;
  /** Per-drawable fill/stroke vertex+index slices, in drawable (paint) order. Lets a
   *  backend interleave fill and stroke per drawable (painter's order) rather than
   *  drawing all fills then all strokes. Offsets are absolute into the arrays above. */
  ranges: DrawableRange[];
}

/**
 * Buffers for an appended TAIL of a group (see {@link Scene.appendedBuffers}).
 * Same arrays as {@link GroupBuffers} but each holds only the newly-appended data;
 * index values are group-absolute. `drawableCount` is the total after the append,
 * `fromDrawable` the index where the new range begins. Point count = pointCenters/4.
 *
 * Like {@link GroupBuffers}, the arrays (except `pointCenters`) are live tail VIEWS of
 * the Scene's typed storage — computed in O(1), consumed synchronously by the backend's
 * append path, and not to be mutated or retained.
 */
export interface GroupBufferDelta {
  fillVertices: Float32Array;
  fillIndices: Uint32Array;
  strokeVertices: Float32Array;
  strokeIndices: Uint32Array;
  fillColors: Uint8Array;
  strokeColors: Uint8Array;
  flags: Uint8Array;
  pointCenters: Float32Array;
  fillAnchors: Float32Array;
  strokeAnchors: Float32Array;
  drawableCount: number;
  fromDrawable: number;
  /** Per-drawable ranges for the appended drawables only (offsets absolute into the
   *  full group arrays, matching the group-absolute index values). See {@link GroupBuffers.ranges}. */
  ranges: DrawableRange[];
}

/** Just the per-drawable style tables (colors + flags), for styles-only backend
 *  updates — never the O(total-vertices) {@link Scene.buffers} rebuild: geometry
 *  hasn't changed, only how it's painted. LIVE views of the Scene's typed storage
 *  (#207) — zero copies/allocation per call; see {@link Scene.styleTables}. */
export interface StyleTables {
  fillColors: Uint8Array;
  strokeColors: Uint8Array;
  flags: Uint8Array;
}

export interface DrawableOpts {
  /** Stroke width in coordinate units. 0/undefined => no stroke geometry. */
  lineWidth?: number;
  /** Stroke join style ("bevel" default | "miter" | "round") — see {@link LineJoin}. */
  lineJoin?: LineJoin;
  /** Miter length / width above which a miter falls back to a bevel (default 10). */
  miterLimit?: number;
  /** End-cap style for open subpaths ("butt" default | "square" | "round"). */
  lineCap?: LineCap;
  /**
   * Optional glyph anchor in world coordinates. When set, in "screen" sizeMode the whole
   * drawable (fill + stroke) is rendered at a constant pixel size around the projected
   * anchor (e.g. a pie or symbol pinned to a node). When unset, fills stay in world space
   * and strokes render at a constant pixel *width* about their own centerline.
   */
  anchor?: [number, number];
}

export interface GroupBuilder {
  drawable(id: string | number, draw: (ctx: PathRecorder) => void, opts?: DrawableOpts): void;
  /**
   * A single circle at (x, y) with the given radius (reference px), filled and — when
   * `lineWidth > 0` — stroked on that radius, i.e. covering `[radius − w/2, radius + w/2]`
   * in the stroke colour. That is the **ring encoding** for a bordered glyph (a disc with a
   * border of thickness `w` inside outer radius `R` is `radius = R − w/2`, `lineWidth = w`),
   * the exact vector equivalent of what the instanced-circle fragment shader paints — and
   * unlike two stacked discs it composites each region ONCE, so a translucent fill keeps its
   * ring (#269). `points()` (GeoJSON MultiPoint) has no ring semantics and stays fill-only.
   */
  point(id: string | number, x: number, y: number, radius: number, lineWidth?: number): void;
  /** Multiple circles (one drawable, e.g. a GeoJSON MultiPoint). */
  points(id: string | number, centers: readonly [number, number][], radius: number): void;
}

// ---------------------------------------------------------------------------
// Typed grow-on-append storage (#207)
//
// Per-drawable tables and vertex data used to live in boxed number[]s (~8 B per
// element plus per-array overhead) that buffers()/styleTables() copied into fresh
// typed arrays on demand — at 1M drawables the boxed colour/flag tables alone cost
// ~70 MB for data that is ~9 MB typed, and the geometry was retained twice. These
// stores keep the data typed from the start: amortized-doubling capacity, a logical
// length, and cached subarray views handed out by reference.
// ---------------------------------------------------------------------------

/**
 * Amortized-doubling typed store. Hot append loops call {@link reserve} once for the
 * batch and then write `a[n++]` directly (no per-element method call); `view()` hands
 * out the used range as a cached subarray — the SAME instance until the length changes,
 * so per-frame readers get zero allocation.
 *
 * Invariant: cells at/past `n` are always zero (allocation zero-fills; reallocation
 * copies; writers stay below `n`) — {@link extend} relies on it for zero-valued columns.
 */
abstract class Grow<A extends Float32Array | Uint8Array | Uint32Array> {
  /** Backing store, `capacity >= n` elements. Index directly only below {@link n}
   *  (or into cells claimed via {@link reserve} + `n++`). */
  a: A;
  /** Logical length (elements in use). */
  n = 0;
  private cached: A | null = null;
  constructor(capacity = 16) {
    this.a = this.alloc(capacity);
  }
  protected abstract alloc(len: number): A;
  protected abstract sub(start: number, end: number): A;
  /** Ensure capacity for `extra` more elements (doubling; contents kept). */
  reserve(extra: number): void {
    const need = this.n + extra;
    if (need <= this.a.length) return;
    let cap = Math.max(16, this.a.length * 2);
    while (cap < need) cap *= 2;
    const next = this.alloc(cap);
    next.set(this.a);
    this.a = next;
    this.cached = null; // a cached view aliases the OLD buffer; drop it
  }
  push(v: number): void {
    this.reserve(1);
    this.a[this.n++] = v;
  }
  /** Claim `count` zero-valued cells (see the class invariant). */
  extend(count: number): void {
    this.reserve(count);
    this.n += count;
  }
  /** A live subarray view of the used range `[0, n)` — the SAME instance across calls
   *  until the length changes (append), so per-frame callers allocate nothing. NOT a
   *  snapshot: in-place writers (setFill/setFlag/…) are visible through it. */
  view(): A {
    let v = this.cached;
    if (!v || v.length !== this.n) {
      v = this.sub(0, this.n);
      this.cached = v;
    }
    return v;
  }
  /** A live subarray view of `[start, n)` — the appended-tail slice, O(1). */
  tail(start: number): A {
    return this.sub(Math.min(start, this.n), this.n);
  }
}

class GrowF32 extends Grow<Float32Array> {
  protected alloc(len: number): Float32Array {
    return new Float32Array(len);
  }
  protected sub(start: number, end: number): Float32Array {
    return this.a.subarray(start, end);
  }
}

class GrowU8 extends Grow<Uint8Array> {
  protected alloc(len: number): Uint8Array {
    return new Uint8Array(len);
  }
  protected sub(start: number, end: number): Uint8Array {
    return this.a.subarray(start, end);
  }
}

class GrowU32 extends Grow<Uint32Array> {
  protected alloc(len: number): Uint32Array {
    return new Uint32Array(len);
  }
  protected sub(start: number, end: number): Uint32Array {
    return this.a.subarray(start, end);
  }
}

/** Join/cap styles by column code (index 0 = the default, stored implicitly while the
 *  column is omitted). */
const JOIN_NAMES: readonly LineJoin[] = ["bevel", "miter", "round"];
const CAP_NAMES: readonly LineCap[] = ["butt", "square", "round"];

/**
 * Push a join/cap code onto a lazily-allocated column: the column stays null (omitted —
 * zero bytes) while every drawable uses the default (code 0), and is allocated + zero-
 * backfilled for the `count` drawables already registered when the first non-default
 * value arrives. Returns the (possibly newly created) column.
 */
function pushCode(column: GrowU8 | null, code: number, count: number): GrowU8 | null {
  if (!column) {
    if (code === 0) return null;
    column = new GrowU8();
    column.extend(count); // zero-filled = the default code
  }
  column.push(code);
  return column;
}

/** Same lazy-column scheme for miter limits (default {@link DEFAULT_MITER_LIMIT}). */
function pushLimit(column: GrowF32 | null, v: number, count: number): GrowF32 | null {
  if (!column) {
    if (v === DEFAULT_MITER_LIMIT) return null;
    column = new GrowF32();
    column.reserve(count + 1);
    column.a.fill(DEFAULT_MITER_LIMIT, 0, count);
    column.n = count;
  }
  column.push(v);
  return column;
}

/** Shared per-drawable defaults for the vector view: path drawables have no circles and
 *  point drawables no subpaths, so every such drawable aliases ONE empty array instead
 *  of allocating its own (1M path drawables used to allocate 1M empty arrays, #207).
 *  Vector-view consumers treat drawables as read-only (audited: Canvas/SVG/hit-test/
 *  highlight only iterate) — never push into these. */
const EMPTY_CIRCLES: { x: number; y: number; r: number }[] = [];
const EMPTY_SUBPATHS: Subpath[] = [];

/**
 * Mutable accumulation for one group while building / before buffer assembly.
 *
 * Storage is typed (#207): per-drawable tables and vertex data live in grow-on-append
 * typed stores, and {@link Scene.buffers}/{@link Scene.styleTables}/{@link Scene.flagsView}
 * hand out live views of them (no copies). Rarely-customized columns (`joins`/`caps`/
 * `miterLimits`) are omitted (null) while every drawable uses the default. `circles` is
 * null-sparse: path drawables store null instead of an own empty array. `anchors`,
 * `circles` and `subpaths` stay boxed ON PURPOSE: the vector view shares those objects
 * by reference, so a typed column would ADD memory (typed column + per-view objects)
 * whenever a vector view is materialized — which the engine always does — not save it.
 */
class GroupData {
  /** [x, y, drawableId] per vertex. Float32 from the start: buffers() always uploaded
   *  Float32, so nothing downstream ever saw more precision. */
  fillVerts = new GrowF32();
  fillIdx = new GrowU32();
  strokeVerts = new GrowF32();
  strokeIdx = new GrowU32();
  ranges: DrawableRange[] = [];
  // Keyed by the raw id (string OR number) — NOT String(id) — so numeric-id layers
  // don't allocate a string per drawable (millions, for streamed data). A layer uses
  // one id type, so 1 vs "1" collisions aren't a real concern.
  idToDrawable = new Map<string | number, number>();
  fillColors = new GrowU8(); // flat RGBA, 4 per drawable
  strokeColors = new GrowU8();
  /** One byte per drawable (bit 0 = visible) — THE storage: {@link Scene.flagsView},
   *  {@link Scene.styleTables} and {@link Scene.buffers} alias it directly (#208's
   *  interim mirror became the primary storage here, as planned). */
  flags = new GrowU8();
  subpaths: Subpath[][] = [];
  ids: (string | number)[] = [];
  lineWidths = new GrowF32();
  /** Per-drawable glyph anchor (null = none), for screen sizeMode. Boxed — shared by
   *  reference with the vector view (see the class doc). */
  anchors: ([number, number] | null)[] = [];
  /** Per-fill-vertex / per-stroke-vertex anchors (flat x,y), parallel to the vertex arrays. */
  fillAnchors = new GrowF32();
  strokeAnchors = new GrowF32();
  /** Circle centers per drawable — null for path drawables (no empty array each, #207).
   *  Boxed — shared by reference with the vector view (see the class doc). */
  circles: ({ x: number; y: number; r: number }[] | null)[] = [];
  /** Total circles across all drawables (sizes pointCenters assembly in one pass). */
  circleCount = 0;
  /** Per-drawable stroke join/cap codes (index into JOIN_NAMES/CAP_NAMES) and miter
   *  limits — null while every drawable uses the default (the common case: whole
   *  layers share one join/cap style, so the columns usually cost zero bytes). */
  joins: GrowU8 | null = null;
  caps: GrowU8 | null = null;
  miterLimits: GrowF32 | null = null;
  /** Cached transform-independent declutter index (built lazily; null ⇒ stale/never built).
   *  Invalidated whenever the group's drawable set changes (rebuild or append). */
  declutterIndex: DeclutterIndex | null = null;
  /**
   * Retained vector view (#280) — the array {@link Scene.drawables} hands out, built once per
   * drawable set and then reused. `null` ⇒ never built, or the drawable set changed.
   *
   * Costs no extra retained memory: every backend already holds the array it was pushed
   * (`CanvasBackend.layers`, `SvgBackend.layers`, `WebGLBackend.layers`) for the layer's
   * lifetime, so this is the SAME array shared rather than a fresh copy per push.
   */
  vectors: DrawableVector[] | null = null;
  /** Bumped by every per-drawable style write (setFill/setStroke/setFlag/writeDeclutterFlags).
   *  O(1) per write — {@link writeDeclutterFlags} bumps once for the whole pass, so the
   *  per-frame declutter path gains a single increment, not a per-drawable one. */
  styleEpoch = 0;
  /** The {@link styleEpoch} {@link vectors} were last synced at (-1 ⇒ never). */
  vectorsEpoch = -1;
  /** Cached stride-4 [x, y, r, drawableId] point centers (#280). Geometry-only — no style
   *  lives in it — so only a drawable-set change can stale it. Like {@link vectors} it is
   *  already retained downstream (every backend keeps the `GroupBuffers` it was handed). */
  pointCenters: Float32Array | null = null;
  constructor(public readonly tolerance: number) {}
}

/**
 * Transform-independent view of a group's anchors for screen-space declutter, built once and
 * reused across zoom frames. `ax`/`ay` are the *unique* anchor positions in first-seen (input)
 * order — drawables sharing an exact anchor (e.g. a pie's wedges) collapse to one entry so they
 * cull as a unit. `groupOf[i]` is the index into `ax`/`ay` for drawable `i`, or -1 when it has
 * no anchor (never deduplicated, always kept).
 */
export interface DeclutterIndex {
  ax: Float64Array;
  ay: Float64Array;
  groupOf: Int32Array;
}

export interface DrawableVector {
  id: string | number;
  subpaths: Subpath[];
  fill: [number, number, number, number];
  stroke: [number, number, number, number];
  lineWidth: number;
  /** Stroke join style + miter limit + end cap (so Canvas/SVG match the WebGL stroke geometry). */
  lineJoin: LineJoin;
  miterLimit: number;
  lineCap: LineCap;
  flags: number;
  circles: { x: number; y: number; r: number }[];
  /** Glyph anchor in world coords (null = none); used by backends for screen sizeMode. */
  anchor: [number, number] | null;
}

export class Scene {
  private groups = new Map<string, GroupData>();

  constructor(private readonly tolerance = 0.25) {}

  /** Build (or rebuild) a named group. The callback registers drawables. */
  group(name: string, build: (g: GroupBuilder) => void): void {
    const data = new GroupData(this.tolerance);
    build(this.builderFor(data));
    this.groups.set(name, data);
  }

  /** Drop a group entirely (vs an empty re-{@link group}, which keeps a zero-drawable entry). */
  remove(name: string): void {
    this.groups.delete(name);
  }

  /** Append more drawables to an existing group (vs group(), which replaces it).
   *  New drawables' integer drawableIds continue after the existing ones; a
   *  duplicate domain id (the caller's string/number id) throws. NOTE: not atomic
   *  across a multi-drawable build — if a later drawable in the batch throws, earlier
   *  ones are already committed. Callers needing all-or-nothing (the engine append
   *  path) validate ids before calling. */
  appendToGroup(name: string, build: (g: GroupBuilder) => void): void {
    const data = this.get(name);
    build(this.builderFor(data));
    // The drawable set grew: every cache keyed on it is now stale.
    data.declutterIndex = null;
    // DROP the retained vector view rather than extending it (#280). The append path hands the
    // backend only the TAIL (`drawables(name, from)`) and Canvas grows its own stored array with
    // it — extending this one too would double-count those drawables in the array Canvas holds.
    // Dropping it hands ownership of the old array to the backend; the next full drawables()
    // builds a fresh one. Appends never go through pushLayers(), so nothing re-materializes here.
    data.vectors = null;
    data.pointCenters = null;
  }

  /** Number of drawables currently registered in a group. */
  drawableCount(name: string): number {
    return this.get(name).ranges.length;
  }

  private builderFor(data: GroupData): GroupBuilder {
    return {
      drawable: (id, draw, opts) => this.addDrawable(data, id, draw, opts),
      point: (id, x, y, radius, lineWidth) => this.addCircleDrawable(data, id, [[x, y]], radius, lineWidth),
      points: (id, centers, radius) => this.addCircleDrawable(data, id, centers, radius),
    };
  }

  private addDrawable(
    data: GroupData,
    id: string | number,
    draw: (ctx: PathRecorder) => void,
    opts?: DrawableOpts,
  ): void {
    if (data.idToDrawable.has(id)) throw new Error(`duplicate drawable id: ${String(id)}`);
    const recorder = new PathRecorder(data.tolerance);
    draw(recorder);
    const subpaths = recorder.subpaths;
    const drawableId = data.ranges.length;
    data.idToDrawable.set(id, drawableId);
    data.subpaths.push(subpaths.map((s) => ({ closed: s.closed, points: s.points.slice() })));
    data.ids.push(id);
    data.lineWidths.push(opts?.lineWidth ?? 0);
    const join: LineJoin = opts?.lineJoin ?? "bevel";
    const miterLimit = opts?.miterLimit ?? DEFAULT_MITER_LIMIT;
    const cap: LineCap = opts?.lineCap ?? "butt";
    data.joins = pushCode(data.joins, JOIN_NAMES.indexOf(join), drawableId);
    data.caps = pushCode(data.caps, CAP_NAMES.indexOf(cap), drawableId);
    data.miterLimits = pushLimit(data.miterLimits, miterLimit, drawableId);
    const anchor = opts?.anchor ?? null;
    data.anchors.push(anchor);

    // ---- Fill ----
    const fv = data.fillVerts, fa = data.fillAnchors, fi = data.fillIdx;
    const fillVertexOffset = fv.n / 3;
    const fillIndexOffset = fi.n;
    const closed = subpaths.filter((s) => s.closed && s.points.length >= 6);
    if (closed.length > 0) {
      const rings = groupRings(closed);
      const polygons = rings.map((r) => r.outer);
      const holes = rings.map((r) => r.holes);
      const fg = tessellateFill(polygons, holes);
      const baseVertex = fv.n / 3;
      fv.reserve((fg.vertices.length / 2) * 3);
      fa.reserve(fg.vertices.length);
      for (let i = 0; i < fg.vertices.length; i += 2) {
        const x = fg.vertices[i]!, y = fg.vertices[i + 1]!;
        fv.a[fv.n++] = x;
        fv.a[fv.n++] = y;
        fv.a[fv.n++] = drawableId;
        // Anchor at the glyph center if given, else at the vertex itself (offset 0 ⇒ stays world).
        fa.a[fa.n++] = anchor ? anchor[0] : x;
        fa.a[fa.n++] = anchor ? anchor[1] : y;
      }
      fi.reserve(fg.indices.length);
      for (const ix of fg.indices) fi.a[fi.n++] = baseVertex + ix;
    }
    const fillVertexCount = fv.n / 3 - fillVertexOffset;
    const fillIndexCount = fi.n - fillIndexOffset;

    // ---- Stroke ----
    const sv = data.strokeVerts, sa = data.strokeAnchors, si = data.strokeIdx;
    const strokeVertexOffset = sv.n / 3;
    const strokeIndexOffset = si.n;
    const lineWidth = opts?.lineWidth ?? 0;
    if (lineWidth > 0) {
      for (const sp of subpaths) {
        const sg = expandStroke(sp, lineWidth, { join, miterLimit, cap });
        const baseVertex = sv.n / 3;
        sv.reserve((sg.vertices.length / 2) * 3);
        sa.reserve(sg.vertices.length);
        for (let i = 0; i < sg.vertices.length; i += 2) {
          sv.a[sv.n++] = sg.vertices[i]!;
          sv.a[sv.n++] = sg.vertices[i + 1]!;
          sv.a[sv.n++] = drawableId;
          // Glyph: anchor at the center (whole outline scales). Else: per-vertex centerline
          // anchor (constant-width stroke about its own line).
          sa.a[sa.n++] = anchor ? anchor[0] : sg.anchors[i]!;
          sa.a[sa.n++] = anchor ? anchor[1] : sg.anchors[i + 1]!;
        }
        si.reserve(sg.indices.length);
        for (const ix of sg.indices) si.a[si.n++] = baseVertex + ix;
      }
    }
    const strokeVertexCount = sv.n / 3 - strokeVertexOffset;
    const strokeIndexCount = si.n - strokeIndexOffset;

    data.ranges.push({
      fill: {
        vertexOffset: fillVertexOffset,
        vertexCount: fillVertexCount,
        indexOffset: fillIndexOffset,
        indexCount: fillIndexCount,
      },
      stroke: {
        vertexOffset: strokeVertexOffset,
        vertexCount: strokeVertexCount,
        indexOffset: strokeIndexOffset,
        indexCount: strokeIndexCount,
      },
    });
    // Defaults: transparent colors (zero bytes — see the Grow invariant), visible flag (bit 0).
    data.fillColors.extend(4);
    data.strokeColors.extend(4);
    data.flags.push(1);
    // Path drawables have no circle geometry (null-sparse; the vector view substitutes
    // the shared EMPTY_CIRCLES).
    data.circles.push(null);
  }

  private addCircleDrawable(
    data: GroupData,
    id: string | number,
    centers: readonly [number, number][],
    r: number,
    lineWidth = 0,
  ): void {
    if (data.idToDrawable.has(id)) throw new Error(`duplicate drawable id: ${String(id)}`);
    const drawableId = data.ranges.length;
    data.idToDrawable.set(id, drawableId);
    data.subpaths.push(EMPTY_SUBPATHS);
    data.circles.push(centers.map(([x, y]) => ({ x, y, r })));
    data.circleCount += centers.length;
    data.ids.push(id);
    // A circle drawable carries its stroke ANALYTICALLY (Canvas `ctx.stroke()` after `arc()`,
    // SVG `<circle stroke-width>`) — there is no tessellated stroke range, so the ring costs
    // zero extra geometry. NOTE: the WebGL *Scene* point pass draws the fill disc only and
    // ignores this width (#276); the network — the only ring producer — renders its glyphs
    // through the WebGL *instanced* lane, which paints the ring in-shader.
    data.lineWidths.push(lineWidth);
    data.joins = pushCode(data.joins, 0, drawableId);
    data.caps = pushCode(data.caps, 0, drawableId);
    data.miterLimits = pushLimit(data.miterLimits, DEFAULT_MITER_LIMIT, drawableId);
    // A lone point carries its center as the glyph anchor, so screen-space declutter can act on
    // analytic points (rendering reads `pointCenters`, and screen-mode hit-testing already used
    // the lone center as its anchor — so this only newly enables declutter, nothing else changes).
    // A MultiPoint has no single anchor.
    data.anchors.push(centers.length === 1 ? [centers[0]![0], centers[0]![1]] : null);
    // Zero fill+stroke range to keep ranges index-aligned with drawableId.
    const fillVertexOffset = data.fillVerts.n / 3;
    const strokeVertexOffset = data.strokeVerts.n / 3;
    data.ranges.push({
      fill: { vertexOffset: fillVertexOffset, vertexCount: 0, indexOffset: data.fillIdx.n, indexCount: 0 },
      stroke: { vertexOffset: strokeVertexOffset, vertexCount: 0, indexOffset: data.strokeIdx.n, indexCount: 0 },
    });
    // Defaults: transparent colors (zero bytes), visible flag (bit 0).
    data.fillColors.extend(4);
    data.strokeColors.extend(4);
    data.flags.push(1);
  }

  private get(name: string): GroupData {
    const data = this.groups.get(name);
    if (!data) throw new Error(`unknown group: ${name}`);
    return data;
  }

  /** The contiguous buffer slice a drawable occupies. */
  range(name: string, id: string | number): DrawableRange {
    const data = this.get(name);
    const drawableId = data.idToDrawable.get(id);
    if (drawableId === undefined) throw new Error(`unknown drawable: ${String(id)}`);
    return data.ranges[drawableId]!;
  }

  /** Resolve a group + domain id to its drawableId, or throw. */
  private drawableIdOf(name: string, id: string | number): { data: GroupData; drawableId: number } {
    const data = this.get(name);
    const drawableId = data.idToDrawable.get(id);
    if (drawableId === undefined) throw new Error(`unknown drawable: ${String(id)}`);
    return { data, drawableId };
  }

  /** Set a drawable's fill color (any CSS color string). Hot-swappable. */
  setFill(name: string, id: string | number, color: string): void {
    const { data, drawableId } = this.drawableIdOf(name, id);
    writeColor(data.fillColors.a, drawableId, color);
    data.styleEpoch++; // the retained vector view now lags the tables (#280)
  }

  /** Set a drawable's stroke color (any CSS color string). Hot-swappable. */
  setStroke(name: string, id: string | number, color: string): void {
    const { data, drawableId } = this.drawableIdOf(name, id);
    writeColor(data.strokeColors.a, drawableId, color);
    data.styleEpoch++;
  }

  /** Set a drawable's flag byte (e.g. bit 0 = visible). Hot-swappable. Writes the typed
   *  storage directly, so any {@link flagsView}/{@link styleTables} view sees it. */
  setFlag(name: string, id: string | number, flags: number): void {
    const { data, drawableId } = this.drawableIdOf(name, id);
    data.flags.a[drawableId] = flags & 0xff;
    data.styleEpoch++;
  }

  /**
   * The {@link DeclutterIndex} for a group — the transform-independent anchor grouping used by
   * screen-space declutter. Built once and cached on the group; the per-frame caller projects
   * `ax`/`ay` to screen and bins them, so the (string-keyed) grouping never re-runs on a zoom.
   * Invalidated automatically when the group is rebuilt ({@link group}) or appended to
   * ({@link appendToGroup}).
   */
  declutterIndex(name: string): DeclutterIndex {
    const data = this.get(name);
    if (data.declutterIndex) return data.declutterIndex;
    const n = data.anchors.length;
    const groupOf = new Int32Array(n);
    const keyToGroup = new Map<string, number>();
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = data.anchors[i];
      if (!a) { groupOf[i] = -1; continue; } // no anchor ⇒ never deduplicated, always kept
      const key = `${a[0]},${a[1]}`;
      let g = keyToGroup.get(key);
      if (g === undefined) { g = xs.length; keyToGroup.set(key, g); xs.push(a[0]); ys.push(a[1]); }
      groupOf[i] = g;
    }
    const idx: DeclutterIndex = { ax: Float64Array.from(xs), ay: Float64Array.from(ys), groupOf };
    data.declutterIndex = idx;
    return idx;
  }

  /**
   * Apply a per-anchor-group visibility verdict (1 = keep, 0 = hide) to the flag bytes, in
   * place — one linear pass over the cached {@link DeclutterIndex}, with no per-id Map lookups.
   * Drawables with no anchor (`groupOf` = -1) always stay visible. `visibleByGroup` is indexed
   * by the same group index as `ax`/`ay`. Writes the typed flags storage directly — the
   * {@link flagsView} the per-frame path hands to backends aliases it (#208).
   */
  writeDeclutterFlags(name: string, visibleByGroup: Uint8Array): void {
    const data = this.get(name);
    const { groupOf } = data.declutterIndex ?? this.declutterIndex(name);
    const flags = data.flags.a;
    const n = data.flags.n;
    for (let i = 0; i < n; i++) {
      const g = groupOf[i]!;
      flags[i] = g < 0 || visibleByGroup[g] ? 1 : 0;
    }
    // ONE increment for the whole pass (#280) — this is the per-frame declutter path, so the
    // retained vector view is marked out-of-date here and re-synced lazily, only if and when a
    // (non-per-frame) caller actually asks for it. Patching the vectors here instead would put
    // an O(drawables) object-write loop on every zoom frame, which is exactly what the WebGL
    // flags-only path (#208) exists to avoid.
    data.styleEpoch++;
  }

  /**
   * A LIVE typed view of a group's per-drawable flag bytes (bit 0 = visible): the SAME
   * `Uint8Array` instance across calls — zero per-call allocation — aliasing the Scene's
   * typed flags storage directly (#207 made #208's mirror the primary storage), so the
   * flag writers ({@link setFlag}, {@link writeDeclutterFlags}) are visible through it
   * with no double-write. Replaced only when the drawable set changes (append grows it;
   * a group rebuild replaces it). This is what the flags-only per-frame path (#208)
   * passes by reference to `Backend.updateLayerFlags`, instead of the
   * O(9·drawableCount)-bytes {@link styleTables} snapshot. Callers must treat it as
   * read-only and must not retain it across drawable-set changes.
   */
  flagsView(name: string): Uint8Array {
    return this.get(name).flags.view();
  }

  /** Build the vector view of one drawable at index `i` (shared by drawables()/drawableOf()). */
  private vectorAt(data: GroupData, i: number): DrawableVector {
    const fc = data.fillColors.a, sc = data.strokeColors.a, o = i * 4;
    return {
      id: data.ids[i]!,
      subpaths: data.subpaths[i]!,
      fill: [fc[o]!, fc[o + 1]!, fc[o + 2]!, fc[o + 3]!],
      stroke: [sc[o]!, sc[o + 1]!, sc[o + 2]!, sc[o + 3]!],
      lineWidth: data.lineWidths.a[i]!,
      lineJoin: data.joins ? JOIN_NAMES[data.joins.a[i]!]! : "bevel",
      miterLimit: data.miterLimits ? data.miterLimits.a[i]! : DEFAULT_MITER_LIMIT,
      lineCap: data.caps ? CAP_NAMES[data.caps.a[i]!]! : "butt",
      flags: data.flags.a[i]!,
      circles: data.circles[i] ?? EMPTY_CIRCLES,
      anchor: data.anchors[i]!,
    };
  }

  /**
   * The vector view of a group's drawables — a **retained** array, built once per drawable set
   * and handed out by reference thereafter (#280).
   *
   * This used to materialize one fresh `DrawableVector` (plus two colour tuples) per drawable on
   * every call — ~0.16 µs and ~320 B each, measured at 200k — and `BaseEngine.pushLayers()` calls
   * it for every layer on every push (each `registerLayer`, `removeLayer`, `setClip`, backend
   * install, and both boundaries of a gesture on a `hideOnInteraction` map). At 1M drawables that
   * was ~160 ms and ~320 MB of short-lived garbage *per push*, before any backend saw the result.
   *
   * Retaining it costs no extra memory: the array is already held for the layer's lifetime by
   * whichever backend it was pushed to. What goes away is the per-push *copy*.
   *
   * Freshness: `DrawableVector` stores style as plain data (a snapshot), so a `setFill`/`setStroke`/
   * `setFlag`/`writeDeclutterFlags` since the last call is re-applied **in place** here — reusing
   * the same objects and the same colour tuples, so the resync allocates nothing (see
   * {@link syncVectorStyle}). Geometry fields never change without a drawable-set change, which
   * drops the array entirely.
   *
   * Contract for callers: treat the array and its elements as read-only, and do not retain them
   * across a drawable-set change. The one sanctioned mutation is a backend's flags-only fast path
   * writing `flags` from this Scene's own live flags table (`CanvasBackend`/`SvgBackend`
   * `updateLayerFlags`, `WebGLBackend.toSVG`) — that writes the value this Scene already holds, so
   * it can only bring the view into sync, never diverge from it.
   *
   * `from > 0` asks for just the appended TAIL (O(new)) and always builds fresh objects: the
   * append path hands that slice straight to the backend, which owns and grows it from there.
   */
  drawables(name: string, from = 0): DrawableVector[] {
    const data = this.get(name);
    if (from > 0) {
      const out: DrawableVector[] = [];
      for (let i = from; i < data.ids.length; i++) out.push(this.vectorAt(data, i));
      return out;
    }
    let v = data.vectors;
    if (!v) {
      const n = data.ids.length;
      v = new Array<DrawableVector>(n);
      for (let i = 0; i < n; i++) v[i] = this.vectorAt(data, i);
      data.vectors = v;
    } else if (data.vectorsEpoch !== data.styleEpoch) {
      for (let i = 0; i < v.length; i++) syncVectorStyle(data, v[i]!, i);
    }
    data.vectorsEpoch = data.styleEpoch;
    return v;
  }

  /** The vector view of ONE drawable by domain id, or null when the id has no
   *  drawable (unknown, or culled at build time). O(1) lookup. */
  drawableOf(name: string, id: string | number): DrawableVector | null {
    const data = this.get(name);
    const i = data.idToDrawable.get(id);
    return i === undefined ? null : this.vectorAt(data, i);
  }

  /**
   * The per-drawable color/flag tables (see {@link StyleTables}) as LIVE views of the
   * group's typed storage — O(1), zero copies (#207; previously an O(drawableCount)
   * snapshot per call). Later `setFill`/`setStroke`/`setFlag` writes are visible through
   * the views; an append makes them stale (backends always receive the drawable-set
   * change as a setLayers/updateLayer/appendToLayer first). Consumers must not mutate
   * or retain them across drawable-set changes.
   */
  styleTables(name: string): StyleTables {
    const data = this.get(name);
    return {
      fillColors: data.fillColors.view(),
      strokeColors: data.strokeColors.view(),
      flags: data.flags.view(),
    };
  }

  /** Assemble GPU-ready typed arrays for a group — O(1): every array is a live view of the typed
   *  storage, and `pointCenters` (the one array that has to be interleaved rather than viewed) is
   *  built once per drawable set and retained (#280), not re-assembled per call. It used to cost
   *  O(pointCount) time plus a fresh 16 B/circle allocation on every `pushLayers()`; like the
   *  vector view it was already retained downstream by every backend, so keeping it here shares
   *  one array instead of minting a copy per push. See {@link GroupBuffers} for the sharing
   *  contract. */
  buffers(name: string): GroupBuffers {
    const data = this.get(name);
    return {
      fillVertices: data.fillVerts.view(),
      fillIndices: data.fillIdx.view(),
      strokeVertices: data.strokeVerts.view(),
      strokeIndices: data.strokeIdx.view(),
      fillColors: data.fillColors.view(),
      strokeColors: data.strokeColors.view(),
      flags: data.flags.view(),
      drawableCount: data.ranges.length,
      pointCenters: (data.pointCenters ??= assemblePointCenters(data, 0)),
      pointCount: data.circleCount,
      fillAnchors: data.fillAnchors.view(),
      strokeAnchors: data.strokeAnchors.view(),
      ranges: data.ranges,
    };
  }

  /**
   * GPU-ready buffers for ONLY the drawables appended at/after `fromDrawable` —
   * the tail slices as O(1) views (pointCenters assembled in O(new circles)). A
   * backend whose buffers mirror the group 1:1 (append-only, same order) can apply
   * this by appending: the index values are group-ABSOLUTE (no rebasing), because
   * the new vertices sit at the same positions the group placed them.
   * `fromDrawable >= drawableCount` yields an empty delta.
   */
  appendedBuffers(name: string, fromDrawable: number): GroupBufferDelta {
    const data = this.get(name);
    const dc = data.ranges.length;
    const from = Math.max(0, fromDrawable);
    if (from >= dc) {
      const empty = (): Float32Array => new Float32Array(0);
      return {
        fillVertices: empty(), fillIndices: new Uint32Array(0),
        strokeVertices: empty(), strokeIndices: new Uint32Array(0),
        fillColors: new Uint8Array(0), strokeColors: new Uint8Array(0), flags: new Uint8Array(0),
        pointCenters: empty(), fillAnchors: empty(), strokeAnchors: empty(),
        drawableCount: dc, fromDrawable: from, ranges: [],
      };
    }
    const r = data.ranges[from]!;
    const fv = r.fill.vertexOffset, fi = r.fill.indexOffset;
    const sv = r.stroke.vertexOffset, si = r.stroke.indexOffset;
    return {
      fillVertices: data.fillVerts.tail(fv * 3),
      fillIndices: data.fillIdx.tail(fi),
      strokeVertices: data.strokeVerts.tail(sv * 3),
      strokeIndices: data.strokeIdx.tail(si),
      fillColors: data.fillColors.tail(from * 4),
      strokeColors: data.strokeColors.tail(from * 4),
      flags: data.flags.tail(from),
      // New circles only; drawableId stays the absolute group index for texture lookup.
      pointCenters: assemblePointCenters(data, from),
      fillAnchors: data.fillAnchors.tail(fv * 2),
      strokeAnchors: data.strokeAnchors.tail(sv * 2),
      drawableCount: dc,
      fromDrawable: from,
      // Absolute offsets (into the full group arrays), matching the group-absolute
      // index values above — the consumer rebases against ranges[0]'s offsets.
      ranges: data.ranges.slice(from),
    };
  }
}

/**
 * Re-apply the per-drawable STYLE columns onto an already-built vector view, in place (#280).
 *
 * Writes into the drawable's existing colour tuples rather than allocating new ones, so a resync
 * costs eight byte reads + nine property stores per drawable and **zero** allocations — versus
 * three allocations per drawable (the object plus both tuples) for a full rebuild. Geometry fields
 * (`id`/`subpaths`/`circles`/`anchor`/`lineWidth`/join/cap) are deliberately untouched: they cannot
 * change without a drawable-set change, and that drops the whole retained array.
 */
function syncVectorStyle(data: GroupData, v: DrawableVector, i: number): void {
  const fc = data.fillColors.a, sc = data.strokeColors.a, o = i * 4;
  const f = v.fill, s = v.stroke;
  f[0] = fc[o]!; f[1] = fc[o + 1]!; f[2] = fc[o + 2]!; f[3] = fc[o + 3]!;
  s[0] = sc[o]!; s[1] = sc[o + 1]!; s[2] = sc[o + 2]!; s[3] = sc[o + 3]!;
  v.flags = data.flags.a[i]!;
}

/** Build the stride-4 [x, y, r, drawableId] point-centers array for drawables at/after
 *  `from` — one sized allocation (no boxed intermediate), O(circles in range). */
function assemblePointCenters(data: GroupData, from: number): Float32Array {
  const dc = data.ranges.length;
  let count = data.circleCount;
  if (from > 0) {
    count = 0;
    for (let i = from; i < dc; i++) count += data.circles[i]?.length ?? 0;
  }
  const out = new Float32Array(count * 4);
  let o = 0;
  for (let i = from; i < dc; i++) {
    const cs = data.circles[i];
    if (!cs) continue;
    for (const c of cs) {
      out[o++] = c.x;
      out[o++] = c.y;
      out[o++] = c.r;
      out[o++] = i;
    }
  }
  return out;
}

/** Clamp to a 0–255 byte (CSS clamps out-of-range channels; Uint8Array would wrap). */
function toByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Parse a CSS color string into RGBA bytes and write it at drawableId.
 *
 * d3-color parses any FULLY-transparent color ("transparent", "rgba(r,g,b,0)")
 * to NaN channels with opacity 0 — by design, not a parse failure: all colors with
 * a <= 0 produce Rgb(NaN, NaN, NaN, 0). We treat that as the zero color [0,0,0,0].
 * Only NaN opacity (a genuinely unparseable string) is a typo worth failing fast on.
 */
function writeColor(table: Uint8Array, drawableId: number, color: string): void {
  const c = rgb(color);
  const off = drawableId * 4;
  if (Number.isNaN(c.r)) {
    // d3-color parses any FULLY-transparent color ("transparent", "rgba(…, 0)") to NaN
    // channels with opacity 0 — by design, not a parse failure. Accept it as the zero
    // color; only NaN opacity (an unparseable string) is a typo worth failing fast on.
    if (c.opacity === 0) { table[off] = table[off + 1] = table[off + 2] = table[off + 3] = 0; return; }
    throw new Error(`invalid color: ${color}`);
  }
  table[off] = toByte(c.r);
  table[off + 1] = toByte(c.g);
  table[off + 2] = toByte(c.b);
  table[off + 3] = toByte((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255);
}
