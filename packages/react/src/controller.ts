import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import type { Device, Framebuffer } from "@luma.gl/core";
import type { GroupBuffers } from "@d3gl/core";
import { GroupRenderer, clipFromView, pickAt, toPNG } from "@d3gl/webgl";
import type { ViewTransform } from "@d3gl/webgl";

export interface MapControllerOptions {
  width: number;
  height: number;
}

/**
 * Headless owner of the GPU map: a luma device, one GroupRenderer per named
 * group, and an offscreen framebuffer used for pick / PNG / pixel readback.
 *
 * render() targets the visible canvas (display). renderToFramebuffer() / readPixel
 * / pick / toPNG go through the offscreen framebuffer (the verified, testable
 * path). Pan/zoom is setTransform (uniform); recolor is updateColors (texture
 * write) — neither rebuilds geometry.
 */
export class MapController {
  private renderers = new Map<string, GroupRenderer>();
  private transform: Float32Array;

  private constructor(
    private readonly device: Device,
    private readonly offscreen: Framebuffer,
    private readonly width: number,
    private readonly height: number,
  ) {
    this.transform = clipFromView({ k: 1, x: 0, y: 0 }, width, height);
  }

  static async create(canvas: HTMLCanvasElement, opts: MapControllerOptions): Promise<MapController> {
    const device = await luma.createDevice({
      adapters: [webgl2Adapter],
      type: "webgl",
      createCanvasContext: { canvas, useDevicePixels: false },
    });
    const offscreen = device.createFramebuffer({
      width: opts.width,
      height: opts.height,
      colorAttachments: ["rgba8unorm"],
    });
    return new MapController(device, offscreen, opts.width, opts.height);
  }

  setGroup(name: string, buffers: GroupBuffers): void {
    this.renderers.get(name)?.destroy();
    const renderer = new GroupRenderer(this.device, buffers);
    renderer.setTransform(this.transform);
    this.renderers.set(name, renderer);
  }

  updateColors(name: string, buffers: GroupBuffers): void {
    this.renderers.get(name)?.updateColors(buffers);
  }

  setTransform(t: ViewTransform): void {
    this.transform = clipFromView(t, this.width, this.height);
    for (const r of this.renderers.values()) r.setTransform(this.transform);
  }

  render(): void {
    const pass = this.device.beginRenderPass({ clearColor: [0, 0, 0, 0] });
    for (const r of this.renderers.values()) r.render(pass);
    pass.end();
    this.device.submit();
  }

  renderToFramebuffer(): void {
    const pass = this.device.beginRenderPass({ framebuffer: this.offscreen, clearColor: [0, 0, 0, 1] });
    for (const r of this.renderers.values()) r.render(pass);
    pass.end();
    this.device.submit();
  }

  readPixel(x: number, y: number): number[] {
    this.renderToFramebuffer();
    const p = this.device.readPixelsToArrayWebGL(this.offscreen, {
      sourceX: Math.floor(x),
      sourceY: Math.floor(this.height - 1 - y),
      sourceWidth: 1,
      sourceHeight: 1,
    });
    return [p[0]!, p[1]!, p[2]!, p[3]!];
  }

  pick(name: string, x: number, y: number): number {
    const renderer = this.renderers.get(name);
    if (!renderer) return -1;
    return pickAt(this.device, renderer, this.offscreen, x, y, this.height);
  }

  toPNG(): string {
    this.renderToFramebuffer();
    return toPNG(this.device, this.offscreen, this.width, this.height);
  }

  destroy(): void {
    for (const r of this.renderers.values()) r.destroy();
    this.renderers.clear();
    this.offscreen.destroy();
    this.device.destroy();
  }
}
