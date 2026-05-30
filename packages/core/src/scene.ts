import { PathRecorder } from "./path-recorder.js";
import { groupRings } from "./rings.js";
import { tessellateFill } from "./tessellate.js";
import { expandStroke } from "./stroke.js";

/** Contiguous slice a drawable occupies within a group's shared buffers. */
export interface DrawableRange {
  fill: { vertexOffset: number; vertexCount: number; indexOffset: number; indexCount: number };
  stroke: { vertexOffset: number; vertexCount: number; indexOffset: number; indexCount: number };
}

/** GPU-ready typed arrays for one group. Vertices are [x, y, drawableId]. */
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
}

export interface DrawableOpts {
  /** Stroke width in coordinate units. 0/undefined => no stroke geometry. */
  lineWidth?: number;
}

export interface GroupBuilder {
  drawable(id: string | number, draw: (ctx: PathRecorder) => void, opts?: DrawableOpts): void;
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
  constructor(public readonly tolerance: number) {}
}

export class Scene {
  private groups = new Map<string, GroupData>();

  constructor(private readonly tolerance = 0.25) {}

  /** Build (or rebuild) a named group. The callback registers drawables. */
  group(name: string, build: (g: GroupBuilder) => void): void {
    const data = new GroupData(this.tolerance);
    const builder: GroupBuilder = {
      drawable: (id, draw, opts) => this.addDrawable(data, id, draw, opts),
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

  /** Assemble GPU-ready typed arrays for a group. */
  buffers(name: string): GroupBuffers {
    const data = this.get(name);
    return {
      fillVertices: new Float32Array(data.fillVerts),
      fillIndices: new Uint32Array(data.fillIdx),
      strokeVertices: new Float32Array(data.strokeVerts),
      strokeIndices: new Uint32Array(data.strokeIdx),
      fillColors: new Uint8Array(data.fillColors),
      strokeColors: new Uint8Array(data.strokeColors),
      flags: new Uint8Array(data.flags),
      drawableCount: data.ranges.length,
    };
  }
}
