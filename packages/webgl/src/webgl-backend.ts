import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import type { Device, Framebuffer } from "@luma.gl/core";
import type { Backend, RenderLayer, ViewTransform } from "@d3gl/core";
import { GroupRenderer } from "./renderer.js";
import { clipFromView } from "./transform.js";
import { toPNG } from "./png.js";
import { svgFromLayers } from "@d3gl/svg";

export interface WebGLBackendOptions {
  width: number;
  height: number;
}

export class WebGLBackend implements Backend {
  private renderers = new Map<string, GroupRenderer>();
  private layers = new Map<string, RenderLayer>();
  private order: string[] = [];
  private clipMatrix: Float32Array;
  private viewTransform: ViewTransform = { k: 1, x: 0, y: 0 };

  private constructor(
    private readonly device: Device,
    private readonly offscreen: Framebuffer,
    private readonly width: number,
    private readonly height: number,
  ) {
    this.clipMatrix = clipFromView({ k: 1, x: 0, y: 0 }, width, height);
  }

  static async create(canvas: HTMLCanvasElement, opts: WebGLBackendOptions): Promise<WebGLBackend> {
    const device = await luma.createDevice({
      adapters: [webgl2Adapter],
      type: "webgl",
      createCanvasContext: { canvas, useDevicePixels: false },
      // Request a stencil buffer on the canvas drawing buffer so the ONSCREEN
      // render path can clip via the stencil test (WebGL defaults stencil:false).
      webgl: { stencil: true },
    });
    const offscreen = device.createFramebuffer({
      width: opts.width,
      height: opts.height,
      colorAttachments: ["rgba8unorm"],
      depthStencilAttachment: "depth24plus-stencil8",
    });
    return new WebGLBackend(device, offscreen, opts.width, opts.height);
  }

  setLayers(newLayers: RenderLayer[]): void {
    // Destroy old renderers
    for (const r of this.renderers.values()) r.destroy();
    this.renderers.clear();
    this.layers.clear();
    this.order = [];
    for (const layer of newLayers) {
      const renderer = new GroupRenderer(this.device, layer.buffers, this.width, this.height);
      renderer.setTransform(this.clipMatrix);
      this.renderers.set(layer.name, renderer);
      this.layers.set(layer.name, layer);
      this.order.push(layer.name);
    }
  }

  updateLayer(name: string, layer: RenderLayer): void {
    const existing = this.renderers.get(name);
    if (existing) {
      existing.updateColors(layer.buffers);
      this.layers.set(name, layer);
    } else {
      const renderer = new GroupRenderer(this.device, layer.buffers, this.width, this.height);
      renderer.setTransform(this.clipMatrix);
      this.renderers.set(name, renderer);
      this.layers.set(name, layer);
      this.order.push(name);
    }
  }

  setTransform(t: ViewTransform): void {
    this.viewTransform = t;
    this.clipMatrix = clipFromView(t, this.width, this.height);
    for (const r of this.renderers.values()) r.setTransform(this.clipMatrix);
  }

  render(): void {
    const cc = this.device.getDefaultCanvasContext();
    const fb = cc.getCurrentFramebuffer({ depthStencilFormat: "depth24plus-stencil8" });
    this.drawInto(fb);
  }

  private drawInto(framebuffer: Framebuffer): void {
    const clipSources = new Set<string>();
    for (const name of this.order) {
      const ct = this.layers.get(name)?.clipTo;
      if (ct) clipSources.add(ct);
    }
    const pass = this.device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0], clearStencil: 0 });
    for (const name of this.order) {
      const r = this.renderers.get(name)!;
      const layer = this.layers.get(name)!;
      r.setStencil(clipSources.has(name) ? "write" : layer.clipTo ? "test" : "off");
      r.setPointSizeMode(layer.pointSizeMode ?? "world");
      r.render(pass);
    }
    pass.end();
    this.device.submit();
  }

  toPNG(): string {
    this.drawInto(this.offscreen);
    return toPNG(this.device, this.offscreen, this.width, this.height);
  }

  toSVG(): string {
    return svgFromLayers(this.width, this.height, this.order.map((n) => this.layers.get(n)!), this.viewTransform);
  }

  /** Read a pixel from the ONSCREEN canvas default framebuffer after render(). Test aid. */
  readScreenPixel(x: number, y: number): number[] {
    this.render();
    const gl = (this.device as unknown as { gl: WebGL2RenderingContext }).gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    const p = new Uint8Array(4);
    gl.readPixels(Math.floor(x), Math.floor(this.height - 1 - y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
    return [p[0]!, p[1]!, p[2]!, p[3]!];
  }

  /** Read a pixel from the offscreen framebuffer (renders first). Flips y for WebGL origin. */
  readPixel(x: number, y: number): number[] {
    this.drawInto(this.offscreen);
    const p = this.device.readPixelsToArrayWebGL(this.offscreen, {
      sourceX: Math.floor(x),
      sourceY: Math.floor(this.height - 1 - y),
      sourceWidth: 1,
      sourceHeight: 1,
    });
    return [p[0]!, p[1]!, p[2]!, p[3]!];
  }

  destroy(): void {
    for (const r of this.renderers.values()) r.destroy();
    this.renderers.clear();
    this.layers.clear();
    this.order = [];
    this.offscreen.destroy();
    this.device.destroy();
  }
}
