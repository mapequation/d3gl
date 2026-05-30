import { Buffer } from "@luma.gl/core";
import type { Device, Texture, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { GroupBuffers } from "@d3gl/core";
import { paletteDimensions, padPalette, padFlags } from "./palette.js";
import { FILL_VS, FILL_FS, PICK_FS } from "./shaders.js";

const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** GPU resources for one geometry pass (fill or stroke). */
interface Pass {
  positionBuffer: Buffer;
  idBuffer: Buffer;
  indexBuffer: Buffer;
  colorTexture: Texture;
  flagsTexture: Texture;
  fillModel: Model;
  pickModel: Model;
  /** Shared uniforms object — mutated in-place by setTransform so the next draw picks it up. */
  uniforms: Record<string, unknown>;
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

  constructor(private readonly device: Device, buffers: GroupBuffers) {
    this.fill = this.buildPass(
      buffers.fillVertices,
      buffers.fillIndices,
      buffers.fillColors,
      buffers.flags,
    );
    this.stroke = this.buildPass(
      buffers.strokeVertices,
      buffers.strokeIndices,
      buffers.strokeColors,
      buffers.flags,
    );
  }

  private buildPass(
    verts: Float32Array,
    indices: Uint32Array,
    colors: Uint8Array,
    flags: Uint8Array,
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
      { name: "a_drawableId", format: "float32" as const },
    ];
    const attributes = { a_position: positionBuffer, a_drawableId: idBuffer };
    const bindings = { u_colorTable: colorTexture, u_flags: flagsTexture };
    // Use a shared uniforms object so setTransform mutations are picked up on the next draw.
    const uniforms: Record<string, unknown> = { u_transform: this.transform };
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
    return { positionBuffer, idBuffer, indexBuffer, colorTexture, flagsTexture, fillModel, pickModel, uniforms };
  }

  private passes(): Pass[] {
    return [this.fill, this.stroke].filter((p): p is Pass => p !== null);
  }

  /**
   * Re-upload the color and flag tables from fresh buffers. Touches only the
   * palette/flags textures — geometry buffers are untouched, so this is the cheap
   * recolor / show-hide hot path.
   */
  updateColors(buffers: GroupBuffers): void {
    if (this.fill) this.writeTables(this.fill, buffers.fillColors, buffers.flags);
    if (this.stroke) this.writeTables(this.stroke, buffers.strokeColors, buffers.flags);
  }

  private writeTables(pass: Pass, colors: Uint8Array, flags: Uint8Array): void {
    const dims = paletteDimensions(colors.length / 4);
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

  /** Set the view transform (column-major mat3) for pan/zoom. */
  setTransform(m: Float32Array): void {
    this.transform = m;
    // Mutate the shared uniforms dict in-place; Model reads this.props.uniforms on every draw.
    for (const pass of this.passes()) {
      pass.uniforms["u_transform"] = m;
    }
  }

  /** Draw the fill then stroke passes into an open render pass. */
  render(renderPass: RenderPass): void {
    if (this.fill) this.fill.fillModel.draw(renderPass);
    if (this.stroke) this.stroke.fillModel.draw(renderPass);
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
      pass.indexBuffer.destroy();
      pass.colorTexture.destroy();
      pass.flagsTexture.destroy();
      pass.fillModel.destroy();
      pass.pickModel.destroy();
    }
  }
}
