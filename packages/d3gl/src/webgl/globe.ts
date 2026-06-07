import { Buffer } from "@luma.gl/core";
import type { Device, Framebuffer, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { buildSphereMesh } from "./sphere-mesh.js";
import { GLOBE_VS, GLOBE_FS } from "./shaders.js";

const identity3 = (): Float32Array => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** Owns the equirectangular bake framebuffer and the textured-sphere model. The
 *  backend renders the map layers into `bakeTarget()` (the FBO), then calls `draw()`
 *  to paint the sphere sampling that texture under the current view. */
export class GlobeRenderer {
  private fbo: Framebuffer;
  private model: Model;
  /** Shared uniforms dict — mutated in-place so the next draw() picks up changes. */
  private uniforms: Record<string, unknown>;

  constructor(
    private device: Device,
    private texW: number,
    private texH: number,
    viewportW: number,
    viewportH: number,
  ) {
    this.fbo = this.makeFbo(texW, texH);
    const mesh = buildSphereMesh();
    const lonLat = device.createBuffer({ data: mesh.lonLat });
    const indexBuffer = device.createBuffer({ data: mesh.indices, usage: Buffer.INDEX, indexType: "uint32" });
    this.uniforms = {
      u_rotation: identity3(),
      u_scale: 0,
      u_center: new Float32Array([0, 0]),
      u_viewport: new Float32Array([viewportW, viewportH]),
    };
    this.model = new Model(device, {
      vs: GLOBE_VS,
      fs: GLOBE_FS,
      bufferLayout: [{ name: "a_lonLat", format: "float32x2" as const }],
      attributes: { a_lonLat: lonLat },
      indexBuffer,
      topology: "triangle-list" as const,
      vertexCount: mesh.indices.length,
      bindings: { u_map: this.colorTexture() },
      uniforms: this.uniforms,
      parameters: { depthWriteEnabled: true, depthCompare: "less-equal", cullMode: "back" },
    });
  }

  private makeFbo(w: number, h: number): Framebuffer {
    return this.device.createFramebuffer({
      width: w,
      height: h,
      colorAttachments: ["rgba8unorm"],
      depthStencilAttachment: "depth24plus-stencil8",
    });
  }

  /** The framebuffer the backend bakes the equirect map into. */
  bakeTarget(): Framebuffer {
    return this.fbo;
  }

  /** The FBO's color texture view, bound as u_map.
   *  In luma v9, colorAttachments[0] is a TextureView, which is a valid Binding. */
  private colorTexture() {
    return this.fbo.colorAttachments[0]!;
  }

  /** Resize the bake texture (power-of-2 level change). Recreates the FBO + rebinds. */
  setTextureSize(texW: number, texH: number): void {
    if (texW === this.texW && texH === this.texH) return;
    this.fbo.destroy();
    this.texW = texW;
    this.texH = texH;
    this.fbo = this.makeFbo(texW, texH);
    this.model.setBindings({ u_map: this.colorTexture() });
  }

  setRotation(m: Float32Array): void {
    this.uniforms["u_rotation"] = m;
  }

  /** Draw the sphere into an open pass. scale = globe radius px, center = px. */
  draw(pass: RenderPass, scale: number, center: [number, number]): void {
    this.uniforms["u_scale"] = scale;
    this.uniforms["u_center"] = new Float32Array(center);
    this.model.draw(pass);
  }

  destroy(): void {
    this.fbo.destroy();
    this.model.destroy();
  }
}
