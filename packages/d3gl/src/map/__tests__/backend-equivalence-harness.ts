/**
 * Backend-equivalence test harness (issues #41, #209).
 *
 * Renders the SAME layers through the three backends — WebGL ({@link WebGLBackend}
 * / {@link GroupRenderer}), Canvas ({@link CanvasBackend}), and SVG (the shared
 * {@link svgFromLayers} serializer, rasterized via an `<img>`) — into RGBA pixel
 * buffers with a common top-left origin, and diffs them. The goal is a reusable
 * regression net proving the backends composite identically (overlapping
 * fills/strokes, draw order, text, points, translucency, clipping, …) — not just
 * that each renders *something*.
 *
 * Not shipped: this lives under `__tests__` and is imported only by browser tests.
 */
import type { Device } from "@luma.gl/core";
import { Scene, type RenderLayer } from "../../core/index.js";
import type { Backend, InstancedCirclesData, InstancedLayer, PathRecorder, TextData, ViewTransform } from "../../core/index.js";
import { GroupRenderer } from "../../webgl/renderer.js";
import { clipFromView } from "../../webgl/transform.js";
import { CanvasBackend } from "../../canvas/canvas-backend.js";
import { WebGLBackend } from "../../webgl/webgl-backend.js";
import { svgFromLayers } from "../../svg/index.js";
import { traceFrontierGlyphs, rgbaCss } from "../../network/glyphs.js";

export interface PixelBuffer {
  width: number;
  height: number;
  /** RGBA bytes, row-major from the TOP-left (matches Canvas getImageData). */
  data: Uint8Array;
}

/** Build a {@link RenderLayer} from a Scene group (mirrors BaseEngine.renderLayer).
 *  `opts` forwards the layer settings the backends act on (`clipTo`, `sizeMode`). */
export function layerOf(scene: Scene, name: string, opts: { clipTo?: string; sizeMode?: "world" | "screen" } = {}): RenderLayer {
  return { name, buffers: scene.buffers(name), drawables: scene.drawables(name), ...opts };
}

/** Options shared by the three backend-level renderers ({@link renderWebGLBackend},
 *  {@link renderCanvasBackend}, {@link renderSVG}). */
export interface BackendRenderOptions {
  /** View transform for the render (default identity). A non-identity zoom is what makes
   *  `sizeMode: "screen"` observable — at k=1 world and screen render the same. */
  transform?: ViewTransform;
  /** Screen-space text labels, pushed through the backend's optional `setTextLayer` seam
   *  (Canvas/SVG render them; a backend without the seam ignores them). */
  texts?: readonly TextData[];
  /** GPU-instanced primitive layers (WebGL only — Canvas/SVG render their Scene twins),
   *  drawn after the retained layers, mirroring the network lane. */
  instanced?: readonly InstancedLayer[];
}

const IDENTITY: ViewTransform = { k: 1, x: 0, y: 0 };

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return ctx;
}

/** Decode an image data URL (PNG or SVG) into a top-left-origin RGBA buffer. */
export async function decodeImage(url: string, width: number, height: number): Promise<PixelBuffer> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = ctx2d(canvas);
  ctx.drawImage(img, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);
  return { width, height, data: new Uint8Array(data.data.buffer.slice(0)) };
}

/**
 * Render layers through the full {@link WebGLBackend} (stencil clip + sizeMode orchestration,
 * instanced lane) and read the frame back via its `toPNG()` export — the offscreen target runs
 * the same `drawInto` composite as the live screen. Labels are pushed through the optional
 * `setTextLayer` seam — a no-op until the backend implements it (#219), after which the
 * export composites them like Canvas does.
 */
export async function renderWebGLBackend(
  layers: readonly RenderLayer[],
  width: number,
  height: number,
  opts: BackendRenderOptions = {},
): Promise<PixelBuffer> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const backend: Backend = await WebGLBackend.create(canvas, { width, height });
  backend.setLayers([...layers]);
  for (const layer of opts.instanced ?? []) backend.setInstancedLayer?.(layer);
  if (opts.texts) backend.setTextLayer?.(opts.texts);
  backend.setTransform(opts.transform ?? IDENTITY);
  const png = backend.toPNG();
  backend.destroy();
  return decodeImage(png, width, height);
}

/** Render layers (+ optional text labels) through the full {@link CanvasBackend} and read the
 *  canvas back (top-left origin). */
export function renderCanvasBackend(
  layers: readonly RenderLayer[],
  width: number,
  height: number,
  opts: BackendRenderOptions = {},
): PixelBuffer {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const backend = new CanvasBackend(canvas, width, height);
  backend.setLayers([...layers]);
  if (opts.texts) backend.setTextLayer(opts.texts);
  backend.setTransform(opts.transform ?? IDENTITY);
  backend.render();
  const img = ctx2d(canvas).getImageData(0, 0, width, height);
  backend.destroy();
  return { width, height, data: new Uint8Array(img.data.buffer.slice(0)) };
}

/**
 * Render layers (+ optional text labels) through the SVG backend's shared serializer
 * ({@link svgFromLayers} — the same string `SvgBackend.render()` builds its live DOM from and
 * every backend's `toSVG()` exports) and rasterize it in-browser via an `<img>` + `drawImage`,
 * so SVG output participates in the same pixel diff as the raster backends (#209).
 */
export async function renderSVG(
  layers: readonly RenderLayer[],
  width: number,
  height: number,
  opts: BackendRenderOptions = {},
): Promise<PixelBuffer> {
  return rasterizeSVG(svgFromLayers(width, height, [...layers], opts.transform ?? IDENTITY, opts.texts ?? []), width, height);
}

/**
 * Rasterize an SVG **document string** — a backend's `toSVG()` output — into a top-left-origin RGBA
 * buffer, so two backends' *exports* can be pixel-diffed by the same {@link diffPixels} the live
 * renders use (#271).
 *
 * Why this is the right comparison: both documents go through the *same* browser rasterizer, so the
 * only thing the diff can see is the geometry and colour the two serializers wrote. The live-render
 * diff cannot substitute — the WebGL export is produced by {@link instancedVectorLayers}, a code path
 * the GPU render never touches, so an error there (notably the screen-`sizeMode` bake, whose
 * constant-pixel terms are non-linear in `k`) is invisible on screen and only shows in the file.
 */
export async function rasterizeSVG(svg: string, width: number, height: number): Promise<PixelBuffer> {
  return decodeImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width, height);
}

/** Rasterize two `toSVG()` documents for the same view and diff them position-tolerantly (#271).
 *  Both are left on a transparent background so `considered` counts INK, not the whole viewport —
 *  a fraction over ink is what makes a small displaced glyph a large, assertable number. */
export async function diffExports(a: string, b: string, width: number, height: number, opts: DiffOptions = {}): Promise<DiffResult> {
  const [pa, pb] = await Promise.all([rasterizeSVG(a, width, height), rasterizeSVG(b, width, height)]);
  return diffPixels(pa, pb, opts);
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
  join?: "miter" | "bevel" | "round";
  miterLimit?: number;
  cap?: "butt" | "square" | "round";
  /** Per-line stroke colors (default an opaque palette) — pass `rgba(…)` strings to probe
   *  TRANSLUCENT strokes, where WebGL's tessellated stroke self-overlaps and double-blends (#46). */
  colors?: readonly string[];
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
  lines.forEach((l, i) => scene.setStroke("lines", i, opts.colors?.[i] ?? l.color));
  return scene;
}

// ---------------------------------------------------------------------------
// #209 scenes: the feature families beyond fills/strokes — text labels, point
// glyphs (world/screen sizeMode), translucency, clipping, and the instanced-vs-
// Scene faded glyph (the #155 cross-fade divergence).
// ---------------------------------------------------------------------------

/** Trace an axis-aligned rectangle (clockwise). */
function traceRect(ctx: PathRecorder, x: number, y: number, w: number, h: number): void {
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
}

/** Trace a full circle (flattened by the recorder — identical geometry on every backend). */
function traceDisc(ctx: PathRecorder, cx: number, cy: number, r: number): void {
  ctx.moveTo(cx + r, cy);
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.closePath();
}

/** Trace a closed regular n-gon (a flattened disc). `ccw` picks the winding, which is what
 *  selects solid vs. hole for a nested ring under the nonzero fill rule. */
function traceRing(ctx: PathRecorder, cx: number, cy: number, r: number, ccw: boolean, n = 64): void {
  const step = ((ccw ? 1 : -1) * 2 * Math.PI) / n;
  ctx.moveTo(cx + r, cy);
  for (let i = 1; i < n; i++) ctx.lineTo(cx + r * Math.cos(i * step), cy + r * Math.sin(i * step));
  ctx.closePath();
}

/**
 * Nested ring topology (#73): one drawable whose subpaths nest 3 deep — land ▸ lake ▸
 * island ▸ pond — plus an off-centre island in a lake, plus a plain single-ring control.
 *
 * Canvas (`ctx.fill()`) and SVG (`fill-rule: nonzero`) resolve these natively; WebGL has to
 * recover outer/hole from the geometry (`groupRings` → `tessellateFill`), so this scene is a
 * direct probe of that recovery. Successive levels alternate winding, the convention `geoPath`
 * emits (AGENTS.md "GeoJSON winding"), so the fill must alternate solid/hole with depth. Before
 * #73, ring classification was single-level: every ring inside the land became a hole of it, so
 * the island and pond vanished (and the overlapping holes made earcut drop geometry outright).
 *
 * Fills are OPAQUE over the backdrop, so a wrongly-classified ring is a solid several-thousand-
 * pixel block of the wrong colour — orders of magnitude past the diff's 1px position tolerance.
 */
export function nestedRingShapes(width: number, height: number): Scene {
  const s = Math.min(width, height);
  const scene = new Scene();
  scene.group("nested", (g) => {
    // Depth 3, concentric: land (solid) ▸ lake (hole) ▸ island (solid) ▸ pond (hole).
    g.drawable(0, (ctx) => {
      const cx = width * 0.33;
      const cy = height * 0.36;
      traceRing(ctx, cx, cy, s * 0.29, false);
      traceRing(ctx, cx, cy, s * 0.22, true);
      traceRing(ctx, cx, cy, s * 0.14, false);
      traceRing(ctx, cx, cy, s * 0.06, true);
    });
    // Depth 2, off-centre: the island sits near the lake's rim, and the whole landmass has a
    // second, plain lake — so one drawable mixes a depth-1 and a depth-2 ring.
    g.drawable(1, (ctx) => {
      traceRing(ctx, width * 0.68, height * 0.66, s * 0.3, false);
      traceRing(ctx, width * 0.62, height * 0.6, s * 0.17, true);
      traceRing(ctx, width * 0.57, height * 0.56, s * 0.08, false);
      traceRing(ctx, width * 0.79, height * 0.76, s * 0.07, true);
    });
    // Control: an ordinary single-ring shape must be unaffected by the classifier change.
    g.drawable(2, (ctx) => traceRing(ctx, width * 0.85, height * 0.16, s * 0.11, false));
  });
  scene.setFill("nested", 0, "#1f77b4");
  scene.setFill("nested", 1, "#2ca02c");
  scene.setFill("nested", 2, "#d62728");
  return scene;
}

/**
 * A full-viewport opaque backdrop layer (group `"backdrop"`). Translucent scenes composite
 * onto it so the diff compares what the USER sees: over a *transparent* background the
 * backends legitimately store different bytes for the same visual result (WebGL's blend
 * leaves alpha-scaled RGB in the framebuffer, Canvas `getImageData` un-premultiplies, and
 * the PNG/SVG decode paths round-trip premultiplication). An opaque base makes every output
 * pixel opaque and directly byte-comparable.
 */
export function backdropScene(width: number, height: number, color = "#ffffff"): Scene {
  const scene = new Scene();
  scene.group("backdrop", (g) => {
    g.drawable(0, (ctx) => traceRect(ctx, 0, 0, width, height));
  });
  scene.setFill("backdrop", 0, color);
  return scene;
}

/**
 * Screen-space text labels over a backdrop + a disc (group `"bg"`), exercising the
 * `setTextLayer` path: alignment (start/middle/end), font weight/size, halo
 * (`paint-order: stroke` vs a stroked-then-filled Canvas pass), a label crossing a
 * geometry edge, and opacity (on a halo-less label — Canvas applies `globalAlpha`
 * per draw op, so a faded halo+fill pair would double-composite where they overlap,
 * unlike SVG's element opacity; that combination is deliberately not probed here).
 */
export function textLabelScene(width: number, height: number): { scene: Scene; texts: TextData[] } {
  const scene = new Scene();
  const r = Math.min(width, height) * 0.18;
  scene.group("bg", (g) => {
    g.drawable(0, (ctx) => traceRect(ctx, 0, 0, width, height));
    g.drawable(1, (ctx) => traceDisc(ctx, width / 2, height * 0.48, r));
  });
  scene.setFill("bg", 0, "#ffffff");
  scene.setFill("bg", 1, "#1f77b4");
  const texts: TextData[] = [
    { x: width / 2, y: height * 0.14, text: "Alpha 42", font: "600 20px sans-serif", color: "#111111", halo: { color: "#ffffff", width: 2 }, align: "middle" },
    { x: 8, y: height * 0.3, text: "start-aligned", font: "14px sans-serif", color: "#d62728", align: "start" },
    { x: width - 8, y: height * 0.66, text: "end-aligned", font: "14px sans-serif", color: "#2ca02c", align: "end" },
    { x: width / 2, y: height * 0.48, text: "on glyph", font: "13px sans-serif", color: "#ffffff", halo: { color: "#111111", width: 1.5 }, align: "middle" },
    { x: width / 2, y: height * 0.86, text: "faded", font: "16px sans-serif", color: "#1f77b4", align: "middle", opacity: 0.7 },
  ];
  return { scene, texts };
}

/**
 * Analytic circle glyphs (`g.point` / `g.points` — group `"points"`): the point lane every
 * backend specializes (WebGL circle-instance shader, Canvas `arc()`, SVG `<circle>`).
 * Render under a NON-identity zoom so world vs screen sizeMode actually differ: world radii
 * scale ×k while screen radii stay constant px (centres project either way). Includes an
 * overlapping pair (draw order) and a MultiPoint drawable.
 */
export function pointGlyphs(width: number, height: number): Scene {
  const scene = new Scene();
  const pts = [
    { x: 0.40, y: 0.40, r: 16, color: "#1f77b4" },
    { x: 0.47, y: 0.44, r: 12, color: "#ff7f0e" }, // overlaps the first → draw order
    { x: 0.52, y: 0.60, r: 7, color: "#2ca02c" },
    { x: 0.63, y: 0.55, r: 4, color: "#d62728" },
  ];
  scene.group("points", (g) => {
    pts.forEach((p, i) => g.point(i, width * p.x, height * p.y, p.r));
    g.points(pts.length, [
      [width * 0.36, height * 0.56],
      [width * 0.42, height * 0.64],
      [width * 0.35, height * 0.66],
    ], 4);
  });
  pts.forEach((p, i) => scene.setFill("points", i, p.color));
  scene.setFill("points", pts.length, "#9467bd");
  return scene;
}

/**
 * Overlapping TRANSLUCENT fills (group `"fills"`): straight source-over compositing must
 * agree across backends everywhere, including the double-covered lens regions. Fills, unlike
 * strokes, have no self-overlapping geometry, so this must match tightly 3-way (the
 * translucent-STROKE self-overlap divergence is #46, pinned separately).
 */
export function translucentFills(width: number, height: number): Scene {
  const scene = new Scene();
  const R = Math.min(width, height) * 0.22;
  const discs = [
    { x: 0.38, y: 0.4, color: "rgba(31, 119, 180, 0.5)" },
    { x: 0.62, y: 0.4, color: "rgba(214, 39, 40, 0.5)" },
    { x: 0.5, y: 0.62, color: "rgba(44, 160, 44, 0.5)" },
  ];
  scene.group("fills", (g) => {
    discs.forEach((d, i) => {
      g.drawable(i, (ctx) => traceDisc(ctx, width * d.x, height * d.y, R));
    });
  });
  discs.forEach((d, i) => scene.setFill("fills", i, d.color));
  return scene;
}

/**
 * A clip source + content crossing its boundary: content must be cut identically by the SVG
 * `<clipPath>`, Canvas `ctx.clip()`, and WebGL stencil paths. The mask layer is also a
 * normally-drawn layer (every backend draws the clip source's own fill). Bars cross the
 * mask's top/bottom rim (clipped fill + stroke) and a disc straddles its right edge.
 * Build layers as `[mask, layerOf(scene, "content", { clipTo: "mask" })]`.
 */
export function clippedShapes(width: number, height: number): Scene {
  const scene = new Scene();
  const cx = width / 2;
  const cy = height / 2;
  const R = Math.min(width, height) * 0.33;
  scene.group("mask", (g) => {
    g.drawable(0, (ctx) => traceDisc(ctx, cx, cy, R));
  });
  scene.setFill("mask", 0, "#dddddd");
  scene.group("content", (g) => {
    const barW = width * 0.09;
    [0.32, 0.5, 0.68].forEach((fx, i) => {
      g.drawable(i, (ctx) => traceRect(ctx, width * fx - barW / 2, height * 0.1, barW, height * 0.8), { lineWidth: 3 });
    });
    g.drawable(3, (ctx) => traceDisc(ctx, cx + R, cy, width * 0.11));
  });
  ["#1f77b4", "#ff7f0e", "#2ca02c"].forEach((c, i) => {
    scene.setFill("content", i, c);
    scene.setStroke("content", i, "#ffffff");
  });
  scene.setFill("content", 3, "#d62728");
  return scene;
}

/**
 * The #155 cross-fade case, at the seam it actually lives on: a fading bordered glyph drawn by the
 * WebGL **instanced circle** lane (fill + border resolved per-fragment, composited ONCE at the fade
 * alpha) vs its Canvas/SVG **Scene twin**. BOTH fill and ring are translucent here — the one thing
 * the ring encoding (#269) cannot make exact, since a circle's stroke straddles its own path and so
 * double-blends over the fill on the ring's inner half. Alphas are faded ×0.55 as a mid-transition
 * cross-fade would; two glyphs overlap (parent↔child mid-transition), compounding the effect. See
 * {@link translucentBorderedGlyphs} for the opaque-ring case, which IS exact.
 */
export function fadedGlyphs(width: number, height: number): { circles: InstancedCirclesData; scene: Scene } {
  const fade = 0.55;
  const nodes = [
    { x: 0.36, y: 0.4, r: 0.17, fill: [31, 119, 180], border: [15, 60, 90] },
    { x: 0.52, y: 0.47, r: 0.13, fill: [255, 127, 14], border: [128, 64, 7] }, // overlaps the first
    { x: 0.42, y: 0.68, r: 0.1, fill: [44, 160, 44], border: [22, 80, 22] },
    { x: 0.68, y: 0.66, r: 0.12, fill: [148, 103, 189], border: [74, 52, 95] },
  ];
  const count = nodes.length;
  const centers = new Float32Array(count * 2);
  const radii = new Float32Array(count);
  const colors = new Uint8Array(count * 4);
  const borders = new Float32Array(count);
  const borderColors = new Uint8Array(count * 4);
  const alpha = Math.round(255 * fade);
  nodes.forEach((n, i) => {
    centers[i * 2] = width * n.x;
    centers[i * 2 + 1] = height * n.y;
    radii[i] = Math.min(width, height) * n.r;
    borders[i] = 0.3;
    colors.set([...n.fill, alpha], i * 4);
    borderColors.set([...n.border, alpha], i * 4);
  });
  const circles: InstancedCirclesData = { centers, radii, colors, borders, borderColors, count };
  return { circles, scene: glyphScene(circles) };
}

/**
 * A TRANSLUCENT-fill bordered glyph over an opaque backdrop (#269): the case where the Scene
 * path's encoding of a bordered circle is observable. The WebGL instanced lane resolves fill vs
 * ring per fragment and composites each region ONCE; the Scene twin must do the same. Border is
 * OPAQUE and near-black against a white backdrop, so an inner disc that composites the fill over
 * the ring colour (the old stacked-disc encoding) reads ~120 RGB units off — far over the diff's
 * 40-unit colour tolerance — while the correct encoding matches exactly.
 */
export function translucentBorderedGlyphs(width: number, height: number): { circles: InstancedCirclesData; scene: Scene } {
  const nodes = [
    { x: 0.34, y: 0.36, r: 0.19, fill: [31, 119, 180], border: 0.28 },
    { x: 0.62, y: 0.42, r: 0.15, fill: [44, 160, 44], border: 0.34 },
    { x: 0.45, y: 0.7, r: 0.13, fill: [255, 127, 14], border: 0.22 },
  ];
  const count = nodes.length;
  const centers = new Float32Array(count * 2);
  const radii = new Float32Array(count);
  const colors = new Uint8Array(count * 4);
  const borders = new Float32Array(count);
  const borderColors = new Uint8Array(count * 4);
  nodes.forEach((n, i) => {
    centers[i * 2] = width * n.x;
    centers[i * 2 + 1] = height * n.y;
    radii[i] = Math.min(width, height) * n.r;
    borders[i] = n.border;
    colors.set([...n.fill, 128], i * 4); // translucent fill (α ≈ 0.5)
    borderColors.set([17, 17, 17, 255], i * 4); // opaque near-black ring
  });
  const circles: InstancedCirclesData = { centers, radii, colors, borders, borderColors, count };
  return { circles, scene: glyphScene(circles) };
}

/** The Scene twin of an instanced-circle layer: exactly what the network's LOD frontier traces
 *  into the retained Scene for Canvas/SVG (`traceFrontierGlyphs` — one ring-encoded circle per
 *  glyph), coloured from the same SoA byte buffers the instanced lane uploads. */
function glyphScene(circles: InstancedCirclesData): Scene {
  const frontier = new Uint32Array(circles.count);
  for (let i = 0; i < circles.count; i++) frontier[i] = i;
  const scene = new Scene();
  scene.group(GLYPH_GROUP, (g) => traceFrontierGlyphs(g, circles, frontier));
  const borderColors = circles.borderColors;
  for (let i = 0; i < circles.count; i++) {
    scene.setFill(GLYPH_GROUP, i, rgbaCss(circles.colors, i));
    if (borderColors) scene.setStroke(GLYPH_GROUP, i, rgbaCss(borderColors, i));
  }
  return scene;
}

const GLYPH_GROUP = "glyphs";

/** The Scene layers `glyphScene` produces, in draw order. */
export function glyphSceneLayers(scene: Scene): RenderLayer[] {
  return [layerOf(scene, GLYPH_GROUP)];
}
