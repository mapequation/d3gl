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

/** Just the per-drawable style tables (colors + flags) as detached typed arrays —
 *  O(drawableCount), for styles-only backend updates. Never the O(total-vertices)
 *  {@link Scene.buffers} rebuild: geometry hasn't changed, only how it's painted. */
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
  /** A single filled circle at (x, y) with the given radius (reference px). */
  point(id: string | number, x: number, y: number, radius: number): void;
  /** Multiple circles (one drawable, e.g. a GeoJSON MultiPoint). */
  points(id: string | number, centers: readonly [number, number][], radius: number): void;
}

/** Mutable accumulation for one group while building / before buffer assembly. */
class GroupData {
  fillVerts: number[] = [];
  fillIdx: number[] = [];
  strokeVerts: number[] = [];
  strokeIdx: number[] = [];
  ranges: DrawableRange[] = [];
  // Keyed by the raw id (string OR number) — NOT String(id) — so numeric-id layers
  // don't allocate a string per drawable (millions, for streamed data). A layer uses
  // one id type, so 1 vs "1" collisions aren't a real concern.
  idToDrawable = new Map<string | number, number>();
  fillColors: number[] = []; // flat RGBA, 4 per drawable
  strokeColors: number[] = [];
  flags: number[] = [];
  subpaths: Subpath[][] = [];
  ids: (string | number)[] = [];
  lineWidths: number[] = [];
  /** Per-drawable glyph anchor (null = none), for screen sizeMode. */
  anchors: ([number, number] | null)[] = [];
  /** Per-fill-vertex / per-stroke-vertex anchors (flat x,y), parallel to the vertex arrays. */
  fillAnchors: number[] = [];
  strokeAnchors: number[] = [];
  /** One array of circle centers per drawable (empty for path drawables). */
  circles: { x: number; y: number; r: number }[][] = [];
  /** Per-drawable stroke join style + miter limit + end cap (parallel to lineWidths). */
  joins: LineJoin[] = [];
  miterLimits: number[] = [];
  caps: LineCap[] = [];
  /** Cached transform-independent declutter index (built lazily; null ⇒ stale/never built).
   *  Invalidated whenever the group's drawable set changes (rebuild or append). */
  declutterIndex: DeclutterIndex | null = null;
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

  /** Append more drawables to an existing group (vs group(), which replaces it).
   *  New drawables' integer drawableIds continue after the existing ones; a
   *  duplicate domain id (the caller's string/number id) throws. NOTE: not atomic
   *  across a multi-drawable build — if a later drawable in the batch throws, earlier
   *  ones are already committed. Callers needing all-or-nothing (the engine append
   *  path) validate ids before calling. */
  appendToGroup(name: string, build: (g: GroupBuilder) => void): void {
    const data = this.get(name);
    build(this.builderFor(data));
    data.declutterIndex = null; // the drawable set grew; the cached anchor index is now stale
  }

  /** Number of drawables currently registered in a group. */
  drawableCount(name: string): number {
    return this.get(name).ranges.length;
  }

  private builderFor(data: GroupData): GroupBuilder {
    return {
      drawable: (id, draw, opts) => this.addDrawable(data, id, draw, opts),
      point: (id, x, y, radius) => this.addCircleDrawable(data, id, [[x, y]], radius),
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
    data.joins.push(join);
    data.miterLimits.push(miterLimit);
    data.caps.push(cap);
    const anchor = opts?.anchor ?? null;
    data.anchors.push(anchor);

    // ---- Fill ----
    const fillVertexOffset = data.fillVerts.length / 3;
    const fillIndexOffset = data.fillIdx.length;
    const closed = subpaths.filter((s) => s.closed && s.points.length >= 6);
    if (closed.length > 0) {
      const rings = groupRings(closed);
      const polygons = rings.map((r) => r.outer);
      const holes = rings.map((r) => r.holes);
      const fg = tessellateFill(polygons, holes);
      const baseVertex = data.fillVerts.length / 3;
      for (let i = 0; i < fg.vertices.length; i += 2) {
        const x = fg.vertices[i]!, y = fg.vertices[i + 1]!;
        data.fillVerts.push(x, y, drawableId);
        // Anchor at the glyph center if given, else at the vertex itself (offset 0 ⇒ stays world).
        data.fillAnchors.push(anchor ? anchor[0] : x, anchor ? anchor[1] : y);
      }
      for (const ix of fg.indices) data.fillIdx.push(baseVertex + ix);
    }
    const fillVertexCount = data.fillVerts.length / 3 - fillVertexOffset;
    const fillIndexCount = data.fillIdx.length - fillIndexOffset;

    // ---- Stroke ----
    const strokeVertexOffset = data.strokeVerts.length / 3;
    const strokeIndexOffset = data.strokeIdx.length;
    const lineWidth = opts?.lineWidth ?? 0;
    if (lineWidth > 0) {
      for (const sp of subpaths) {
        const sg = expandStroke(sp, lineWidth, { join, miterLimit, cap });
        const baseVertex = data.strokeVerts.length / 3;
        for (let i = 0; i < sg.vertices.length; i += 2) {
          data.strokeVerts.push(sg.vertices[i]!, sg.vertices[i + 1]!, drawableId);
          // Glyph: anchor at the center (whole outline scales). Else: per-vertex centerline
          // anchor (constant-width stroke about its own line).
          data.strokeAnchors.push(anchor ? anchor[0] : sg.anchors[i]!, anchor ? anchor[1] : sg.anchors[i + 1]!);
        }
        for (const ix of sg.indices) data.strokeIdx.push(baseVertex + ix);
      }
    }
    const strokeVertexCount = data.strokeVerts.length / 3 - strokeVertexOffset;
    const strokeIndexCount = data.strokeIdx.length - strokeIndexOffset;

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
    // Defaults: transparent colors, visible flag (bit 0).
    data.fillColors.push(0, 0, 0, 0);
    data.strokeColors.push(0, 0, 0, 0);
    data.flags.push(1);
    // Path drawables have no circle geometry.
    data.circles.push([]);
  }

  private addCircleDrawable(
    data: GroupData,
    id: string | number,
    centers: readonly [number, number][],
    r: number,
  ): void {
    if (data.idToDrawable.has(id)) throw new Error(`duplicate drawable id: ${String(id)}`);
    const drawableId = data.ranges.length;
    data.idToDrawable.set(id, drawableId);
    data.subpaths.push([]);
    data.circles.push(centers.map(([x, y]) => ({ x, y, r })));
    data.ids.push(id);
    data.lineWidths.push(0);
    data.joins.push("bevel");
    data.miterLimits.push(DEFAULT_MITER_LIMIT);
    data.caps.push("butt");
    data.anchors.push(null);
    // Zero fill+stroke range to keep ranges index-aligned with drawableId.
    const fillVertexOffset = data.fillVerts.length / 3;
    const strokeVertexOffset = data.strokeVerts.length / 3;
    data.ranges.push({
      fill: { vertexOffset: fillVertexOffset, vertexCount: 0, indexOffset: data.fillIdx.length, indexCount: 0 },
      stroke: { vertexOffset: strokeVertexOffset, vertexCount: 0, indexOffset: data.strokeIdx.length, indexCount: 0 },
    });
    // Defaults: transparent colors, visible flag (bit 0).
    data.fillColors.push(0, 0, 0, 0);
    data.strokeColors.push(0, 0, 0, 0);
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
    writeColor(data.fillColors, drawableId, color);
  }

  /** Set a drawable's stroke color (any CSS color string). Hot-swappable. */
  setStroke(name: string, id: string | number, color: string): void {
    const { data, drawableId } = this.drawableIdOf(name, id);
    writeColor(data.strokeColors, drawableId, color);
  }

  /** Set a drawable's flag byte (e.g. bit 0 = visible). Hot-swappable. */
  setFlag(name: string, id: string | number, flags: number): void {
    const { data, drawableId } = this.drawableIdOf(name, id);
    data.flags[drawableId] = flags & 0xff;
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
   * by the same group index as `ax`/`ay`.
   */
  writeDeclutterFlags(name: string, visibleByGroup: Uint8Array): void {
    const data = this.get(name);
    const { groupOf } = data.declutterIndex ?? this.declutterIndex(name);
    const flags = data.flags;
    for (let i = 0; i < flags.length; i++) {
      const g = groupOf[i]!;
      flags[i] = g < 0 || visibleByGroup[g] ? 1 : 0;
    }
  }

  /** Build the vector view of one drawable at index `i` (shared by drawables()/drawableOf()). */
  private vectorAt(data: GroupData, i: number): DrawableVector {
    return {
      id: data.ids[i]!,
      subpaths: data.subpaths[i]!,
      fill: [data.fillColors[i * 4]!, data.fillColors[i * 4 + 1]!, data.fillColors[i * 4 + 2]!, data.fillColors[i * 4 + 3]!],
      stroke: [data.strokeColors[i * 4]!, data.strokeColors[i * 4 + 1]!, data.strokeColors[i * 4 + 2]!, data.strokeColors[i * 4 + 3]!],
      lineWidth: data.lineWidths[i]!,
      lineJoin: data.joins[i]!,
      miterLimit: data.miterLimits[i]!,
      lineCap: data.caps[i]!,
      flags: data.flags[i]!,
      circles: data.circles[i]!,
      anchor: data.anchors[i]!,
    };
  }

  /** Return the vector view of a group's drawables, optionally only those at/after
   *  `from` (so an incremental append can read just the new ones in O(new)). */
  drawables(name: string, from = 0): DrawableVector[] {
    const data = this.get(name);
    const out: DrawableVector[] = [];
    for (let i = Math.max(0, from); i < data.ids.length; i++) out.push(this.vectorAt(data, i));
    return out;
  }

  /** The vector view of ONE drawable by domain id, or null when the id has no
   *  drawable (unknown, or culled at build time). O(1) lookup. */
  drawableOf(name: string, id: string | number): DrawableVector | null {
    const data = this.get(name);
    const i = data.idToDrawable.get(id);
    return i === undefined ? null : this.vectorAt(data, i);
  }

  /** Snapshot the per-drawable color/flag tables (see {@link StyleTables}). */
  styleTables(name: string): StyleTables {
    const data = this.get(name);
    return {
      fillColors: new Uint8Array(data.fillColors),
      strokeColors: new Uint8Array(data.strokeColors),
      flags: new Uint8Array(data.flags),
    };
  }

  /** Assemble GPU-ready typed arrays for a group. */
  buffers(name: string): GroupBuffers {
    const data = this.get(name);
    // Build the pointCenters buffer: stride 4 = [x, y, radius, drawableId].
    const pointFlat: number[] = [];
    for (let i = 0; i < data.circles.length; i++) {
      for (const c of data.circles[i]!) {
        pointFlat.push(c.x, c.y, c.r, i);
      }
    }
    return {
      fillVertices: new Float32Array(data.fillVerts),
      fillIndices: new Uint32Array(data.fillIdx),
      strokeVertices: new Float32Array(data.strokeVerts),
      strokeIndices: new Uint32Array(data.strokeIdx),
      fillColors: new Uint8Array(data.fillColors),
      strokeColors: new Uint8Array(data.strokeColors),
      flags: new Uint8Array(data.flags),
      drawableCount: data.ranges.length,
      pointCenters: new Float32Array(pointFlat),
      pointCount: pointFlat.length / 4,
      fillAnchors: new Float32Array(data.fillAnchors),
      strokeAnchors: new Float32Array(data.strokeAnchors),
      ranges: data.ranges,
    };
  }

  /**
   * GPU-ready buffers for ONLY the drawables appended at/after `fromDrawable` —
   * the tail slices, computed in O(new). A backend whose buffers mirror the group
   * 1:1 (append-only, same order) can apply this by appending: the index values are
   * group-ABSOLUTE (no rebasing), because the new vertices sit at the same positions
   * the group placed them. `fromDrawable >= drawableCount` yields an empty delta.
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
    // New circles only; drawableId stays the absolute group index for texture lookup.
    const pointFlat: number[] = [];
    for (let i = from; i < dc; i++) for (const c of data.circles[i]!) pointFlat.push(c.x, c.y, c.r, i);
    return {
      fillVertices: new Float32Array(data.fillVerts.slice(fv * 3)),
      fillIndices: new Uint32Array(data.fillIdx.slice(fi)),
      strokeVertices: new Float32Array(data.strokeVerts.slice(sv * 3)),
      strokeIndices: new Uint32Array(data.strokeIdx.slice(si)),
      fillColors: new Uint8Array(data.fillColors.slice(from * 4)),
      strokeColors: new Uint8Array(data.strokeColors.slice(from * 4)),
      flags: new Uint8Array(data.flags.slice(from)),
      pointCenters: new Float32Array(pointFlat),
      fillAnchors: new Float32Array(data.fillAnchors.slice(fv * 2)),
      strokeAnchors: new Float32Array(data.strokeAnchors.slice(sv * 2)),
      drawableCount: dc,
      fromDrawable: from,
      // Absolute offsets (into the full group arrays), matching the group-absolute
      // index values above — the consumer rebases against ranges[0]'s offsets.
      ranges: data.ranges.slice(from),
    };
  }
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
function writeColor(table: number[], drawableId: number, color: string): void {
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
