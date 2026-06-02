import { Buffer } from "@luma.gl/core";
import type { Device, Texture, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { GroupBuffers } from "../core/index.js";
import { paletteDimensions, padPalette, padFlags } from "./palette.js";
import { FILL_VS, FILL_FS, PICK_FS, POINT_VS, POINT_FS } from "./shaders.js";

const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** GPU resources for one geometry pass (fill or stroke). */
interface Pass {
  positionBuffer: Buffer;
  idBuffer: Buffer;
  anchorBuffer: Buffer;
  indexBuffer: Buffer;
  colorTexture: Texture;
  flagsTexture: Texture;
  fillModel: Model;
  pickModel: Model;
  /** Shared uniforms object — mutated in-place by setTransform so the next draw picks it up. */
  uniforms: Record<string, unknown>;
  /** Drawable count at build time; updateColors must be called with the same count. */
  drawableCount: number;
}

/** GPU resources for the analytic point pass. */
interface PointPass {
  centerBuffer: Buffer;
  cornerBuffer: Buffer;
  radiusBuffer: Buffer;
  pointIdBuffer: Buffer;
  indexBuffer: Buffer;
  /** Color/flags textures — either shared with fill pass or owned. */
  colorTexture: Texture;
  flagsTexture: Texture;
  /** Whether this pass owns the textures (false = borrowed from fill pass). */
  ownsTextures: boolean;
  model: Model;
  uniforms: Record<string, unknown>;
  drawableCount: number;
}

/**
 * Renders one Scene group on the GPU. Geometry is uploaded once; pan/zoom is a
 * transform-uniform update and recolor/visibility is a palette/flags texture
 * update — neither touches the geometry buffers.
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

  private buildPass(
    verts: Float32Array,
    indices: Uint32Array,
    colors: Uint8Array,
    flags: Uint8Array,
    anchors: Float32Array,
  ): Pass | null {
    if (indices.length === 0) return null;
    const device = this.device;

    // De-interleave the stride-3 [x, y, drawableId] vertices into separate
    // position and id buffers (keeps us on the spike-verified buffer layout).
    const n = verts.length / 3;
    const pos = new Float32Array(n * 2);
    const ids = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[2 * i] = verts[3 * i]!;
      pos[2 * i + 1] = verts[3 * i + 1]!;
      ids[i] = verts[3 * i + 2]!;
    }
    const positionBuffer = device.createBuffer({ data: pos });
    const idBuffer = device.createBuffer({ data: ids });
    const anchorBuffer = device.createBuffer({ data: anchors });
    const indexBuffer = device.createBuffer({
      data: indices,
      usage: Buffer.INDEX,
      indexType: "uint32",
    });

    const count = colors.length / 4;
    const dims = paletteDimensions(count);
    const colorTexture = device.createTexture({
      data: padPalette(colors, dims),
      width: dims.width,
      height: dims.height,
      format: "rgba8unorm",
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });
    const flagsTexture = device.createTexture({
      data: padFlags(flags, dims),
      width: dims.width,
      height: dims.height,
      format: "r8unorm",
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });

    const bufferLayout = [
      { name: "a_position", format: "float32x2" as const },
      { name: "a_anchor", format: "float32x2" as const },
      { name: "a_drawableId", format: "float32" as const },
    ];
    const attributes = { a_position: positionBuffer, a_anchor: anchorBuffer, a_drawableId: idBuffer };
    const bindings = { u_colorTable: colorTexture, u_flags: flagsTexture };
    // Use a shared uniforms object so setTransform mutations are picked up on the next draw.
    const uniforms: Record<string, unknown> = {
      u_transform: this.transform,
      u_screen: 0,
      u_viewport: new Float32Array([this.viewportWidth, this.viewportHeight]),
    };
    const common = {
      bufferLayout,
      attributes,
      indexBuffer,
      bindings,
      uniforms,
      topology: "triangle-list" as const,
      // For indexed draws luma derives the draw count from the index buffer; this
      // is the index count and is accepted but redundant.
      vertexCount: indices.length,
    };

    const fillModel = new Model(device, { ...common, vs: FILL_VS, fs: FILL_FS });
    // pickModel shares geometry/bindings/uniforms with fillModel; it is drawn only
    // by renderPick() (GPU color-picking, added in a later task).
    const pickModel = new Model(device, { ...common, vs: FILL_VS, fs: PICK_FS });
    return { positionBuffer, idBuffer, anchorBuffer, indexBuffer, colorTexture, flagsTexture, fillModel, pickModel, uniforms, drawableCount: count };
  }

  private buildPointPass(buffers: GroupBuffers): PointPass | null {
    const N = buffers.pointCount;
    if (N === 0) return null;
    const device = this.device;
    const pc = buffers.pointCenters; // stride 4: [x, y, radius, drawableId]

    // Expand each circle to a quad (4 verts, 6 indices).
    const centerData = new Float32Array(N * 4 * 2);
    const cornerData = new Float32Array(N * 4 * 2);
    const radiusData = new Float32Array(N * 4);
    const pointIdData = new Float32Array(N * 4);
    const indexData = new Uint32Array(N * 6);

    const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

    for (let i = 0; i < N; i++) {
      const cx = pc[i * 4]!;
      const cy = pc[i * 4 + 1]!;
      const r = pc[i * 4 + 2]!;
      const drawId = pc[i * 4 + 3]!;
      for (let v = 0; v < 4; v++) {
        const vi = i * 4 + v;
        centerData[vi * 2] = cx;
        centerData[vi * 2 + 1] = cy;
        cornerData[vi * 2] = corners[v]![0];
        cornerData[vi * 2 + 1] = corners[v]![1];
        radiusData[vi] = r;
        pointIdData[vi] = drawId;
      }
      const base = i * 4;
      const ii = i * 6;
      indexData[ii] = base;
      indexData[ii + 1] = base + 1;
      indexData[ii + 2] = base + 2;
      indexData[ii + 3] = base;
      indexData[ii + 4] = base + 2;
      indexData[ii + 5] = base + 3;
    }

    const centerBuffer = device.createBuffer({ data: centerData });
    const cornerBuffer = device.createBuffer({ data: cornerData });
    const radiusBuffer = device.createBuffer({ data: radiusData });
    const pointIdBuffer = device.createBuffer({ data: pointIdData });
    const indexBuffer = device.createBuffer({
      data: indexData,
      usage: Buffer.INDEX,
      indexType: "uint32",
    });

    // Reuse fill pass textures if available, else build from fillColors/flags.
    let colorTexture: Texture;
    let flagsTexture: Texture;
    let ownsTextures: boolean;
    if (this.fill) {
      colorTexture = this.fill.colorTexture;
      flagsTexture = this.fill.flagsTexture;
      ownsTextures = false;
    } else {
      const count = buffers.fillColors.length / 4;
      const dims = paletteDimensions(count);
      colorTexture = device.createTexture({
        data: padPalette(buffers.fillColors, dims),
        width: dims.width,
        height: dims.height,
        format: "rgba8unorm",
        mipLevels: 1,
        sampler: { minFilter: "nearest", magFilter: "nearest" },
      });
      flagsTexture = device.createTexture({
        data: padFlags(buffers.flags, dims),
        width: dims.width,
        height: dims.height,
        format: "r8unorm",
        mipLevels: 1,
        sampler: { minFilter: "nearest", magFilter: "nearest" },
      });
      ownsTextures = true;
    }

    const bufferLayout = [
      { name: "a_center", format: "float32x2" as const },
      { name: "a_corner", format: "float32x2" as const },
      { name: "a_radius", format: "float32" as const },
      { name: "a_pointId", format: "float32" as const },
    ];
    const attributes = {
      a_center: centerBuffer,
      a_corner: cornerBuffer,
      a_radius: radiusBuffer,
      a_pointId: pointIdBuffer,
    };
    const bindings = { u_colorTable: colorTexture, u_flags: flagsTexture };
    const uniforms: Record<string, unknown> = {
      u_transform: this.transform,
      u_pointScreen: 0,
      u_viewport: new Float32Array([this.viewportWidth, this.viewportHeight]),
    };

    const model = new Model(device, {
      vs: POINT_VS,
      fs: POINT_FS,
      bufferLayout,
      attributes,
      indexBuffer,
      bindings,
      uniforms,
      topology: "triangle-list" as const,
      vertexCount: indexData.length,
    });

    return {
      centerBuffer,
      cornerBuffer,
      radiusBuffer,
      pointIdBuffer,
      indexBuffer,
      colorTexture,
      flagsTexture,
      ownsTextures,
      model,
      uniforms,
      drawableCount: buffers.drawableCount,
    };
  }

  private passes(): Pass[] {
    return [this.fill, this.stroke].filter((p): p is Pass => p !== null);
  }

  /**
   * Re-upload the color and flag tables from fresh buffers. Touches only the
   * palette/flags textures — geometry buffers are untouched, so this is the cheap
   * recolor / show-hide hot path.
   *
   * Precondition: the drawable set is unchanged (same count) — this is recolor /
   * show-hide, not a geometry change. Adding or removing drawables requires a new
   * GroupRenderer. A count mismatch throws rather than silently corrupting.
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
          `create a new GroupRenderer for a changed drawable set`,
      );
    }
    const dims = paletteDimensions(count);
    pass.colorTexture.writeData(padPalette(colors, dims), {
      x: 0,
      y: 0,
      width: dims.width,
      height: dims.height,
    });
    pass.flagsTexture.writeData(padFlags(flags, dims), {
      x: 0,
      y: 0,
      width: dims.width,
      height: dims.height,
    });
  }

  private writePointTables(pp: PointPass, colors: Uint8Array, flags: Uint8Array): void {
    const count = colors.length / 4;
    if (count !== pp.drawableCount) {
      throw new Error(
        `updateColors drawable count ${count} != ${pp.drawableCount} at build time; ` +
          `create a new GroupRenderer for a changed drawable set`,
      );
    }
    const dims = paletteDimensions(count);
    pp.colorTexture.writeData(padPalette(colors, dims), { x: 0, y: 0, width: dims.width, height: dims.height });
    pp.flagsTexture.writeData(padFlags(flags, dims), { x: 0, y: 0, width: dims.width, height: dims.height });
  }

  private static STENCIL = {
    off:   { depthCompare: "always", depthWriteEnabled: false, stencilCompare: "always" },
    write: { depthCompare: "always", depthWriteEnabled: false, stencilCompare: "equal", stencilReadMask: 0x01, stencilWriteMask: 0x01, stencilPassOperation: "increment-clamp", stencilFailOperation: "keep", stencilDepthFailOperation: "keep" },
    test:  { depthCompare: "always", depthWriteEnabled: false, stencilCompare: "not-equal", stencilReadMask: 0x01, stencilWriteMask: 0x01, stencilPassOperation: "keep", stencilFailOperation: "keep", stencilDepthFailOperation: "keep" },
  } as const;

  /** Switch stencil state for clipping. "write" = clip source (mask), "test" = clipped layer, "off" = normal. */
  setStencil(mode: "off" | "write" | "test"): void {
    const params = GroupRenderer.STENCIL[mode] as Record<string, unknown>;
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
      pass.positionBuffer.destroy();
      pass.idBuffer.destroy();
      pass.anchorBuffer.destroy();
      pass.indexBuffer.destroy();
      pass.colorTexture.destroy();
      pass.flagsTexture.destroy();
      pass.fillModel.destroy();
      pass.pickModel.destroy();
    }
    if (this.point) {
      this.point.centerBuffer.destroy();
      this.point.cornerBuffer.destroy();
      this.point.radiusBuffer.destroy();
      this.point.pointIdBuffer.destroy();
      this.point.indexBuffer.destroy();
      this.point.model.destroy();
      // Only destroy textures if they are owned (not shared with fill pass).
      if (this.point.ownsTextures) {
        this.point.colorTexture.destroy();
        this.point.flagsTexture.destroy();
      }
    }
  }
}
