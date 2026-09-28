import { describe, it, expect } from "vitest";
import { Scene } from "../core/index.js";
import { WebGLBackend } from "./webgl-backend.js";
import { groupRendererConstructions } from "./renderer.js";
import type { DrawableVector } from "../core/index.js";
import { GlSurfaceSpy } from "../__tests__/engine-sweep.js";
import type { GlTexStorage } from "../__tests__/engine-sweep.js";

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

  it("exports PNG of the globe and SVG without throwing in globe mode", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 128;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: 128, height: 128 });
    const ocean = rectLayer("ocean", 0, 0, 256, 128, "rgb(0,128,0)");
    backend.setLayers([ocean]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    backend.setGlobeMode(true, 256, 128);
    const png = backend.toPNG();
    expect(png.startsWith("data:image/png")).toBe(true);
    let svg = "";
    expect(() => { svg = backend.toSVG(); }).not.toThrow();
    expect(typeof svg).toBe("string");
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

  it("composites a pass-through point on top of the retained base (preserve-composite)", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: 64, height: 64 });
    // Retained full-canvas green base.
    const base = rectLayer("base", 0, 0, 64, 64, "rgb(0,128,0)");
    backend.setLayers([base]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    // Register a pass-through layer and draw one red point at the centre.
    backend.setPassThroughLayer!({ name: "pts" });
    backend.drawPassThrough!("pts", {
      points: {
        positions: new Float32Array([32, 32]),
        radii: new Float32Array([8]),
        colors: new Uint8Array([255, 0, 0, 255]),
        count: 1,
      },
      paths: null,
    }, "replace-first");
    // Centre: red point composited over the base.
    const center = backend.readPixel(32, 32);
    expect(center[0]).toBeGreaterThan(200); // red point present
    // Away from the point: the retained green base survived the preserve-composite.
    const away = backend.readPixel(4, 4);
    expect(away[1]).toBeGreaterThan(80);    // green base still there
    expect(away[0]).toBeLessThan(60);       // not red (no point here)
    backend.destroy();
  });

  it("globe is not vertically flipped: north content renders at the top of the disc", async () => {
    const canvas = document.createElement("canvas"); canvas.width = 128; canvas.height = 128;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: 128, height: 128 });
    // Texture 256x128: top half (north) red, bottom half (south) blue.
    const north = rectLayer("north", 0, 0, 256, 64, "rgb(255,0,0)");
    const south = rectLayer("south", 0, 64, 256, 64, "rgb(0,0,255)");
    backend.setLayers([north, south]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    backend.setGlobeMode(true, 256, 128);
    // At identity rotation the north pole projects to the top of the disc.
    const top = backend.readScreenPixel(64, 24);     // upper part of the disc
    const bottom = backend.readScreenPixel(64, 104);  // lower part of the disc
    expect(top[0]).toBeGreaterThan(top[2]);     // top is red-dominant (north)
    expect(bottom[2]).toBeGreaterThan(bottom[0]); // bottom is blue-dominant (south)
    backend.destroy();
  });

  it("updateLayer re-uploads geometry even when the drawable count is unchanged", async () => {
    // Regression: the hover overlay always calls updateLayer with count=1 but different
    // geometry per hovered cell. The old same-count fast path only recolored, leaving the
    // first cell's geometry on screen while only the color updated.
    const canvas = document.createElement("canvas");
    canvas.width = 100; canvas.height = 100;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: 100, height: 100 });
    const scene = new Scene();
    scene.group("g", (g) => g.drawable("a", (ctx) => ctx.rect(10, 10, 20, 20)));
    scene.setFill("g", "a", "rgb(255,0,0)");
    backend.setLayers([{ name: "g", buffers: scene.buffers("g"), drawables: scene.drawables("g") }]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    expect([...backend.readPixel(20, 20).slice(0, 3)]).toEqual([255, 0, 0]);

    // Same drawable count (1), DIFFERENT geometry — the hover-overlay pattern.
    scene.group("g", (g) => g.drawable("a", (ctx) => ctx.rect(60, 60, 20, 20)));
    scene.setFill("g", "a", "rgb(255,0,0)");
    backend.updateLayer("g", { name: "g", buffers: scene.buffers("g"), drawables: scene.drawables("g") });
    expect([...backend.readPixel(70, 70).slice(0, 3)]).toEqual([255, 0, 0]); // new position painted
    expect(backend.readPixel(20, 20)[3]).toBe(0);                             // old position cleared
    backend.destroy();
  });

  it("updateLayerStyles recolors without geometry re-upload", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 100; canvas.height = 100;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: 100, height: 100 });
    const scene = new Scene();
    scene.group("g", (g) => g.drawable("a", (ctx) => ctx.rect(10, 10, 40, 40)));
    scene.setFill("g", "a", "rgb(255,0,0)");
    backend.setLayers([{ name: "g", buffers: scene.buffers("g"), drawables: scene.drawables("g") }]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    // Initial state: the rect is red at (30, 30).
    expect(backend.readPixel(30, 30).slice(0, 3)).toEqual([255, 0, 0]);

    // Restyle to 50% blue — only the palette/flags textures change; geometry stays uploaded.
    scene.setFill("g", "a", "rgba(0, 0, 255, 0.5)");
    // updateLayerStyles is optional on the interface; cast to access it.
    (backend as unknown as { updateLayerStyles: (n: string, t: ReturnType<typeof scene.styleTables>, d: DrawableVector[]) => void })
      .updateLayerStyles("g", scene.styleTables("g"), scene.drawables("g"));
    const px = backend.readPixel(30, 30);
    // Blue channel dominant after recolor (alpha-blended over clear, pre-mult ~128 → >100).
    expect(px[2]).toBeGreaterThan(100); // blue present
    expect(px[0]).toBe(0);              // red gone
    // toSVG reads the stored drawables — they must be refreshed so the export reflects
    // the new color (rgba(0, 0, 255, ...) contains the substring "0, 0, 255").
    expect(backend.toSVG()).toContain("0, 0, 255");
    backend.destroy();
  });
});

/** In-place updateLayer (#218): the renderer (Models/pipelines) is REUSED across geometry
 *  replaces; Grow* objects rewrite within capacity and grow+rebind past it. A construction
 *  is asserted only for structural changes (a pass type the renderer was built without). */
describe("WebGLBackend updateLayer in-place replace (#218)", () => {
  async function makeBackend(size = 100) {
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width: size, height: size });
    backend.setTransform({ k: 1, x: 0, y: 0 });
    return backend;
  }
  const layerOf = (scene: Scene, name: string) =>
    ({ name, buffers: scene.buffers(name), drawables: scene.drawables(name) });

  it("reuses one renderer across geometry change, grow past capacity, shrink, empty, and regrow", async () => {
    const backend = await makeBackend();
    const scene = new Scene();
    scene.group("g", (g) => g.drawable("a", (ctx) => ctx.rect(10, 10, 20, 20)));
    scene.setFill("g", "a", "rgb(255,0,0)");
    backend.setLayers([layerOf(scene, "g")]);
    const base = groupRendererConstructions;

    // Same count, different geometry (the hover-overlay pattern) — rewritten in place.
    scene.group("g", (g) => g.drawable("a", (ctx) => ctx.rect(60, 60, 20, 20)));
    scene.setFill("g", "a", "rgb(255,0,0)");
    backend.updateLayer("g", layerOf(scene, "g"));
    expect([...backend.readPixel(70, 70).slice(0, 3)]).toEqual([255, 0, 0]);
    expect(backend.readPixel(20, 20)[3]).toBe(0);

    // GROW to 300 drawables: vertex/index buffers outgrow their initial capacity and the
    // 256-wide colour/flags tables need a second row — reallocate + REBIND, still no new
    // renderer. Drawable 299 (row 2 of the tables) must resolve its own colour.
    scene.group("g", (g) => {
      for (let i = 0; i < 300; i++) g.drawable(`r${i}`, (ctx) => ctx.rect((i % 20) * 5, Math.floor(i / 20) * 5, 4, 4));
    });
    for (let i = 0; i < 300; i++) scene.setFill("g", `r${i}`, i === 299 ? "rgb(255,0,0)" : "rgb(0,0,255)");
    backend.updateLayer("g", layerOf(scene, "g"));
    expect([...backend.readPixel(2, 2).slice(0, 3)]).toEqual([0, 0, 255]);   // r0
    expect([...backend.readPixel(97, 72).slice(0, 3)]).toEqual([255, 0, 0]); // r299, table row 2

    // SHRINK back to one drawable: high-water capacity is kept, stale tail never indexed.
    scene.group("g", (g) => g.drawable("a", (ctx) => ctx.rect(40, 40, 10, 10)));
    scene.setFill("g", "a", "rgb(0,255,0)");
    backend.updateLayer("g", layerOf(scene, "g"));
    expect([...backend.readPixel(45, 45).slice(0, 3)]).toEqual([0, 255, 0]);
    expect(backend.readPixel(2, 2)[3]).toBe(0); // the 300-rect frame is gone

    // EMPTY (a cleared hover overlay): passes stay alive at zero counts, nothing drawn.
    scene.group("g", () => {});
    backend.updateLayer("g", layerOf(scene, "g"));
    expect(backend.readPixel(45, 45)[3]).toBe(0);

    // REGROW after empty: still the same renderer.
    scene.group("g", (g) => g.drawable("a", (ctx) => ctx.rect(20, 70, 10, 10)));
    scene.setFill("g", "a", "rgb(255,0,255)");
    backend.updateLayer("g", layerOf(scene, "g"));
    expect([...backend.readPixel(25, 75).slice(0, 3)]).toEqual([255, 0, 255]);

    expect(groupRendererConstructions - base).toBe(0);
    backend.destroy();
  });

  it("replaces a points-only layer in place, and mixed shape+point groups rebind borrowed tables on growth", async () => {
    const backend = await makeBackend();
    const scene = new Scene();
    scene.group("pts", (g) => g.point("p", 25, 25, 5));
    scene.setFill("pts", "p", "rgb(255,0,0)");
    backend.setLayers([layerOf(scene, "pts")]);
    expect(backend.readPixel(25, 25)[0]).toBeGreaterThan(200);
    const base = groupRendererConstructions;

    // Move the point — point-pass buffers rewritten in place (owned tables).
    scene.group("pts", (g) => g.point("p", 75, 75, 5));
    scene.setFill("pts", "p", "rgb(255,0,0)");
    backend.updateLayer("pts", layerOf(scene, "pts"));
    expect(backend.readPixel(75, 75)[0]).toBeGreaterThan(200);
    expect(backend.readPixel(25, 25)[3]).toBe(0);
    expect(groupRendererConstructions - base).toBe(0);

    // Mixed group: 299 rects + 1 point → the point pass BORROWS the shape pass's tables.
    // Replacing at 300 drawables recreates the tables (row overflow) and must rebind the
    // borrowing point model, or the point would sample a destroyed texture.
    const scene2 = new Scene();
    scene2.group("mix", (g) => {
      g.drawable("seed", (ctx) => ctx.rect(0, 0, 2, 2)); // shape pass
      g.point("pseed", 50, 50, 3); // point pass (borrows the shape pass's tables)
    });
    scene2.setFill("mix", "seed", "rgb(0,0,255)");
    scene2.setFill("mix", "pseed", "rgb(0,0,255)");
    backend.setLayers([layerOf(scene2, "mix")]);
    const base2 = groupRendererConstructions;
    scene2.group("mix", (g) => {
      for (let i = 0; i < 299; i++) g.drawable(`r${i}`, (ctx) => ctx.rect((i % 20) * 5, Math.floor(i / 20) * 5, 3, 3));
      g.point("p", 90, 90, 5); // drawableId 299 → colour table row 2
    });
    for (let i = 0; i < 299; i++) scene2.setFill("mix", `r${i}`, "rgb(0,0,255)");
    scene2.setFill("mix", "p", "rgb(255,0,0)");
    backend.updateLayer("mix", layerOf(scene2, "mix"));
    expect(backend.readPixel(90, 90)[0]).toBeGreaterThan(200); // point drawn from the recreated table
    expect(groupRendererConstructions - base2).toBe(0);
    backend.destroy();
  });

  it("falls back to a full rebuild only when a structurally new pass appears", async () => {
    const backend = await makeBackend();
    const scene = new Scene();
    scene.group("g", (g) => g.point("p", 25, 25, 5)); // points-only: no shape pass
    scene.setFill("g", "p", "rgb(255,0,0)");
    backend.setLayers([layerOf(scene, "g")]);
    const base = groupRendererConstructions;

    // Fill/stroke geometry appears — the shape pass can't be created in place.
    scene.group("g", (g) => g.drawable("a", (ctx) => ctx.rect(60, 60, 20, 20)));
    scene.setFill("g", "a", "rgb(0,255,0)");
    backend.updateLayer("g", layerOf(scene, "g"));
    expect([...backend.readPixel(70, 70).slice(0, 3)]).toEqual([0, 255, 0]);
    expect(backend.readPixel(25, 25)[3]).toBe(0);
    expect(groupRendererConstructions - base).toBe(1); // exactly one rebuild
    backend.destroy();
  });
});

/**
 * The export framebuffer is LAZY (#88). `toPNG()` and `readPixel()` are its only readers: the live
 * view renders into the canvas's own stencil-backed drawing buffer (that is where `clipTo` clips),
 * pass-through accumulates in its own `PassThroughGL` surface and pick in its own device-px FBO. So a
 * chart that never exports must never pay for it — it is W×H×8 bytes (RGBA8 colour +
 * depth24-stencil8), ≈16.6 MB at 1920×1080 — and it is no longer reallocated on every resize.
 *
 * Measured on the GL calls themselves (`GlSurfaceSpy`), never on luma's stats: those are one global
 * singleton shared by every device on the page, so an absolute number there says nothing about
 * this backend.
 */
describe("WebGLBackend export framebuffer is lazy (#88)", () => {
  const W = 120;
  const H = 80;
  const W2 = 160;
  const H2 = 100;

  /** What one export target reserves at a CSS size: an RGBA8 colour attachment plus the
   *  depth24-stencil8 one `clipTo` needs. Both formats are 4 B/texel ⇒ width × height × 8 bytes. */
  const exportTarget = (width: number, height: number): GlTexStorage[] => [
    { internalformat: WebGL2RenderingContext.RGBA8, width, height },
    { internalformat: WebGL2RenderingContext.DEPTH24_STENCIL8, width, height },
  ];
  const atSize = (width: number, height: number) => (t: GlTexStorage) => t.width === width && t.height === height;

  async function clippedBackend(width = W, height = H): Promise<WebGLBackend> {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    document.body.appendChild(canvas);
    const backend = await WebGLBackend.create(canvas, { width, height });
    // A clipTo pair, so the stencil attachment the export keeps is exercised, not just allocated.
    backend.setLayers([
      rectLayer("mask", 0, 0, width / 2, height, "rgb(0,0,0)"),
      rectLayer("red", 0, 0, width, height, "rgb(255,0,0)", "mask"),
    ]);
    backend.setTransform({ k: 1, x: 0, y: 0 });
    return backend;
  }

  async function pngSize(dataUrl: string): Promise<{ width: number; height: number }> {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  }

  it("create → clipped layers → transform → render → resize allocate NO export framebuffer", async () => {
    const spy = new GlSurfaceSpy();
    let backend: WebGLBackend | undefined;
    try {
      const at = spy.mark();
      backend = await clippedBackend();
      backend.render();
      backend.setTransform({ k: 2, x: -W / 2, y: -H / 2 });
      backend.render();
      backend.resize(W2, H2);
      backend.render();
      const live = spy.since(at);
      // The whole #88 claim: the live path never creates a framebuffer object, and nothing
      // export-sized is reserved at either size the chart has had.
      expect(live.framebuffers).toBe(0);
      expect(live.storage.filter(atSize(W, H))).toEqual([]);
      expect(live.storage.filter(atSize(W2, H2))).toEqual([]);

      // Non-vacuity: the spy does see the target the moment a reader needs it — at the CURRENT size.
      const read = spy.mark();
      backend.readPixel(10, 10);
      const onRead = spy.since(read);
      expect(onRead.framebuffers).toBe(1);
      expect(onRead.storage).toEqual(exportTarget(W2, H2));
    } finally {
      spy.restore();
      backend?.destroy();
    }
  });

  it("the first toPNG() allocates it once at CSS size; later exports and readPixel reuse it", async () => {
    const backend = await clippedBackend();
    const spy = new GlSurfaceSpy();
    try {
      const first = spy.mark();
      const png = backend.toPNG();
      const onFirst = spy.since(first);
      expect(onFirst.framebuffers).toBe(1);
      // Exactly the two attachments and nothing else: W×H×8 bytes, measured.
      expect(onFirst.storage).toEqual(exportTarget(W, H));
      expect(await pngSize(png)).toEqual({ width: W, height: H });

      const again = spy.mark();
      backend.toPNG();
      const left = backend.readPixel(W / 4, H / 2);
      const right = backend.readPixel((3 * W) / 4, H / 2);
      const reused = spy.since(again);
      expect(reused.framebuffers).toBe(0);
      expect(reused.textures).toBe(0);
      expect(reused.storage).toEqual([]);
      // Behaviour unchanged: the lazily created target still carries the stencil clip.
      expect(left[0]).toBeGreaterThan(200);
      expect(right[3]).toBeLessThan(40);
    } finally {
      spy.restore();
      backend.destroy();
    }
  });

  it("resize() frees it without reallocating; the next export recreates it at the new size", async () => {
    const backend = await clippedBackend();
    const spy = new GlSurfaceSpy();
    try {
      backend.toPNG(); // allocate at W×H
      const resize = spy.mark();
      backend.resize(W2, H2);
      const onResize = spy.since(resize);
      expect(onResize.framebuffers).toBe(0); // no eager reallocation on a resize…
      expect(onResize.storage).toEqual([]);
      // …and the stale W×H target's two attachments (its colour + depth-stencil storage) are freed at once.
      expect(onResize.texturesDeleted).toBe(2);

      const next = spy.mark();
      const png = backend.toPNG();
      expect(spy.since(next).storage).toEqual(exportTarget(W2, H2));
      expect(await pngSize(png)).toEqual({ width: W2, height: H2 });
    } finally {
      spy.restore();
      backend.destroy();
    }
  });

  it("stays CSS width×height at devicePixelRatio 2 (toPNG/readPixel read exactly that; pick is device px)", async () => {
    const own = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 2 });
    const spy = new GlSurfaceSpy();
    let backend: WebGLBackend | undefined;
    try {
      backend = await clippedBackend();
      // Non-vacuity: luma really is rendering at 2×, so a device-px target would show as 2W×2H.
      expect(backend.gpuDevice.getDefaultCanvasContext().devicePixelRatio).toBe(2);
      const at = spy.mark();
      const png = backend.toPNG();
      expect(spy.since(at).storage).toEqual(exportTarget(W, H));
      expect(await pngSize(png)).toEqual({ width: W, height: H });
    } finally {
      spy.restore();
      backend?.destroy();
      if (own) Object.defineProperty(window, "devicePixelRatio", own);
      else Reflect.deleteProperty(window, "devicePixelRatio");
    }
  });

  it("globe-mode toPNG() allocates it lazily too, at CSS size", async () => {
    const backend = await clippedBackend(128, 128);
    const spy = new GlSurfaceSpy();
    try {
      backend.setGlobeMode(true, 256, 128);
      backend.render(); // bake now, so the export window holds only the export target
      const at = spy.mark();
      const png = backend.toPNG();
      const onExport = spy.since(at);
      expect(onExport.framebuffers).toBe(1);
      expect(onExport.storage).toEqual(exportTarget(128, 128));
      expect(await pngSize(png)).toEqual({ width: 128, height: 128 });
    } finally {
      spy.restore();
      backend.destroy();
    }
  });

  it("destroy() releases it: an exported chart frees exactly its two attachments more than a twin that never did", async () => {
    // luma's device.destroy() frees no resources, so destroy() is the ONLY teardown of the target.
    // Twins with identical layers free identical renderer textures (style tables), so the delta
    // isolates the export target's colour + depth-stencil attachments.
    const exported = await clippedBackend();
    const idle = await clippedBackend();
    const spy = new GlSurfaceSpy();
    try {
      exported.toPNG();
      exported.render();
      idle.render();
      const a = spy.mark();
      exported.destroy();
      const freedExported = spy.since(a).texturesDeleted;
      const b = spy.mark();
      idle.destroy();
      const freedIdle = spy.since(b).texturesDeleted;
      expect(freedExported - freedIdle).toBe(2);
    } finally {
      spy.restore();
    }
  });
});
