import { PathRecorder } from "./path-recorder.js";
import { groupRings } from "./rings.js";
import { tessellateFill } from "./tessellate.js";
import { expandStroke } from "./stroke.js";
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
}

export interface DrawableOpts {
  /** Stroke width in coordinate units. 0/undefined => no stroke geometry. */
  lineWidth?: number;
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
  idToDrawable = new Map<string, number>();
  fillColors: number[] = []; // flat RGBA, 4 per drawable
  strokeColors: number[] = [];
  flags: number[] = [];
  subpaths: Subpath[][] = [];
  ids: (string | number)[] = [];
  lineWidths: number[] = [];
  /** One array of circle centers per drawable (empty for path drawables). */
  circles: { x: number; y: number; r: number }[][] = [];
  constructor(public readonly tolerance: number) {}
}

export interface DrawableVector {
  id: string | number;
  subpaths: Subpath[];
  fill: [number, number, number, number];
  stroke: [number, number, number, number];
  lineWidth: number;
  flags: number;
  circles: { x: number; y: number; r: number }[];
}

export class Scene {
  private groups = new Map<string, GroupData>();

  constructor(private readonly tolerance = 0.25) {}

  /** Build (or rebuild) a named group. The callback registers drawables. */
  group(name: string, build: (g: GroupBuilder) => void): void {
    const data = new GroupData(this.tolerance);
    const builder: GroupBuilder = {
      drawable: (id, draw, opts) => this.addDrawable(data, id, draw, opts),
      point: (id, x, y, radius) => this.addCircleDrawable(data, id, [[x, y]], radius),
      points: (id, centers, radius) => this.addCircleDrawable(data, id, centers, radius),
    };
    build(builder);
    this.groups.set(name, data);
  }

  private addDrawable(
    data: GroupData,
    id: string | number,
    draw: (ctx: PathRecorder) => void,
    opts?: DrawableOpts,
  ): void {
    const recorder = new PathRecorder(data.tolerance);
    draw(recorder);
    const subpaths = recorder.subpaths;
    const drawableId = data.ranges.length;
    data.idToDrawable.set(String(id), drawableId);
    data.subpaths.push(subpaths.map((s) => ({ closed: s.closed, points: s.points.slice() })));
    data.ids.push(id);
    data.lineWidths.push(opts?.lineWidth ?? 0);

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
        data.fillVerts.push(fg.vertices[i]!, fg.vertices[i + 1]!, drawableId);
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
        const sg = expandStroke(sp, lineWidth);
        const baseVertex = data.strokeVerts.length / 3;
        for (let i = 0; i < sg.vertices.length; i += 2) {
          data.strokeVerts.push(sg.vertices[i]!, sg.vertices[i + 1]!, drawableId);
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
    const drawableId = data.ranges.length;
    data.idToDrawable.set(String(id), drawableId);
    data.subpaths.push([]);
    data.circles.push(centers.map(([x, y]) => ({ x, y, r })));
    data.ids.push(id);
    data.lineWidths.push(0);
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
    const drawableId = data.idToDrawable.get(String(id));
    if (drawableId === undefined) throw new Error(`unknown drawable: ${String(id)}`);
    return data.ranges[drawableId]!;
  }

  /** Resolve a group + domain id to its drawableId, or throw. */
  private drawableIdOf(name: string, id: string | number): { data: GroupData; drawableId: number } {
    const data = this.get(name);
    const drawableId = data.idToDrawable.get(String(id));
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

  /** Return the vector view of all drawables in a group. */
  drawables(name: string): DrawableVector[] {
    const data = this.get(name);
    return data.ids.map((id, i) => ({
      id,
      subpaths: data.subpaths[i]!,
      fill: [data.fillColors[i * 4]!, data.fillColors[i * 4 + 1]!, data.fillColors[i * 4 + 2]!, data.fillColors[i * 4 + 3]!],
      stroke: [data.strokeColors[i * 4]!, data.strokeColors[i * 4 + 1]!, data.strokeColors[i * 4 + 2]!, data.strokeColors[i * 4 + 3]!],
      lineWidth: data.lineWidths[i]!,
      flags: data.flags[i]!,
      circles: data.circles[i]!,
    }));
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
 * An unparseable color yields NaN channels from d3-color; we fail fast rather
 * than silently render opaque black, which would mask a typo'd color string.
 */
function writeColor(table: number[], drawableId: number, color: string): void {
  const c = rgb(color);
  if (Number.isNaN(c.r)) throw new Error(`invalid color: ${color}`);
  const off = drawableId * 4;
  table[off] = toByte(c.r);
  table[off + 1] = toByte(c.g);
  table[off + 2] = toByte(c.b);
  table[off + 3] = toByte((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255);
}
