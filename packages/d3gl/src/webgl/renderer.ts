import { Buffer } from "@luma.gl/core";
import type { Device, Texture, RenderPass, TextureFormat } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { GroupBuffers, GroupBufferDelta, DrawableRange } from "../core/index.js";
import { FILL_VS, FILL_FS, PICK_FS, POINT_VS, POINT_FS } from "./shaders.js";

/** Fixed texel width of every per-drawable side-table texture (color/flags). */
const TABLE_WIDTH = 256;

const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

type FloatCtor = Float32ArrayConstructor;
type UintCtor = Uint32ArrayConstructor;

/** Next power of two >= n (n assumed > 0). */
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * A GPU buffer that grows by capacity-doubling, backed by a CPU mirror.
 *
 * Appends within capacity are a single tail `Buffer.write` (bufferSubData) — O(new).
 * On overflow the GPU buffer (and CPU mirror) is reallocated to the next power-of-two
 * capacity, the full mirror is re-uploaded once, and `append` returns TRUE so the
 * caller rebinds the owning Model to the new `buffer` (the old handle is destroyed).
 *
 * The CPU mirror doubles memory vs. a GPU-only buffer; that is the deliberate trade
 * for a correct, simple grow (we need the full data to repopulate the bigger GPU buffer).
 */
export class GrowBuffer {
  buffer: Buffer;
  /** CPU mirror (Float32Array or Uint32Array), `capacity` elements long. */
  private mirror: Float32Array | Uint32Array;
  /** Used element count (<= capacity). */
  length: number;
  private capacity: number;
  private readonly bytesPerElement: number;

  constructor(
    private readonly device: Device,
    private readonly ArrayCtor: FloatCtor | UintCtor,
    initialData: Float32Array | Uint32Array,
    private readonly index = false,
    minCapacity = 256,
  ) {
    this.capacity = Math.max(initialData.length, minCapacity);
    this.bytesPerElement = ArrayCtor.BYTES_PER_ELEMENT;
    this.mirror = new ArrayCtor(this.capacity);
    this.mirror.set(initialData);
    this.length = initialData.length;
    this.buffer = this.allocate(this.capacity);
    // Seed the GPU buffer with the initial data (write only what's used).
    if (initialData.length > 0) this.buffer.write(initialData);
  }

  private allocate(capacityElems: number): Buffer {
    const props: Parameters<Device["createBuffer"]>[0] = {
      byteLength: capacityElems * this.bytesPerElement,
    };
    if (this.index) {
      props.usage = Buffer.INDEX;
      props.indexType = "uint32";
    }
    return this.device.createBuffer(props);
  }

  /**
   * Append `data` to the tail. Returns TRUE if the GPU buffer was reallocated
   * (caller must rebind the Model to the new `this.buffer`), FALSE if the data
   * fit in the existing buffer (a single tail sub-data write).
   */
  append(data: Float32Array | Uint32Array): boolean {
    if (data.length === 0) return false;
    const need = this.length + data.length;
    if (need > this.capacity) {
      const newCap = nextPow2(need);
      const newMirror = new this.ArrayCtor(newCap);
      newMirror.set(this.mirror.subarray(0, this.length));
      newMirror.set(data, this.length);
      this.capacity = newCap;
      this.mirror = newMirror;
      this.buffer.destroy();
      this.buffer = this.allocate(newCap);
      this.buffer.write(this.mirror.subarray(0, need) as Float32Array | Uint32Array);
      this.length = need;
      return true;
    }
    // Fits: copy into mirror and write only the tail at its byte offset.
    this.mirror.set(data, this.length);
    this.buffer.write(data, this.length * this.bytesPerElement);
    this.length = need;
    return false;
  }

  /**
   * Reset the used length to 0 so the next {@link append} overwrites from the start
   * (the GPU buffer and its capacity are kept). Used by reusable scratch buffers that
   * are refilled per draw rather than grown monotonically; stale tail bytes past the
   * new length are simply never indexed.
   */
  reset(): void {
    this.length = 0;
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

/**
 * A per-drawable side-table TEXTURE (color rgba8 or flags r8) that grows by
 * capacity-doubling, backed by a padded CPU mirror.
 *
 * Width is FIXED at {@link TABLE_WIDTH} (256); only the height (number of rows)
 * grows. drawableId indexes into the texture as `(id % width, id / width)` in the
 * shader (via textureSize), so the constant width keeps that mapping valid and any
 * extra capacity rows are simply never indexed.
 *
 * Appends within the current row-capacity upload ONLY the changed rows — O(new).
 * On overflow the texture is reallocated to the next power-of-two row count, the
 * mirror is grown + recreated once, and `append` returns TRUE so the caller rebinds
 * the owning Model(s) to the new `texture` (the old handle is destroyed).
 */
class GrowTexture {
  texture: Texture;
  /** Padded CPU mirror, `capacityRows * TABLE_WIDTH * channels` bytes. */
  private mirror: Uint8Array;
  /** Entries (drawables) currently uploaded. */
  count: number;
  private capacityRows: number;
  private readonly rowBytes: number;

  /**
   * @param channels bytes per entry (4 for rgba8unorm color, 1 for r8unorm flags).
   * @param initialBytes the first `count * channels` bytes of table data.
   * @param count number of entries the initial data represents.
   */
  constructor(
    private readonly device: Device,
    private readonly channels: number,
    private readonly format: TextureFormat,
    initialBytes: Uint8Array,
    count: number,
  ) {
    this.rowBytes = TABLE_WIDTH * channels;
    const usedRows = Math.max(1, Math.ceil(count / TABLE_WIDTH));
    this.capacityRows = nextPow2(usedRows);
    this.mirror = new Uint8Array(this.capacityRows * this.rowBytes);
    this.mirror.set(initialBytes.subarray(0, count * channels));
    this.count = count;
    this.texture = this.allocate();
  }

  private allocate(): Texture {
    return this.device.createTexture({
      data: this.mirror,
      width: TABLE_WIDTH,
      height: this.capacityRows,
      format: this.format,
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });
  }

  /**
   * Append `deltaBytes` ((newCount-count)*channels long) extending the table to
   * `newCount` entries. Returns TRUE if the texture was RECREATED (caller must
   * rebind the Model bindings to the new `this.texture`), FALSE if only changed
   * rows were re-uploaded (a partial writeData — O(new)).
   */
  append(deltaBytes: Uint8Array, newCount: number): boolean {
    const oldCount = this.count;
    const newRows = Math.max(1, Math.ceil(newCount / TABLE_WIDTH));
    if (newRows > this.capacityRows) {
      // Overflow: grow to next power-of-two rows, recreate the texture once.
      this.capacityRows = nextPow2(newRows);
      const newMirror = new Uint8Array(this.capacityRows * this.rowBytes);
      newMirror.set(this.mirror.subarray(0, oldCount * this.channels));
      newMirror.set(deltaBytes, oldCount * this.channels);
      this.mirror = newMirror;
      this.texture.destroy();
      this.texture = this.allocate();
      this.count = newCount;
      return true;
    }
    // Fits: write the delta into the mirror, then upload only the changed rows.
    this.mirror.set(deltaBytes, oldCount * this.channels);
    const startRow = Math.floor(oldCount / TABLE_WIDTH);
    const numRows = newRows - startRow;
    this.texture.writeData(
      this.mirror.subarray(startRow * this.rowBytes, newRows * this.rowBytes),
      { x: 0, y: startRow, width: TABLE_WIDTH, height: numRows },
    );
    this.count = newCount;
    return false;
  }

  /** Overwrite the whole table in place (recolor / show-hide; count unchanged). */
  write(bytes: Uint8Array): void {
    this.mirror.set(bytes.subarray(0, this.count * this.channels));
    const rows = Math.max(1, Math.ceil(this.count / TABLE_WIDTH));
    this.texture.writeData(this.mirror.subarray(0, rows * this.rowBytes), {
      x: 0,
      y: 0,
      width: TABLE_WIDTH,
      height: rows,
    });
  }

  destroy(): void {
    this.texture.destroy();
  }
}

/**
 * GPU resources for the combined fill+stroke geometry pass.
 *
 * Fill and stroke triangles live in ONE vertex/index buffer, with the index buffer
 * ordered per drawable — `fill_d, stroke_d, fill_{d+1}, stroke_{d+1}, …` — so a single
 * indexed draw composites them in painter's order (WebGL blends primitives in index
 * order), matching the Canvas/SVG per-drawable fill-then-stroke model. The `isStroke`
 * attribute (0/1) selects the fill vs stroke color table per vertex in the shader.
 */
interface Pass {
  position: GrowBuffer;
  id: GrowBuffer;
  anchor: GrowBuffer;
  /** Per-vertex 0 (fill) / 1 (stroke) flag selecting the color table in the shader. */
  isStroke: GrowBuffer;
  index: GrowBuffer;
  /** Per-drawable FILL RGBA table (rgba8unorm), indexed by drawableId. */
  colorTex: GrowTexture;
  /** Per-drawable STROKE RGBA table (rgba8unorm), indexed by drawableId. */
  strokeColorTex: GrowTexture;
  /** Per-drawable flags table (r8unorm), grown with partial row uploads. */
  flagsTex: GrowTexture;
  fillModel: Model;
  pickModel: Model;
  /** Shared uniforms object — mutated in-place by setTransform so the next draw picks it up. */
  uniforms: Record<string, unknown>;
  /** Drawable count currently uploaded (grows on append). */
  drawableCount: number;
}

/** GPU resources for the analytic point pass. */
interface PointPass {
  center: GrowBuffer;
  corner: GrowBuffer;
  radius: GrowBuffer;
  pointId: GrowBuffer;
  index: GrowBuffer;
  /** Number of point vertices uploaded (4 per circle); index base for appends. */
  vertexCount: number;
  /** Color/flags tables — either shared with the fill pass (same refs) or owned. */
  colorTex: GrowTexture;
  flagsTex: GrowTexture;
  /** Whether this pass owns the textures (false = borrowed from fill pass). */
  ownsTextures: boolean;
  model: Model;
  uniforms: Record<string, unknown>;
  drawableCount: number;
}

const FILL_LAYOUT = [
  { name: "a_position", format: "float32x2" as const },
  { name: "a_anchor", format: "float32x2" as const },
  { name: "a_drawableId", format: "float32" as const },
  { name: "a_isStroke", format: "float32" as const },
];

const POINT_LAYOUT = [
  { name: "a_center", format: "float32x2" as const },
  { name: "a_corner", format: "float32x2" as const },
  { name: "a_radius", format: "float32" as const },
  { name: "a_pointId", format: "float32" as const },
];

const POINT_CORNERS: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/**
 * Renders one Scene group on the GPU. Geometry is uploaded once; pan/zoom is a
 * transform-uniform update and recolor/visibility is a palette/flags texture
 * update — neither touches the geometry buffers. Appends are O(new): the geometry
 * buffers grow by capacity-doubling ({@link GrowBuffer}) and the color/flags textures
 * grow with partial uploads (or a recreate when their texel dimensions change).
 */
export class GroupRenderer {
  private transform = identity();
  /** Combined fill+stroke pass (interleaved per drawable). Null when the group is points-only. */
  private shape: Pass | null;
  private point: PointPass | null;

  constructor(
    private readonly device: Device,
    buffers: GroupBuffers,
    /** Viewport width in device pixels (for screen-mode point sizing). */
    private viewportWidth = 0,
    /** Viewport height in device pixels (for screen-mode point sizing). */
    private viewportHeight = 0,
  ) {
    this.shape = this.buildShapePass(buffers);
    this.point = this.buildPointPass(buffers);
  }

  /**
   * Interleave per-drawable fill + stroke geometry into one merged vertex/index set,
   * in paint order (`fill_d, stroke_d, fill_{d+1}, …`). Vertex order is irrelevant to
   * blending — only the INDEX order is — so vertices are laid out drawable-by-drawable
   * (fill block then stroke block) which makes appends a clean tail-add.
   *
   * `ranges` offsets are absolute into the given arrays; for an append the arrays are
   * tail slices, so they're rebased against `ranges[0]`'s offsets. Index VALUES stay
   * group/slice-absolute and are remapped to the merged buffer via the drawable's own
   * vertex offset. `mergedVertexBase` is the vertex count already in the merged buffer
   * (0 for a fresh build) so appended index values continue correctly.
   */
  private static interleave(
    fillVerts: Float32Array,
    strokeVerts: Float32Array,
    fillAnchors: Float32Array,
    strokeAnchors: Float32Array,
    fillIdx: Uint32Array,
    strokeIdx: Uint32Array,
    ranges: DrawableRange[],
    mergedVertexBase: number,
  ): { pos: Float32Array; anchor: Float32Array; id: Float32Array; isStroke: Float32Array; index: Uint32Array } {
    let vCount = 0;
    let iCount = 0;
    for (const r of ranges) {
      vCount += r.fill.vertexCount + r.stroke.vertexCount;
      iCount += r.fill.indexCount + r.stroke.indexCount;
    }
    const pos = new Float32Array(vCount * 2);
    const anchor = new Float32Array(vCount * 2);
    const id = new Float32Array(vCount);
    const isStroke = new Float32Array(vCount);
    const index = new Uint32Array(iCount);
    // Slice bases: ranges offsets are absolute, but the arrays may be tail slices.
    const fvBase = ranges.length ? ranges[0]!.fill.vertexOffset : 0;
    const fiBase = ranges.length ? ranges[0]!.fill.indexOffset : 0;
    const svBase = ranges.length ? ranges[0]!.stroke.vertexOffset : 0;
    const siBase = ranges.length ? ranges[0]!.stroke.indexOffset : 0;
    let v = 0;
    let ii = 0;
    const emit = (
      verts: Float32Array,
      anchors: Float32Array,
      idx: Uint32Array,
      vOff: number,
      vCnt: number,
      iOff: number,
      iCnt: number,
      vBase: number,
      iBase: number,
      strokeFlag: number,
    ): void => {
      const mergedBase = mergedVertexBase + v;
      const localVOff = vOff - vBase;
      for (let k = 0; k < vCnt; k++) {
        const src = (localVOff + k) * 3;
        pos[v * 2] = verts[src]!;
        pos[v * 2 + 1] = verts[src + 1]!;
        id[v] = verts[src + 2]!;
        const a = (localVOff + k) * 2;
        anchor[v * 2] = anchors[a]!;
        anchor[v * 2 + 1] = anchors[a + 1]!;
        isStroke[v] = strokeFlag;
        v++;
      }
      const localIOff = iOff - iBase;
      for (let k = 0; k < iCnt; k++) {
        // idx values are absolute into the drawable's vertex run; (value - vOff) is the
        // local-in-drawable vertex, + mergedBase places it in the merged buffer.
        index[ii++] = idx[localIOff + k]! - vOff + mergedBase;
      }
    };
    for (const r of ranges) {
      emit(fillVerts, fillAnchors, fillIdx, r.fill.vertexOffset, r.fill.vertexCount, r.fill.indexOffset, r.fill.indexCount, fvBase, fiBase, 0);
      emit(strokeVerts, strokeAnchors, strokeIdx, r.stroke.vertexOffset, r.stroke.vertexCount, r.stroke.indexOffset, r.stroke.indexCount, svBase, siBase, 1);
    }
    return { pos, anchor, id, isStroke, index };
  }

  /** Build the combined fill+stroke pass. Null when the group has no fill/stroke geometry. */
  private buildShapePass(buffers: GroupBuffers): Pass | null {
    if (buffers.fillIndices.length === 0 && buffers.strokeIndices.length === 0) return null;
    const device = this.device;

    const m = GroupRenderer.interleave(
      buffers.fillVertices, buffers.strokeVertices,
      buffers.fillAnchors, buffers.strokeAnchors,
      buffers.fillIndices, buffers.strokeIndices,
      buffers.ranges, 0,
    );
    const position = new GrowBuffer(device, Float32Array, m.pos);
    const id = new GrowBuffer(device, Float32Array, m.id);
    const anchor = new GrowBuffer(device, Float32Array, m.anchor);
    const isStroke = new GrowBuffer(device, Float32Array, m.isStroke);
    const index = new GrowBuffer(device, Uint32Array, m.index, true);

    // Every drawable contributes one fill + one stroke color + one flag byte (defaults
    // included for fill-less / stroke-less drawables), so all three tables size to drawableCount.
    const count = buffers.fillColors.length / 4;
    const colorTex = new GrowTexture(device, 4, "rgba8unorm", buffers.fillColors, count);
    const strokeColorTex = new GrowTexture(device, 4, "rgba8unorm", buffers.strokeColors, count);
    const flagsTex = new GrowTexture(device, 1, "r8unorm", buffers.flags, count);

    const attributes = {
      a_position: position.buffer,
      a_anchor: anchor.buffer,
      a_drawableId: id.buffer,
      a_isStroke: isStroke.buffer,
    };
    const bindings = { u_colorTable: colorTex.texture, u_strokeTable: strokeColorTex.texture, u_flags: flagsTex.texture };
    // Use a shared uniforms object so setTransform mutations are picked up on the next draw.
    const uniforms: Record<string, unknown> = {
      u_transform: this.transform,
      u_screen: 0,
      u_viewport: new Float32Array([this.viewportWidth, this.viewportHeight]),
    };
    const common = {
      bufferLayout: FILL_LAYOUT,
      attributes,
      indexBuffer: index.buffer,
      bindings,
      uniforms,
      topology: "triangle-list" as const,
      // For indexed draws luma derives the draw count from the index buffer; this
      // is the index count and is accepted but redundant.
      vertexCount: m.index.length,
    };

    const fillModel = new Model(device, { ...common, vs: FILL_VS, fs: FILL_FS });
    // pickModel shares geometry/bindings/uniforms with fillModel; it is drawn only
    // by renderPick() (GPU color-picking). Both fill and stroke fragments encode the
    // same drawableId (v_id), so a border pixel picks its drawable too.
    const pickModel = new Model(device, { ...common, vs: FILL_VS, fs: PICK_FS });
    return {
      position, id, anchor, isStroke, index, colorTex, strokeColorTex, flagsTex,
      fillModel, pickModel, uniforms, drawableCount: count,
    };
  }

  /** Expand `pc` (stride-4 [x,y,r,id] circles) to quad geometry starting at `vertexBase`. */
  private static expandPoints(pc: Float32Array, vertexBase: number): {
    center: Float32Array; corner: Float32Array; radius: Float32Array; pointId: Float32Array; index: Uint32Array;
  } {
    const N = pc.length / 4;
    const center = new Float32Array(N * 4 * 2);
    const corner = new Float32Array(N * 4 * 2);
    const radius = new Float32Array(N * 4);
    const pointId = new Float32Array(N * 4);
    const index = new Uint32Array(N * 6);
    for (let i = 0; i < N; i++) {
      const cx = pc[i * 4]!, cy = pc[i * 4 + 1]!, r = pc[i * 4 + 2]!, drawId = pc[i * 4 + 3]!;
      for (let v = 0; v < 4; v++) {
        const vi = i * 4 + v;
        center[vi * 2] = cx;
        center[vi * 2 + 1] = cy;
        corner[vi * 2] = POINT_CORNERS[v]![0];
        corner[vi * 2 + 1] = POINT_CORNERS[v]![1];
        radius[vi] = r;
        pointId[vi] = drawId;
      }
      const base = vertexBase + i * 4;
      const ii = i * 6;
      index[ii] = base;
      index[ii + 1] = base + 1;
      index[ii + 2] = base + 2;
      index[ii + 3] = base;
      index[ii + 4] = base + 2;
      index[ii + 5] = base + 3;
    }
    return { center, corner, radius, pointId, index };
  }

  private buildPointPass(buffers: GroupBuffers): PointPass | null {
    const N = buffers.pointCount;
    if (N === 0) return null;
    const device = this.device;

    const e = GroupRenderer.expandPoints(buffers.pointCenters, 0);
    const center = new GrowBuffer(device, Float32Array, e.center);
    const corner = new GrowBuffer(device, Float32Array, e.corner);
    const radius = new GrowBuffer(device, Float32Array, e.radius);
    const pointId = new GrowBuffer(device, Float32Array, e.pointId);
    const index = new GrowBuffer(device, Uint32Array, e.index, true);

    // Reuse the shape pass's FILL color table (same realId-indexed semantics) if available,
    // else build owned ones from fillColors/flags.
    let colorTex: GrowTexture;
    let flagsTex: GrowTexture;
    let ownsTextures: boolean;
    if (this.shape) {
      colorTex = this.shape.colorTex;
      flagsTex = this.shape.flagsTex;
      ownsTextures = false;
    } else {
      const count = buffers.fillColors.length / 4;
      colorTex = new GrowTexture(device, 4, "rgba8unorm", buffers.fillColors, count);
      flagsTex = new GrowTexture(device, 1, "r8unorm", buffers.flags, count);
      ownsTextures = true;
    }

    const attributes = {
      a_center: center.buffer,
      a_corner: corner.buffer,
      a_radius: radius.buffer,
      a_pointId: pointId.buffer,
    };
    const bindings = { u_colorTable: colorTex.texture, u_flags: flagsTex.texture };
    const uniforms: Record<string, unknown> = {
      u_transform: this.transform,
      u_pointScreen: 0,
      u_viewport: new Float32Array([this.viewportWidth, this.viewportHeight]),
    };

    const model = new Model(device, {
      vs: POINT_VS,
      fs: POINT_FS,
      bufferLayout: POINT_LAYOUT,
      attributes,
      indexBuffer: index.buffer,
      bindings,
      uniforms,
      topology: "triangle-list" as const,
      vertexCount: e.index.length,
    });

    return {
      center, corner, radius, pointId, index,
      vertexCount: N * 4,
      colorTex, flagsTex, ownsTextures,
      model, uniforms, drawableCount: buffers.drawableCount,
    };
  }

  /**
   * Append a tail delta in O(new): interleave the new drawables' fill+stroke into the
   * merged geometry buffers (capacity-doubling) and grow the color/flags textures
   * (partial upload, or recreate on a dimension change). Same observable result as a
   * full rebuild.
   *
   * Limitation: a pass that does not yet exist (the group was built with NO fill/stroke
   * geometry at all and the first such geometry arrives now) cannot be created
   * incrementally here — we lack the full buffers. The engine guards this by routing such
   * a case to a full rebuild instead. (Unlike the old split fill/stroke passes, a layer
   * that already has *either* fill or stroke can grow into the other type without a rebuild,
   * since both share one pass.)
   */
  append(delta: GroupBufferDelta): boolean {
    let ok = true;
    if (delta.fillIndices.length > 0 || delta.strokeIndices.length > 0) {
      if (this.shape) this.appendShape(delta);
      else ok = false; // no shape pass yet; caller falls back to a rebuild
    }
    if (delta.pointCenters.length > 0) {
      if (this.point) this.appendPointPass(this.point, delta.pointCenters, delta.fillColors, delta.flags, delta.drawableCount);
      else ok = false;
    }
    return ok;
  }

  private appendShape(delta: GroupBufferDelta): void {
    const pass = this.shape!;
    const mergedVertexBase = pass.position.length / 2; // 2 floats per vertex
    const m = GroupRenderer.interleave(
      delta.fillVertices, delta.strokeVertices,
      delta.fillAnchors, delta.strokeAnchors,
      delta.fillIndices, delta.strokeIndices,
      delta.ranges, mergedVertexBase,
    );
    const realloc =
      [pass.position.append(m.pos), pass.id.append(m.id), pass.anchor.append(m.anchor), pass.isStroke.append(m.isStroke), pass.index.append(m.index)]
        .reduce((a, b) => a || b, false);
    if (realloc) {
      const attributes = {
        a_position: pass.position.buffer,
        a_anchor: pass.anchor.buffer,
        a_drawableId: pass.id.buffer,
        a_isStroke: pass.isStroke.buffer,
      };
      pass.fillModel.setAttributes(attributes);
      pass.fillModel.setIndexBuffer(pass.index.buffer);
      pass.pickModel.setAttributes(attributes);
      pass.pickModel.setIndexBuffer(pass.index.buffer);
    }
    pass.fillModel.setVertexCount(pass.index.length);
    pass.pickModel.setVertexCount(pass.index.length);
    // Grow the fill/stroke/flags textures (partial row upload, or recreate on overflow).
    this.growShapeTextures(delta.fillColors, delta.strokeColors, delta.flags, delta.drawableCount);
  }

  /** Append fill/stroke colors + flags for the shape pass: O(new) partial row upload, recreate on overflow. */
  private growShapeTextures(deltaFill: Uint8Array, deltaStroke: Uint8Array, deltaFlags: Uint8Array, newCount: number): void {
    const pass = this.shape!;
    // A borrowing point pass shares the FILL color table + flags, so rebind it if a recreate
    // swaps the underlying texture.
    const pointBorrows = !!this.point && !this.point.ownsTextures && this.point.colorTex === pass.colorTex;
    // Call all (no short-circuit): every table must consume its delta.
    const colorRecreated = pass.colorTex.append(deltaFill, newCount);
    const strokeRecreated = pass.strokeColorTex.append(deltaStroke, newCount);
    const flagsRecreated = pass.flagsTex.append(deltaFlags, newCount);
    pass.drawableCount = newCount;
    if (colorRecreated || strokeRecreated || flagsRecreated) {
      pass.fillModel.setBindings({ u_colorTable: pass.colorTex.texture, u_strokeTable: pass.strokeColorTex.texture, u_flags: pass.flagsTex.texture });
      pass.pickModel.setBindings({ u_colorTable: pass.colorTex.texture, u_strokeTable: pass.strokeColorTex.texture, u_flags: pass.flagsTex.texture });
      if (pointBorrows && this.point) this.point.model.setBindings({ u_colorTable: pass.colorTex.texture, u_flags: pass.flagsTex.texture });
    }
  }

  private appendPointPass(
    pp: PointPass,
    deltaPointCenters: Float32Array,
    deltaColors: Uint8Array,
    deltaFlags: Uint8Array,
    newDrawableCount: number,
  ): void {
    const e = GroupRenderer.expandPoints(deltaPointCenters, pp.vertexCount);
    const realloc =
      [pp.center.append(e.center), pp.corner.append(e.corner), pp.radius.append(e.radius), pp.pointId.append(e.pointId), pp.index.append(e.index)]
        .reduce((a, b) => a || b, false);
    pp.vertexCount += (deltaPointCenters.length / 4) * 4;
    if (realloc) {
      pp.model.setAttributes({
        a_center: pp.center.buffer,
        a_corner: pp.corner.buffer,
        a_radius: pp.radius.buffer,
        a_pointId: pp.pointId.buffer,
      });
      pp.model.setIndexBuffer(pp.index.buffer);
    }
    pp.model.setVertexCount(pp.index.length);
    // If this pass owns its textures (no fill pass), grow them; otherwise the fill pass
    // owns them and its own append (with the same delta colors/flags) already grew them
    // — and the shared GrowTexture refs mean pp already sees the new textures; we only
    // rebind pp.model on a recreate, which growPassTextures handles for the borrow case.
    if (pp.ownsTextures) {
      const colorRecreated = pp.colorTex.append(deltaColors, newDrawableCount);
      const flagsRecreated = pp.flagsTex.append(deltaFlags, newDrawableCount);
      if (colorRecreated || flagsRecreated) {
        pp.model.setBindings({ u_colorTable: pp.colorTex.texture, u_flags: pp.flagsTex.texture });
      }
    }
    pp.drawableCount = newDrawableCount;
  }

  /**
   * Re-upload the color and flag tables from fresh buffers. Touches only the
   * palette/flags textures — geometry buffers are untouched, so this is the cheap
   * recolor / show-hide hot path.
   *
   * Precondition: the drawable set is unchanged (same count) — this is recolor /
   * show-hide, not a geometry change. Adding drawables goes through append(). A count
   * mismatch throws rather than silently corrupting.
   */
  updateColors(buffers: GroupBuffers): void {
    if (this.shape) {
      const count = buffers.fillColors.length / 4;
      if (count !== this.shape.drawableCount) {
        throw new Error(
          `updateColors drawable count ${count} != ${this.shape.drawableCount} at build time; ` +
            `appended drawables must go through append()`,
        );
      }
      this.shape.colorTex.write(buffers.fillColors);
      this.shape.strokeColorTex.write(buffers.strokeColors);
      this.shape.flagsTex.write(buffers.flags);
    }
    // If the point pass owns its own textures (no shape pass), update them too.
    if (this.point?.ownsTextures) {
      this.writePointTables(this.point, buffers.fillColors, buffers.flags);
    }
    // If point borrows from the shape pass, the writes above already updated those textures.
  }

  private writePointTables(pp: PointPass, colors: Uint8Array, flags: Uint8Array): void {
    const count = colors.length / 4;
    if (count !== pp.drawableCount) {
      throw new Error(
        `updateColors drawable count ${count} != ${pp.drawableCount} at build time; ` +
          `appended drawables must go through append()`,
      );
    }
    pp.colorTex.write(colors);
    pp.flagsTex.write(flags);
  }

  private static STENCIL = {
    off:   { depthCompare: "always", depthWriteEnabled: false, stencilCompare: "always" },
    write: { depthCompare: "always", depthWriteEnabled: false, stencilCompare: "equal", stencilReadMask: 0x01, stencilWriteMask: 0x01, stencilPassOperation: "increment-clamp", stencilFailOperation: "keep", stencilDepthFailOperation: "keep" },
    test:  { depthCompare: "always", depthWriteEnabled: false, stencilCompare: "not-equal", stencilReadMask: 0x01, stencilWriteMask: 0x01, stencilPassOperation: "keep", stencilFailOperation: "keep", stencilDepthFailOperation: "keep" },
  } as const;

  // Standard (non-premultiplied) alpha blending so a fill/stroke color with alpha < 1
  // (e.g. "#9bd1a466") composites over what's behind it instead of rendering opaque.
  // Opaque colors (alpha = 1) are unaffected: src·1 + dst·0 = src. Applied to the
  // shape/point models — NOT the pick model, whose ids must stay exact.
  private static BLEND = {
    blend: true,
    blendColorOperation: "add", blendColorSrcFactor: "src-alpha", blendColorDstFactor: "one-minus-src-alpha",
    blendAlphaOperation: "add", blendAlphaSrcFactor: "one", blendAlphaDstFactor: "one-minus-src-alpha",
  } as const;

  /** Switch stencil state for clipping. "write" = clip source (mask), "test" = clipped layer, "off" = normal. */
  setStencil(mode: "off" | "write" | "test"): void {
    const params = { ...GroupRenderer.BLEND, ...GroupRenderer.STENCIL[mode] } as Record<string, unknown>;
    if (this.shape) this.shape.fillModel.setParameters(params);
    if (this.point) this.point.model.setParameters(params);
  }

  /** Set the view transform (column-major mat3) for pan/zoom. */
  setTransform(m: Float32Array): void {
    this.transform = m;
    // Mutate the shared uniforms dict in-place; Model reads this.props.uniforms on every draw.
    if (this.shape) this.shape.uniforms["u_transform"] = m;
    if (this.point) this.point.uniforms["u_transform"] = m;
  }

  /**
   * Switch the size mode for the next render. "screen" renders fill/stroke (via the
   * anchor + offset model) and points at a constant pixel size; "world" scales with zoom.
   * Default "world".
   */
  setSizeMode(mode: "world" | "screen"): void {
    const s = mode === "screen" ? 1.0 : 0.0;
    if (this.shape) this.shape.uniforms["u_screen"] = s;
    if (this.point) this.point.uniforms["u_pointScreen"] = s;
  }

  /** Draw the combined fill+stroke pass (painter's order), then the point pass. */
  render(renderPass: RenderPass): void {
    if (this.shape) this.shape.fillModel.draw(renderPass);
    if (this.point) this.point.model.draw(renderPass);
  }

  /**
   * Draw the fill+stroke geometry with each drawable's id encoded as an RGB color, for
   * GPU color-picking. Render this into a dedicated offscreen pass, then read the
   * pixel under the cursor and decode it with decodePickColor().
   */
  renderPick(renderPass: RenderPass): void {
    if (this.shape) this.shape.pickModel.draw(renderPass);
  }

  destroy(): void {
    if (this.shape) {
      this.shape.position.destroy();
      this.shape.id.destroy();
      this.shape.anchor.destroy();
      this.shape.isStroke.destroy();
      this.shape.index.destroy();
      this.shape.colorTex.destroy();
      this.shape.strokeColorTex.destroy();
      this.shape.flagsTex.destroy();
      this.shape.fillModel.destroy();
      this.shape.pickModel.destroy();
    }
    if (this.point) {
      this.point.center.destroy();
      this.point.corner.destroy();
      this.point.radius.destroy();
      this.point.pointId.destroy();
      this.point.index.destroy();
      this.point.model.destroy();
      // Only destroy textures if they are owned (not shared with the shape pass —
      // borrowed GrowTextures are the shape pass's and are destroyed above).
      if (this.point.ownsTextures) {
        this.point.colorTex.destroy();
        this.point.flagsTex.destroy();
      }
    }
  }
}
