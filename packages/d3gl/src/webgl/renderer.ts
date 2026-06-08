import { Buffer } from "@luma.gl/core";
import type { Device, Texture, RenderPass, TextureFormat } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { GroupBuffers, GroupBufferDelta } from "../core/index.js";
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

/** GPU resources for one geometry pass (fill or stroke). */
interface Pass {
  position: GrowBuffer;
  id: GrowBuffer;
  anchor: GrowBuffer;
  index: GrowBuffer;
  /** Per-drawable RGBA color table (rgba8unorm), grown with partial row uploads. */
  colorTex: GrowTexture;
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
  private fill: Pass | null;
  private stroke: Pass | null;
  private point: PointPass | null;

  constructor(
    private readonly device: Device,
    buffers: GroupBuffers,
    /** Viewport width in device pixels (for screen-mode point sizing). */
    private viewportWidth = 0,
    /** Viewport height in device pixels (for screen-mode point sizing). */
    private viewportHeight = 0,
  ) {
    this.fill = this.buildPass(
      buffers.fillVertices,
      buffers.fillIndices,
      buffers.fillColors,
      buffers.flags,
      buffers.fillAnchors,
    );
    this.stroke = this.buildPass(
      buffers.strokeVertices,
      buffers.strokeIndices,
      buffers.strokeColors,
      buffers.flags,
      buffers.strokeAnchors,
    );
    this.point = this.buildPointPass(buffers);
  }

  /** De-interleave stride-3 [x,y,id] verts into position(2/vert) + id(1/vert). */
  private static deinterleave(verts: Float32Array): { pos: Float32Array; ids: Float32Array } {
    const n = verts.length / 3;
    const pos = new Float32Array(n * 2);
    const ids = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[2 * i] = verts[3 * i]!;
      pos[2 * i + 1] = verts[3 * i + 1]!;
      ids[i] = verts[3 * i + 2]!;
    }
    return { pos, ids };
  }

  private buildPass(
    verts: Float32Array,
    indices: Uint32Array,
    colors: Uint8Array,
    flags: Uint8Array,
    anchors: Float32Array,
  ): Pass | null {
    if (indices.length === 0) return null;
    const device = this.device;

    const { pos, ids } = GroupRenderer.deinterleave(verts);
    const position = new GrowBuffer(device, Float32Array, pos);
    const id = new GrowBuffer(device, Float32Array, ids);
    const anchor = new GrowBuffer(device, Float32Array, anchors);
    const index = new GrowBuffer(device, Uint32Array, indices, true);

    const count = colors.length / 4;
    const colorTex = new GrowTexture(device, 4, "rgba8unorm", colors, count);
    const flagsTex = new GrowTexture(device, 1, "r8unorm", flags, count);

    const attributes = { a_position: position.buffer, a_anchor: anchor.buffer, a_drawableId: id.buffer };
    const bindings = { u_colorTable: colorTex.texture, u_flags: flagsTex.texture };
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
      vertexCount: indices.length,
    };

    const fillModel = new Model(device, { ...common, vs: FILL_VS, fs: FILL_FS });
    // pickModel shares geometry/bindings/uniforms with fillModel; it is drawn only
    // by renderPick() (GPU color-picking).
    const pickModel = new Model(device, { ...common, vs: FILL_VS, fs: PICK_FS });
    return {
      position, id, anchor, index, colorTex, flagsTex,
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

    // Reuse fill pass textures if available (share the same GrowTexture refs),
    // else build owned ones from fillColors/flags.
    let colorTex: GrowTexture;
    let flagsTex: GrowTexture;
    let ownsTextures: boolean;
    if (this.fill) {
      colorTex = this.fill.colorTex;
      flagsTex = this.fill.flagsTex;
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

  private passes(): Pass[] {
    return [this.fill, this.stroke].filter((p): p is Pass => p !== null);
  }

  /**
   * Append a tail delta in O(new): grow the geometry buffers (capacity-doubling)
   * and the color/flags textures (partial upload, or recreate on a dimension change),
   * bumping the draw (index) count. Same observable result as a full rebuild.
   *
   * Limitation: a pass that does not yet exist (e.g. the first stroke geometry arriving
   * on an append to a previously stroke-less layer) cannot be created incrementally here
   * — we lack the full buffers. The engine guards this by routing such a case to a full
   * `updateLayer` rebuild instead; in practice layers keep a stable geometry-type mix.
   */
  append(delta: GroupBufferDelta): boolean {
    let ok = true;
    if (delta.fillIndices.length > 0) {
      if (this.fill) this.appendPass(this.fill, delta.fillVertices, delta.fillIndices, delta.fillColors, delta.flags, delta.fillAnchors, delta.drawableCount);
      else ok = false; // pass absent; caller falls back to a rebuild
    }
    if (delta.strokeIndices.length > 0) {
      if (this.stroke) this.appendPass(this.stroke, delta.strokeVertices, delta.strokeIndices, delta.strokeColors, delta.flags, delta.strokeAnchors, delta.drawableCount);
      else ok = false;
    }
    if (delta.pointCenters.length > 0) {
      if (this.point) this.appendPointPass(this.point, delta.pointCenters, delta.fillColors, delta.flags, delta.drawableCount);
      else ok = false;
    }
    return ok;
  }

  private appendPass(
    pass: Pass,
    deltaVerts: Float32Array,
    deltaIndices: Uint32Array,
    deltaColors: Uint8Array,
    deltaFlags: Uint8Array,
    deltaAnchors: Float32Array,
    newDrawableCount: number,
  ): void {
    const { pos, ids } = GroupRenderer.deinterleave(deltaVerts);
    // Index values are group-absolute — append verbatim.
    const realloc =
      [pass.position.append(pos), pass.id.append(ids), pass.anchor.append(deltaAnchors), pass.index.append(deltaIndices)]
        .reduce((a, b) => a || b, false);
    if (realloc) {
      const attributes = { a_position: pass.position.buffer, a_anchor: pass.anchor.buffer, a_drawableId: pass.id.buffer };
      pass.fillModel.setAttributes(attributes);
      pass.fillModel.setIndexBuffer(pass.index.buffer);
      pass.pickModel.setAttributes(attributes);
      pass.pickModel.setIndexBuffer(pass.index.buffer);
    }
    pass.fillModel.setVertexCount(pass.index.length);
    pass.pickModel.setVertexCount(pass.index.length);
    // Grow color/flags textures (partial row upload, or recreate on capacity overflow).
    this.growPassTextures(pass, deltaColors, deltaFlags, newDrawableCount);
  }

  /** Append color/flags for a fill/stroke pass: O(new) partial row upload, recreate on overflow. */
  private growPassTextures(pass: Pass, deltaColors: Uint8Array, deltaFlags: Uint8Array, newCount: number): void {
    // Track whether a borrowing point pass shares these GrowTextures, so we can rebind
    // its Model when an overflow recreates the underlying texture.
    const pointBorrows = !!this.point && !this.point.ownsTextures &&
      this.point.colorTex === pass.colorTex;
    // Call both (no short-circuit): both tables must consume their delta.
    const colorRecreated = pass.colorTex.append(deltaColors, newCount);
    const flagsRecreated = pass.flagsTex.append(deltaFlags, newCount);
    pass.drawableCount = newCount;
    if (colorRecreated || flagsRecreated) {
      const bindings = { u_colorTable: pass.colorTex.texture, u_flags: pass.flagsTex.texture };
      pass.fillModel.setBindings(bindings);
      pass.pickModel.setBindings(bindings);
      if (pointBorrows && this.point) this.point.model.setBindings(bindings);
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
    if (this.fill) this.writeTables(this.fill, buffers.fillColors, buffers.flags);
    if (this.stroke) this.writeTables(this.stroke, buffers.strokeColors, buffers.flags);
    // If the point pass owns its own textures (no fill pass), update them too.
    if (this.point?.ownsTextures) {
      this.writePointTables(this.point, buffers.fillColors, buffers.flags);
    }
    // If point borrows from fill, fill's writeTables above already updated those textures.
  }

  private writeTables(pass: Pass, colors: Uint8Array, flags: Uint8Array): void {
    const count = colors.length / 4;
    if (count !== pass.drawableCount) {
      throw new Error(
        `updateColors drawable count ${count} != ${pass.drawableCount} at build time; ` +
          `appended drawables must go through append()`,
      );
    }
    pass.colorTex.write(colors);
    pass.flagsTex.write(flags);
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
  // fill/stroke/point models — NOT the pick model, whose ids must stay exact.
  private static BLEND = {
    blend: true,
    blendColorOperation: "add", blendColorSrcFactor: "src-alpha", blendColorDstFactor: "one-minus-src-alpha",
    blendAlphaOperation: "add", blendAlphaSrcFactor: "one", blendAlphaDstFactor: "one-minus-src-alpha",
  } as const;

  /** Switch stencil state for clipping. "write" = clip source (mask), "test" = clipped layer, "off" = normal. */
  setStencil(mode: "off" | "write" | "test"): void {
    const params = { ...GroupRenderer.BLEND, ...GroupRenderer.STENCIL[mode] } as Record<string, unknown>;
    if (this.fill) this.fill.fillModel.setParameters(params);
    if (this.stroke) this.stroke.fillModel.setParameters(params);
    if (this.point) this.point.model.setParameters(params);
  }

  /** Set the view transform (column-major mat3) for pan/zoom. */
  setTransform(m: Float32Array): void {
    this.transform = m;
    // Mutate the shared uniforms dict in-place; Model reads this.props.uniforms on every draw.
    for (const pass of this.passes()) {
      pass.uniforms["u_transform"] = m;
    }
    if (this.point) this.point.uniforms["u_transform"] = m;
  }

  /**
   * Switch the size mode for the next render. "screen" renders fill/stroke (via the
   * anchor + offset model) and points at a constant pixel size; "world" scales with zoom.
   * Default "world".
   */
  setSizeMode(mode: "world" | "screen"): void {
    const s = mode === "screen" ? 1.0 : 0.0;
    for (const pass of this.passes()) pass.uniforms["u_screen"] = s;
    if (this.point) this.point.uniforms["u_pointScreen"] = s;
  }

  /** Draw the fill, stroke, then point passes into an open render pass. */
  render(renderPass: RenderPass): void {
    if (this.fill) this.fill.fillModel.draw(renderPass);
    if (this.stroke) this.stroke.fillModel.draw(renderPass);
    if (this.point) this.point.model.draw(renderPass);
  }

  /**
   * Draw the fill geometry with each drawable's id encoded as an RGB color, for
   * GPU color-picking. Render this into a dedicated offscreen pass, then read the
   * pixel under the cursor and decode it with decodePickColor().
   */
  renderPick(renderPass: RenderPass): void {
    if (this.fill) this.fill.pickModel.draw(renderPass);
  }

  destroy(): void {
    for (const pass of this.passes()) {
      pass.position.destroy();
      pass.id.destroy();
      pass.anchor.destroy();
      pass.index.destroy();
      pass.colorTex.destroy();
      pass.flagsTex.destroy();
      pass.fillModel.destroy();
      pass.pickModel.destroy();
    }
    if (this.point) {
      this.point.center.destroy();
      this.point.corner.destroy();
      this.point.radius.destroy();
      this.point.pointId.destroy();
      this.point.index.destroy();
      this.point.model.destroy();
      // Only destroy textures if they are owned (not shared with fill pass —
      // borrowed GrowTextures are the fill pass's and are destroyed above).
      if (this.point.ownsTextures) {
        this.point.colorTex.destroy();
        this.point.flagsTex.destroy();
      }
    }
  }
}
