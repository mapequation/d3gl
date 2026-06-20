import { Model } from "@luma.gl/engine";
import type { Buffer, Device, RenderPass } from "@luma.gl/core";
import { INSTANCED_CIRCLE_VS, POINT_FS } from "./shaders.js";
import { clipFromView } from "./transform.js";
import type { InstancedCirclesData } from "../core/index.js";

/**
 * GPU-instanced primitives for the network module's rendering lane (#100, epic #98).
 *
 * Unlike the retained `Scene`/`GroupRenderer` path (quad-expanded points,
 * tessellated paths), this draws directly from columnar SoA instance buffers via
 * true GPU instancing — one instance per primitive, a shared unit-quad template.
 * It's the shared lane the network engine renders through; `plot.points()` migrates
 * onto it later (#108).
 */

/** Unit-quad corners as a triangle-strip (shared across all instances). */
const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

/** Standard premultiplied-over alpha blending (matches the pass-through path). */
const BLEND = {
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one-minus-src-alpha",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one-minus-src-alpha",
} as const;

export class InstancedCircles {
  count: number;
  private model: Model;
  private corner: Buffer;
  private center: Buffer;
  private radius: Buffer;
  private color: Buffer;
  private uniforms: Record<string, unknown>;

  constructor(device: Device, data: InstancedCirclesData, width = 0, height = 0) {
    this.count = data.count;
    this.corner = device.createBuffer({ data: QUAD });
    this.center = device.createBuffer({ data: data.centers });
    this.radius = device.createBuffer({ data: data.radii });
    this.color = device.createBuffer({ data: data.colors });
    this.uniforms = {
      u_transform: clipFromView({ k: 1, x: 0, y: 0 }, width || 1, height || 1),
      u_screen: 0,
      u_viewport: [width, height],
    };
    this.model = new Model(device, {
      vs: INSTANCED_CIRCLE_VS,
      fs: POINT_FS,
      bufferLayout: [
        { name: "a_corner", format: "float32x2" },
        { name: "a_center", format: "float32x2", stepMode: "instance" },
        { name: "a_radius", format: "float32", stepMode: "instance" },
        { name: "a_color", format: "unorm8x4", stepMode: "instance" },
      ],
      attributes: {
        a_corner: this.corner,
        a_center: this.center,
        a_radius: this.radius,
        a_color: this.color,
      },
      uniforms: this.uniforms,
      parameters: BLEND,
      topology: "triangle-strip",
      vertexCount: 4,
      instanceCount: this.count,
    });
  }

  /** Set the column-major mat3 clip transform (from {@link clipFromView}). */
  setTransform(m: Float32Array): void {
    this.uniforms["u_transform"] = m;
  }
  setViewport(width: number, height: number): void {
    this.uniforms["u_viewport"] = [width, height];
  }
  setSizeMode(mode: "world" | "screen"): void {
    this.uniforms["u_screen"] = mode === "screen" ? 1 : 0;
  }
  render(pass: RenderPass): void {
    if (this.count > 0) this.model.draw(pass);
  }
  destroy(): void {
    this.model.destroy();
    this.corner.destroy();
    this.center.destroy();
    this.radius.destroy();
    this.color.destroy();
  }
}
