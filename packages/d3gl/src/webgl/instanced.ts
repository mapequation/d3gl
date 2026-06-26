import { Model } from "@luma.gl/engine";
import type { Buffer, Device, RenderPass } from "@luma.gl/core";
import { INSTANCED_CIRCLE_VS, INSTANCED_CIRCLE_FS, INSTANCED_LINE_VS, INSTANCED_ARROW_VS, INSTANCED_HALF_ARROW_VS, POINT_FS, FILL_FS } from "./shaders.js";
import { clipFromView } from "./transform.js";
import type { InstancedCirclesData, InstancedLinesData, InstancedArrowsData, InstancedHalfArrowsData } from "../core/index.js";

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
  /** Current buffer capacity (in instances). Used by update() to decide grow vs. sub-update. */
  private _capacity: number;
  /** Whether the current buffers were allocated with borders (optional-field shape). */
  private _hasBorders: boolean;
  private model: Model;
  private corner: Buffer;
  private center: Buffer;
  private radius: Buffer;
  private color: Buffer;
  private border: Buffer;
  private borderColor: Buffer;
  private uniforms: Record<string, unknown>;

  constructor(device: Device, data: InstancedCirclesData, width = 0, height = 0) {
    this.count = data.count;
    this._capacity = data.count;
    this._hasBorders = data.borders != null;
    this.corner = device.createBuffer({ data: QUAD });
    this.center = device.createBuffer({ data: data.centers });
    this.radius = device.createBuffer({ data: data.radii });
    this.color = device.createBuffer({ data: data.colors });
    // Flow-border ring (#104 N6), optional: a per-instance thickness fraction + colour. Absent ⇒
    // zero-filled, so a_border = 0 and the shader draws a plain filled disc (unchanged appearance).
    this.border = device.createBuffer({ data: data.borders ?? new Float32Array(data.count) });
    this.borderColor = device.createBuffer({ data: data.borderColors ?? new Uint8Array(data.count * 4) });
    this.uniforms = {
      u_transform: clipFromView({ k: 1, x: 0, y: 0 }, width || 1, height || 1),
      u_screen: 0,
      u_viewport: [width, height],
    };
    this.model = new Model(device, {
      vs: INSTANCED_CIRCLE_VS,
      fs: INSTANCED_CIRCLE_FS,
      bufferLayout: [
        { name: "a_corner", format: "float32x2" },
        { name: "a_center", format: "float32x2", stepMode: "instance" },
        { name: "a_radius", format: "float32", stepMode: "instance" },
        { name: "a_color", format: "unorm8x4", stepMode: "instance" },
        { name: "a_border", format: "float32", stepMode: "instance" },
        { name: "a_borderColor", format: "unorm8x4", stepMode: "instance" },
      ],
      attributes: {
        a_corner: this.corner,
        a_center: this.center,
        a_radius: this.radius,
        a_color: this.color,
        a_border: this.border,
        a_borderColor: this.borderColor,
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

  /**
   * Update the instance data in place (no object recreation). Uses `gl.bufferSubData` when
   * `data.count ≤ current buffer capacity`; reallocates the internal GL buffers (but keeps the
   * SAME `InstancedCircles` object) when the new count exceeds capacity. If the optional-field
   * shape changes (borders present↔absent), falls back to a full buffer reinit.
   *
   * This is the per-frame hot path for the declutter instanced lane: calling this instead of
   * destroy()+new InstancedCircles() avoids per-frame GPU buffer teardown+recreate.
   */
  update(device: Device, data: InstancedCirclesData): void {
    const hasBorders = data.borders != null;
    // If optional-field shape changed or count exceeds capacity, reinit buffers.
    if (data.count > this._capacity || hasBorders !== this._hasBorders) {
      // Grow: destroy old instance buffers and create new ones at the new capacity.
      this.center.destroy();
      this.radius.destroy();
      this.color.destroy();
      this.border.destroy();
      this.borderColor.destroy();
      this._capacity = data.count;
      this._hasBorders = hasBorders;
      this.center = device.createBuffer({ data: data.centers });
      this.radius = device.createBuffer({ data: data.radii });
      this.color = device.createBuffer({ data: data.colors });
      this.border = device.createBuffer({ data: data.borders ?? new Float32Array(data.count) });
      this.borderColor = device.createBuffer({ data: data.borderColors ?? new Uint8Array(data.count * 4) });
      // Re-bind all attributes on the model (the buffer objects changed).
      this.model.setAttributes({
        a_center: this.center,
        a_radius: this.radius,
        a_color: this.color,
        a_border: this.border,
        a_borderColor: this.borderColor,
      });
    } else {
      // Sub-update: upload only the filled portion of the scratch buffers.
      this.center.write(data.centers);
      this.radius.write(data.radii);
      this.color.write(data.colors);
      if (hasBorders) {
        this.border.write(data.borders!);
        this.borderColor.write(data.borderColors!);
      }
    }
    this.count = data.count;
    this.model.setInstanceCount(data.count);
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
    this.border.destroy();
    this.borderColor.destroy();
  }
}

/**
 * Path-strip template: M samples × 2 sides as a triangle-strip, `(t, side)` per vertex with
 * `t = i/(M-1)` walking the path and `side ∈ {-1,1}` picking the edge. M=2 is the straight case
 * (= the original 4-vertex strip); higher M traces a smooth bezier (#104 N6c).
 */
function lineTemplate(samples: number): Float32Array {
  const M = Math.max(2, samples | 0);
  const t = new Float32Array(M * 4);
  for (let i = 0; i < M; i++) {
    const tt = i / (M - 1);
    t[i * 4] = tt;
    t[i * 4 + 1] = -1;
    t[i * 4 + 2] = tt;
    t[i * 4 + 3] = 1;
  }
  return t;
}

export class InstancedLines {
  count: number;
  private model: Model;
  private corner: Buffer;
  private source: Buffer;
  private target: Buffer;
  private widthBuf: Buffer;
  private color: Buffer;
  private bend: Buffer;
  private uniforms: Record<string, unknown>;

  constructor(device: Device, data: InstancedLinesData, width = 0, height = 0) {
    this.count = data.count;
    const samples = Math.max(2, (data.samples ?? 2) | 0);
    this.corner = device.createBuffer({ data: lineTemplate(samples) });
    this.source = device.createBuffer({ data: data.sources });
    this.target = device.createBuffer({ data: data.targets });
    this.widthBuf = device.createBuffer({ data: data.widths });
    this.color = device.createBuffer({ data: data.colors });
    // Per-instance bend (#104 N6c), optional: absent ⇒ zero ⇒ straight (control on the chord).
    this.bend = device.createBuffer({ data: data.bends ?? new Float32Array(data.count) });
    this.uniforms = {
      u_transform: clipFromView({ k: 1, x: 0, y: 0 }, width || 1, height || 1),
      u_screen: 0,
      u_viewport: [width, height],
    };
    this.model = new Model(device, {
      vs: INSTANCED_LINE_VS,
      fs: FILL_FS,
      bufferLayout: [
        { name: "a_corner", format: "float32x2" },
        { name: "a_source", format: "float32x2", stepMode: "instance" },
        { name: "a_target", format: "float32x2", stepMode: "instance" },
        { name: "a_width", format: "float32", stepMode: "instance" },
        { name: "a_color", format: "unorm8x4", stepMode: "instance" },
        { name: "a_bend", format: "float32", stepMode: "instance" },
      ],
      attributes: {
        a_corner: this.corner,
        a_source: this.source,
        a_target: this.target,
        a_width: this.widthBuf,
        a_color: this.color,
        a_bend: this.bend,
      },
      uniforms: this.uniforms,
      parameters: BLEND,
      topology: "triangle-strip",
      vertexCount: samples * 2,
      instanceCount: this.count,
    });
  }

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
    this.source.destroy();
    this.target.destroy();
    this.widthBuf.destroy();
    this.color.destroy();
    this.bend.destroy();
  }
}

/** Triangle template for an arrowhead: tip (0,0), base (2,-1)/(2,1), triangle-list. */
const ARROW_TEMPLATE = new Float32Array([0, 0, 2, -1, 2, 1]);
/** One-sided "half" arrowhead (#104 N6c): tip (0,0), base on one side only (2,0)/(2,1). */
const HALF_ARROW_TEMPLATE = new Float32Array([0, 0, 2, 0, 2, 1]);

export class InstancedArrows {
  count: number;
  private model: Model;
  private tri: Buffer;
  private source: Buffer;
  private target: Buffer;
  private size: Buffer;
  private radius: Buffer;
  private color: Buffer;
  private bend: Buffer;
  private uniforms: Record<string, unknown>;

  constructor(device: Device, data: InstancedArrowsData, width = 0, height = 0) {
    this.count = data.count;
    this.tri = device.createBuffer({ data: data.half ? HALF_ARROW_TEMPLATE : ARROW_TEMPLATE });
    this.source = device.createBuffer({ data: data.sources });
    this.target = device.createBuffer({ data: data.targets });
    this.size = device.createBuffer({ data: data.sizes });
    this.radius = device.createBuffer({ data: data.radii });
    this.color = device.createBuffer({ data: data.colors });
    // Per-instance bend (#104 N6c), optional: absent ⇒ zero ⇒ oriented along the chord, as before.
    this.bend = device.createBuffer({ data: data.bends ?? new Float32Array(data.count) });
    this.uniforms = {
      u_transform: clipFromView({ k: 1, x: 0, y: 0 }, width || 1, height || 1),
      u_screen: 0,
      u_viewport: [width || 1, height || 1],
    };
    this.model = new Model(device, {
      vs: INSTANCED_ARROW_VS,
      fs: FILL_FS,
      bufferLayout: [
        { name: "a_tri", format: "float32x2" },
        { name: "a_source", format: "float32x2", stepMode: "instance" },
        { name: "a_target", format: "float32x2", stepMode: "instance" },
        { name: "a_size", format: "float32", stepMode: "instance" },
        { name: "a_radius", format: "float32", stepMode: "instance" },
        { name: "a_bend", format: "float32", stepMode: "instance" },
        { name: "a_color", format: "unorm8x4", stepMode: "instance" },
      ],
      attributes: {
        a_tri: this.tri,
        a_source: this.source,
        a_target: this.target,
        a_size: this.size,
        a_radius: this.radius,
        a_bend: this.bend,
        a_color: this.color,
      },
      uniforms: this.uniforms,
      parameters: BLEND,
      topology: "triangle-list",
      vertexCount: 3,
      instanceCount: this.count,
    });
  }

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
    this.tri.destroy();
    this.source.destroy();
    this.target.destroy();
    this.size.destroy();
    this.radius.destroy();
    this.color.destroy();
    this.bend.destroy();
  }
}

/**
 * Triangle-list template for one half-arrow link (#104 N6): the source foot (2 triangles), a body
 * strip of `M` samples per bezier edge (`2·(M−1)` triangles between the inner and outer curves), and
 * the barbed head (2 triangles). Each vertex is `(code, t)`: `code` selects a named anchor or the
 * inner(8)/outer(9) edge bezier evaluated at `t` (see INSTANCED_HALF_ARROW_VS).
 */
function halfArrowTemplate(samples: number): Float32Array {
  const M = Math.max(2, samples | 0);
  const v: number[] = [];
  // Source foot: x02(1) x0(0) x04(3), then x02(1) x04(3) x03(2).
  v.push(1, 0, 0, 0, 3, 0, 1, 0, 3, 0, 2, 0);
  // Body strip between inner (code 8) and outer (code 9) edges.
  for (let i = 0; i < M - 1; i++) {
    const ti = i / (M - 1);
    const tj = (i + 1) / (M - 1);
    v.push(8, ti, 9, ti, 8, tj); // inner_i, outer_i, inner_{i+1}
    v.push(9, ti, 8, tj, 9, tj); // outer_i, inner_{i+1}, outer_{i+1}
  }
  // Head: x13(6) x14(7) x11(4), then x13(6) x11(4) x12(5).
  v.push(6, 0, 7, 0, 4, 0, 6, 0, 4, 0, 5, 0);
  return new Float32Array(v);
}

/** Path samples per bezier edge for the half-arrow strip. */
const HALF_ARROW_SAMPLES = 24;

export class InstancedHalfArrows {
  count: number;
  private vertexCount: number;
  private model: Model;
  private kind: Buffer;
  private source: Buffer;
  private target: Buffer;
  private radii: Buffer;
  private widths: Buffer;
  private bend: Buffer;
  private color: Buffer;
  private uniforms: Record<string, unknown>;

  constructor(device: Device, data: InstancedHalfArrowsData, width = 0, height = 0) {
    this.count = data.count;
    const samples = Math.max(2, (data.samples ?? HALF_ARROW_SAMPLES) | 0);
    const template = halfArrowTemplate(samples);
    this.vertexCount = template.length / 2;
    this.kind = device.createBuffer({ data: template });
    this.source = device.createBuffer({ data: data.sources });
    this.target = device.createBuffer({ data: data.targets });
    this.radii = device.createBuffer({ data: data.radii });
    this.widths = device.createBuffer({ data: data.widths });
    this.bend = device.createBuffer({ data: data.bends });
    this.color = device.createBuffer({ data: data.colors });
    this.uniforms = {
      u_transform: clipFromView({ k: 1, x: 0, y: 0 }, width || 1, height || 1),
      u_screen: 0,
      u_viewport: [width, height],
    };
    this.model = new Model(device, {
      vs: INSTANCED_HALF_ARROW_VS,
      fs: FILL_FS,
      bufferLayout: [
        { name: "a_kind", format: "float32x2" },
        { name: "a_p0", format: "float32x2", stepMode: "instance" },
        { name: "a_p1", format: "float32x2", stepMode: "instance" },
        { name: "a_radii", format: "float32x2", stepMode: "instance" },
        { name: "a_widths", format: "float32x2", stepMode: "instance" },
        { name: "a_bend", format: "float32", stepMode: "instance" },
        { name: "a_color", format: "unorm8x4", stepMode: "instance" },
      ],
      attributes: {
        a_kind: this.kind,
        a_p0: this.source,
        a_p1: this.target,
        a_radii: this.radii,
        a_widths: this.widths,
        a_bend: this.bend,
        a_color: this.color,
      },
      uniforms: this.uniforms,
      parameters: BLEND,
      topology: "triangle-list",
      vertexCount: this.vertexCount,
      instanceCount: this.count,
    });
  }

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
    this.kind.destroy();
    this.source.destroy();
    this.target.destroy();
    this.radii.destroy();
    this.widths.destroy();
    this.bend.destroy();
    this.color.destroy();
  }
}
