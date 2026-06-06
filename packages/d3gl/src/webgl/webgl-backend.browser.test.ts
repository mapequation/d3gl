import { describe, it, expect } from "vitest";
import { Scene } from "../core/index.js";
import { WebGLBackend } from "./webgl-backend.js";

function rectLayer(name: string, x: number, y: number, w: number, h: number, color: string, clipTo?: string) {
  const scene = new Scene();
  scene.group(name, (b) => b.drawable("d", (c) => c.rect(x, y, w, h)));
  scene.setFill(name, "d", color);
  return { name, buffers: scene.buffers(name), drawables: scene.drawables(name), clipTo };
}

describe("WebGLBackend", () => {
  it("clips a layer to a mask layer via the stencil buffer", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: 64, height: 64 });
    const mask = rectLayer("mask", 0, 0, 32, 64, "rgb(0,0,0)");
    const red = rectLayer("red", 0, 0, 64, 64, "rgb(255,0,0)", "mask");
    backend.setLayers([mask, red]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    const png = backend.toPNG(); // renders into the offscreen stencil framebuffer
    expect(png.startsWith("data:image/png")).toBe(true);
    // Pixel check via the offscreen readback helper exposed for tests:
    const left = backend.readPixel(16, 32);
    const right = backend.readPixel(48, 32);
    expect(left[0]).toBeGreaterThan(200);
    expect(right[3]).toBeLessThan(40); // clipped out -> transparent
    backend.destroy();
  });

  it("alpha-blends a semi-transparent layer over an opaque one", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: 64, height: 64 });
    const bg = rectLayer("bg", 0, 0, 64, 64, "rgb(255,0,0)");   // opaque red
    const top = rectLayer("top", 0, 0, 64, 64, "#0000ff80");    // ~50% blue (8-digit hex alpha)
    backend.setLayers([bg, top]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    const px = backend.readPixel(32, 32);
    // Blended ≈ 50% blue over red → both channels present. Without blending it would
    // be pure opaque blue (R≈0, B≈255).
    expect(px[0]).toBeGreaterThan(90);  // red shows through (~127)
    expect(px[2]).toBeGreaterThan(90);  // blue on top (~128)
    backend.destroy();
  });

  it("also clips on the ONSCREEN render() path (needs a stencil on the canvas buffer)", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: 64, height: 64 });
    const mask = rectLayer("mask", 0, 0, 32, 64, "rgb(0,0,0)");
    const red = rectLayer("red", 0, 0, 64, 64, "rgb(255,0,0)", "mask");
    backend.setLayers([mask, red]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    // Reads the canvas default framebuffer after the onscreen render() — the path
    // the live view uses. Regression guard: without webgl:{stencil:true} this fails.
    const left = backend.readScreenPixel(16, 32);
    const right = backend.readScreenPixel(48, 32);
    expect(left[0]).toBeGreaterThan(200);   // inside mask -> red
    expect(right[0]).toBeLessThan(40);      // clipped out
    backend.destroy();
  });

  it("globe mode bakes layers and draws a textured sphere; rotation repaints without throwing", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 128;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: 128, height: 128 });
    // A full-texture green rect = the baked equirect "map" (texture is 256x128 below).
    const ocean = rectLayer("ocean", 0, 0, 256, 128, "rgb(0,128,0)");
    backend.setLayers([ocean]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    backend.setGlobeMode(true, 256, 128);
    const center = backend.readScreenPixel(64, 64);
    expect(center[1]).toBeGreaterThan(80);      // green sphere at centre
    const corner = backend.readScreenPixel(4, 4);
    expect(corner[3]).toBeLessThan(40);         // outside the disc → clear
    // Rotation must not throw and keeps the sphere painted (uniform map).
    const rotY = new Float32Array([0,0,-1, 0,1,0, 1,0,0]);
    expect(() => backend.setGlobeRotation(rotY)).not.toThrow();
    expect(backend.readScreenPixel(64, 64)[1]).toBeGreaterThan(80);
    backend.setGlobeMode(false);                // back to flat path, no throw
    backend.destroy();
  });
});
