/**
 * Backend-equivalence test harness (issue #41).
 *
 * Renders the SAME Scene group through the WebGL compositor ({@link GroupRenderer})
 * and the Canvas compositor ({@link CanvasBackend}) into RGBA pixel buffers with a
 * common top-left origin, and diffs them. The goal is a reusable regression net
 * proving the backends composite identically (overlapping fills/strokes, draw
 * order, …) — not just that each renders *something*.
 *
 * Not shipped: this lives under `__tests__` and is imported only by browser tests.
 */
import type { Device } from "@luma.gl/core";
import { Scene, type RenderLayer } from "../../core/index.js";
import { GroupRenderer } from "../../webgl/renderer.js";
import { clipFromView } from "../../webgl/transform.js";
import { CanvasBackend } from "../../canvas/canvas-backend.js";

export interface PixelBuffer {
  width: number;
  height: number;
  /** RGBA bytes, row-major from the TOP-left (matches Canvas getImageData). */
  data: Uint8Array;
}

/** Build a {@link RenderLayer} from a Scene group (mirrors BaseEngine.renderLayer). */
export function layerOf(scene: Scene, name: string): RenderLayer {
  return { name, buffers: scene.buffers(name), drawables: scene.drawables(name) };
}

/**
 * Render a Scene group with the WebGL {@link GroupRenderer} into an offscreen
 * framebuffer and read it back as a top-left-origin RGBA buffer. (readPixels has a
 * bottom-left origin, so rows are flipped to match Canvas.)
 */
export function renderWebGL(device: Device, scene: Scene, name: string, width: number, height: number): PixelBuffer {
  const framebuffer = device.createFramebuffer({ width, height, colorAttachments: ["rgba8unorm"] });
  const renderer = new GroupRenderer(device, scene.buffers(name), width, height);
  renderer.setTransform(clipFromView({ k: 1, x: 0, y: 0 }, width, height));
  const pass = device.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 0] });
  renderer.render(pass);
  pass.end();
  device.submit();

  const raw = device.readPixelsToArrayWebGL(framebuffer, {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: width,
    sourceHeight: height,
  }) as Uint8Array;
  // Flip vertically: framebuffer origin is bottom-left, Canvas is top-left.
  const data = new Uint8Array(width * height * 4);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * rowBytes;
    data.set(raw.subarray(src, src + rowBytes), y * rowBytes);
  }
  renderer.destroy();
  framebuffer.destroy();
  return { width, height, data };
}

/** Render a Scene group with the {@link CanvasBackend} and read it back (top-left origin). */
export function renderCanvas(scene: Scene, name: string, width: number, height: number): PixelBuffer {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const backend = new CanvasBackend(canvas, width, height);
  backend.setLayers([layerOf(scene, name)]);
  backend.setTransform({ k: 1, x: 0, y: 0 });
  backend.render();
  const img = canvas.getContext("2d")!.getImageData(0, 0, width, height);
  backend.destroy();
  return { width, height, data: new Uint8Array(img.data.buffer.slice(0)) };
}

export interface DiffOptions {
  /** Max per-channel |Δ| for two pixels to count as equal (default 40). */
  colorTolerance?: number;
  /**
   * Neighborhood radius (px) for the position-tolerant match (default 1). A pixel in
   * `a` is a mismatch only if NO pixel within this radius in `b` matches it. This
   * absorbs sub-pixel edge/border shifts (e.g. WebGL's tessellated stroke vs Canvas's
   * native stroker land ~1px apart) while still flagging genuinely divergent regions —
   * a several-px-wide band of the wrong color (a draw-order bug) has no nearby match.
   * Set 0 for an exact-position diff.
   */
  radius?: number;
}

export interface DiffResult {
  /** Pixels considered (non-transparent in at least one buffer). */
  considered: number;
  /** Considered pixels with no color-tolerant match within `radius` in `b`. */
  mismatches: number;
  /** mismatches / considered (0 when nothing considered). */
  fraction: number;
  /** First few mismatching pixels, for debugging. */
  samples: { x: number; y: number; a: number[]; b: number[] }[];
}

/**
 * Position-tolerant per-pixel diff of two equally-sized buffers. A pixel is
 * "considered" if either buffer is non-transparent there; it's a mismatch if no pixel
 * within `radius` of it in `b` matches its color within `colorTolerance`. See
 * {@link DiffOptions.radius} for why the neighborhood search is the right metric for
 * comparing two different rasterizers.
 */
export function diffPixels(a: PixelBuffer, b: PixelBuffer, opts: DiffOptions = {}): DiffResult {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const colorTolerance = opts.colorTolerance ?? 40;
  const radius = opts.radius ?? 1;
  const { width: W, height: H } = a;
  const at = (data: Uint8Array, x: number, y: number): number => (y * W + x) * 4;
  let considered = 0;
  let mismatches = 0;
  const samples: DiffResult["samples"] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = at(a.data, x, y);
      const aa = a.data[o + 3]!;
      if (aa === 0 && b.data[o + 3]! === 0) continue;
      considered++;
      let matched = false;
      for (let dy = -radius; dy <= radius && !matched; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const p = at(b.data, nx, ny);
          const d = Math.max(
            Math.abs(a.data[o]! - b.data[p]!),
            Math.abs(a.data[o + 1]! - b.data[p + 1]!),
            Math.abs(a.data[o + 2]! - b.data[p + 2]!),
            Math.abs(aa - b.data[p + 3]!),
          );
          if (d <= colorTolerance) { matched = true; break; }
        }
      }
      if (!matched) {
        mismatches++;
        if (samples.length < 8) {
          const bo = at(b.data, x, y);
          samples.push({
            x, y,
            a: [a.data[o]!, a.data[o + 1]!, a.data[o + 2]!, aa],
            b: [b.data[bo]!, b.data[bo + 1]!, b.data[bo + 2]!, b.data[bo + 3]!],
          });
        }
      }
    }
  }
  return { considered, mismatches, fraction: considered ? mismatches / considered : 0, samples };
}

/**
 * The issue #41 repro scene: a "flower" of N opaque, heavily-overlapping discs
 * (centre + ring), each with a thick white border, added in order. Because the
 * discs overlap, every disc's white border is partly covered by later discs'
 * fills — a sensitive probe of overlapping fill/stroke compositing.
 */
export function overlappingBorderedShapes(width: number, height: number, petals = 6): Scene {
  const palette = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2"];
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.165;
  const ringR = r * 1.05;
  const discs: { cx: number; cy: number }[] = [{ cx, cy }];
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * 2 * Math.PI - Math.PI / 2;
    discs.push({ cx: cx + Math.cos(a) * ringR, cy: cy + Math.sin(a) * ringR });
  }
  const scene = new Scene();
  scene.group("shapes", (g) => {
    discs.forEach((d, i) => {
      g.drawable(
        i,
        (ctx) => {
          ctx.moveTo(d.cx + r, d.cy);
          ctx.arc(d.cx, d.cy, r, 0, 2 * Math.PI);
          ctx.closePath();
        },
        { lineWidth: Math.max(4, Math.round(Math.min(width, height) * 0.03)) },
      );
    });
  });
  discs.forEach((_d, i) => {
    scene.setFill("shapes", i, palette[i % palette.length]!);
    scene.setStroke("shapes", i, "#ffffff");
  });
  return scene;
}

/**
 * Thick open/closed polylines exercising stroke JOINS (sharp/acute/closed) and end
 * caps. Backends historically diverged here: WebGL beveled every corner while Canvas
 * and SVG mitered them (and at different default miter limits — 10 vs 4). The acute
 * spike is sharp enough to exceed a small miter limit, so it probes the bevel fallback.
 */
export interface JoinSceneOptions {
  lineWidth?: number;
  join?: "miter" | "bevel";
  miterLimit?: number;
  cap?: "butt" | "square" | "round";
}

export function strokeJoinShapes(width: number, height: number, opts: JoinSceneOptions = {}): Scene {
  const lineWidth = opts.lineWidth ?? Math.round(Math.min(width, height) * 0.07);
  const x = (f: number): number => width * f;
  const y = (f: number): number => height * f;
  const lines: { color: string; closed?: boolean; pts: [number, number][] }[] = [
    { color: "#1f77b4", pts: [[x(0.1), y(0.3)], [x(0.3), y(0.12)], [x(0.5), y(0.3)], [x(0.7), y(0.12)], [x(0.9), y(0.3)]] },
    { color: "#d62728", pts: [[x(0.12), y(0.62)], [x(0.5), y(0.42)], [x(0.88), y(0.62)]] },
    { color: "#2ca02c", closed: true, pts: [[x(0.5), y(0.66)], [x(0.78), y(0.92)], [x(0.22), y(0.92)]] },
  ];
  const scene = new Scene();
  scene.group("lines", (g) => {
    lines.forEach((l, i) => {
      g.drawable(
        i,
        (ctx) => {
          ctx.moveTo(l.pts[0]![0], l.pts[0]![1]);
          for (let k = 1; k < l.pts.length; k++) ctx.lineTo(l.pts[k]![0], l.pts[k]![1]);
          if (l.closed) ctx.closePath();
        },
        { lineWidth, lineJoin: opts.join, miterLimit: opts.miterLimit, lineCap: opts.cap },
      );
    });
  });
  lines.forEach((l, i) => scene.setStroke("lines", i, l.color));
  return scene;
}
