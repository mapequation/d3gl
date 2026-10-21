/**
 * Per-instance offsets on the instanced lanes (#509, step 1): circles, lines, arrows and half-arrows take
 * optional offsets in the layer's size units, and each end is drawn at `project(P) + offset` px in `screen`
 * mode and at `P + offset` in `world` mode.
 *
 * The reference for an offset layer is the same layer without offsets, its ends moved in world units by
 * `offset / k` (screen) or `offset` (world): `project(P + off / k) = project(P) + off`. Each case renders both
 * through WebGL (the shaders), Canvas and SVG (the `instanced-vector.ts` twins, the WebGL export's path), at two
 * zooms ≠ 1, and pixel-diffs them (the backend-equivalence harness). A control asserts the offsets move the
 * drawing, so a column that is silently dropped fails.
 *
 * The GL-spy legs pin the cost: a layer without offsets allocates no offset buffer, and a zoom sweep (or a
 * re-emit with the same offset arrays) uploads 0 bytes of offsets.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { GroupBuffers } from "../core/scene.js";
import type { InstancedLayer, RenderLayer, ViewTransform } from "../core/index.js";
import { instancedVectorLayers } from "../core/instanced-vector.js";
import { WebGLBackend } from "../webgl/webgl-backend.js";
import { offsetColumnStats } from "../webgl/instanced.js";
import { renderWebGLBackend, renderCanvasBackend, renderSVG, diffPixels, type PixelBuffer } from "./__tests__/backend-equivalence-harness.js";

const W = 240;
const H = 240;
/** Two zooms ≠ 1: at k = 1 a px offset and a world offset coincide, so one zoom would prove nothing. */
const ZOOMS = [1.8, 3.2] as const;
type Mode = "world" | "screen";

function zoomAbout(k: number): ViewTransform {
  return { k, x: (W / 2) * (1 - k), y: (H / 2) * (1 - k) };
}

/** Anchors within ±20 world units of the viewport centre: in view at k = 3.2 (a 75-unit-wide world box). */
const ANCHORS = [
  [100, 104],
  [138, 100],
  [122, 136],
  [104, 132],
  [140, 130],
];
/** Offsets in size units: px in screen mode, world units in world mode (≈ the same px at k ≈ 2). */
const OFFSETS: Record<Mode, number[][]> = {
  screen: [
    [12, -8],
    [-10, 14],
    [9, 11],
    [-13, -6],
    [6, -12],
  ],
  world: [
    [5, -3],
    [-4, 6],
    [4, 5],
    [-6, -3],
    [3, -5],
  ],
};
/** Link ends (indices into ANCHORS), a reciprocal pair among them. */
const SRC = [0, 1, 2, 3];
const TGT = [1, 0, 4, 2];
/** Glyph size: px in screen mode, world units in world mode. */
const SIZE: Record<Mode, number> = { screen: 7, world: 3 };
const PALETTE = [
  [220, 40, 40],
  [40, 140, 60],
  [40, 80, 220],
  [200, 140, 20],
  [140, 40, 180],
];

function colors(n: number): Uint8Array {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) out.set([...(PALETTE[i % PALETTE.length] ?? [0, 0, 0]), 255], i * 4);
  return out;
}

function fill(n: number, v: number): Float32Array {
  return new Float32Array(n).fill(v);
}

/** The ends `ids` pick from ANCHORS, and their offsets. */
function ends(ids: readonly number[], mode: Mode): { pos: Float32Array; off: Float32Array } {
  const pos = new Float32Array(ids.length * 2);
  const off = new Float32Array(ids.length * 2);
  ids.forEach((id, i) => {
    pos.set(ANCHORS[id] ?? [0, 0], i * 2);
    off.set(OFFSETS[mode][id] ?? [0, 0], i * 2);
  });
  return { pos, off };
}

/** `pos` moved by `off · scale` world units: the no-offset layer an offset layer must draw as. */
function moved(pos: Float32Array, off: Float32Array, scale: number): Float32Array {
  return pos.map((p, i) => p + (off[i] ?? 0) * scale);
}

type Variant = "offsets" | "reference" | "none";
type Primitive = "circles" | "lines" | "arrows" | "half-arrows";

/**
 * One instanced layer of `primitive`: with its offset columns (`offsets`), without them but with its ends moved
 * to where the offsets draw them at zoom `k` (`reference`), or without either (`none`, the control).
 */
function layer(primitive: Primitive, mode: Mode, k: number, variant: Variant): InstancedLayer {
  const scale = mode === "screen" ? 1 / k : 1;
  const size = SIZE[mode];
  const place = (e: { pos: Float32Array; off: Float32Array }): { at: Float32Array; off?: Float32Array } =>
    variant === "offsets" ? { at: e.pos, off: e.off } : variant === "reference" ? { at: moved(e.pos, e.off, scale) } : { at: e.pos };
  if (primitive === "circles") {
    const c = place(ends([0, 1, 2, 3, 4], mode));
    return { name: "glyphs", sizeMode: mode, primitive, circles: { centers: c.at, offsets: c.off, radii: fill(5, size), colors: colors(5), count: 5 } };
  }
  const n = SRC.length;
  const s = place(ends(SRC, mode));
  const t = place(ends(TGT, mode));
  const bends = new Float32Array([0, 0.25, -0.3, 0.15]);
  const offs = { sourceOffsets: s.off, targetOffsets: t.off };
  if (primitive === "lines") {
    return { name: "glyphs", sizeMode: mode, primitive, lines: { sources: s.at, targets: t.at, widths: fill(n, size / 2), colors: colors(n), bends, samples: 16, count: n, ...offs } };
  }
  if (primitive === "arrows") {
    return { name: "glyphs", sizeMode: mode, primitive, arrows: { sources: s.at, targets: t.at, radii: fill(n, size), sizes: fill(n, size), colors: colors(n), bends, count: n, ...offs } };
  }
  const radii = fill(2 * n, size);
  const widths = new Float32Array(2 * n).fill(size / 2);
  return { name: "glyphs", sizeMode: mode, primitive, halfArrows: { sources: s.at, targets: t.at, radii, widths, bends: fill(n, 0.2), colors: colors(n), count: n, ...offs } };
}

const NO_BUFFERS: GroupBuffers = {
  fillVertices: new Float32Array(0),
  fillIndices: new Uint32Array(0),
  strokeVertices: new Float32Array(0),
  strokeIndices: new Uint32Array(0),
  fillColors: new Uint8Array(0),
  strokeColors: new Uint8Array(0),
  flags: new Uint8Array(0),
  drawableCount: 0,
  pointCenters: new Float32Array(0),
  pointCount: 0,
  fillAnchors: new Float32Array(0),
  strokeAnchors: new Float32Array(0),
  ranges: [],
};

/** The layer's vector twin at zoom `k` (the WebGL export's path), as retained layers for Canvas and SVG. */
function vectorLayers(l: InstancedLayer, k: number): RenderLayer[] {
  return instancedVectorLayers([l], k).map((v) => ({ ...v, buffers: NO_BUFFERS }));
}

async function renders(l: InstancedLayer, k: number): Promise<{ gl: PixelBuffer; canvas: PixelBuffer; svg: PixelBuffer }> {
  const transform = zoomAbout(k);
  const gl = await renderWebGLBackend([], W, H, { instanced: [l], transform });
  const canvas = renderCanvasBackend(vectorLayers(l, k), W, H, { transform });
  const svg = await renderSVG(vectorLayers(l, k), W, H, { transform });
  return { gl, canvas, svg };
}

const PRIMITIVES: Primitive[] = ["circles", "lines", "arrows", "half-arrows"];

describe("instanced offsets draw at project(P) + off (screen) and P + off (world) (#509)", () => {
  for (const primitive of PRIMITIVES) {
    for (const mode of ["screen", "world"] as const) {
      for (const k of ZOOMS) {
        it(`${primitive}, ${mode}, k = ${k}: WebGL, Canvas and SVG draw the offset layer as its moved twin`, async () => {
          const off = await renders(layer(primitive, mode, k, "offsets"), k);
          const ref = await renders(layer(primitive, mode, k, "reference"), k);
          const none = renderCanvasBackend(vectorLayers(layer(primitive, mode, k, "none"), k), W, H, { transform: zoomAbout(k) });
          const exact = { radius: 1 };
          // Each backend draws the offset layer where its no-offset twin with moved ends draws.
          expect(diffPixels(off.gl, ref.gl, exact).fraction).toBeLessThan(0.01);
          expect(diffPixels(off.canvas, ref.canvas, exact).fraction).toBeLessThan(0.01);
          expect(diffPixels(off.svg, ref.svg, exact).fraction).toBeLessThan(0.01);
          // The backends agree with each other (WebGL's tessellation vs the vector rasterizers).
          expect(diffPixels(off.gl, off.svg, { radius: 2 }).fraction).toBeLessThan(0.05);
          expect(diffPixels(off.canvas, off.svg, exact).fraction).toBeLessThan(0.02);
          // Control: the offsets move the drawing.
          expect(diffPixels(off.canvas, none, exact).fraction).toBeGreaterThan(0.3);
        });
      }
    }
  }
});

describe("the link pick pass reads the offsets (#509)", () => {
  for (const mode of ["screen", "world"] as const) {
    it(`${mode}: a pick hits a line where its offset ends draw it, not at its anchors`, async () => {
      const k = 1.8;
      const t = zoomAbout(k);
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const backend = await WebGLBackend.create(canvas, { width: W, height: H });
      const off = mode === "screen" ? [0, 30] : [0, 30 / k]; // 30 px down at this zoom, either way
      const offsets = new Float32Array([off[0] ?? 0, off[1] ?? 0]);
      const lines = {
        sources: new Float32Array([100, 110]),
        targets: new Float32Array([140, 110]),
        widths: fill(1, mode === "screen" ? 6 : 6 / k),
        colors: colors(1),
        sourceOffsets: offsets,
        targetOffsets: offsets,
        count: 1,
      };
      backend.setInstancedLayer({ name: "links", sizeMode: mode, primitive: "lines", pickable: true, lines });
      backend.setTransform(t);
      backend.render();
      const x = 120 * k + t.x;
      const y = 110 * k + t.y;
      expect(backend.pickInstanced(x, y + 30, true)).toBe(0);
      expect(backend.pickInstanced(x, y, true)).toBe(-1);
      backend.destroy();
    });
  }
});

/** `l` with fresh copies of its positions (a moved frame) and the same offset and style arrays. */
function withNewPositions(l: InstancedLayer): InstancedLayer {
  switch (l.primitive) {
    case "circles":
      return { ...l, circles: { ...l.circles, centers: l.circles.centers.slice() } };
    case "lines":
      return { ...l, lines: { ...l.lines, sources: l.lines.sources.slice(), targets: l.lines.targets.slice() } };
    case "arrows":
      return { ...l, arrows: { ...l.arrows, sources: l.arrows.sources.slice(), targets: l.arrows.targets.slice() } };
    case "half-arrows":
      return { ...l, halfArrows: { ...l.halfArrows, sources: l.halfArrows.sources.slice(), targets: l.halfArrows.targets.slice() } };
    default:
      return l;
  }
}

describe("offset columns cost nothing per frame (#509)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a layer without offsets allocates no offset buffer; a zoom sweep and a same-array re-emit upload 0 offset bytes", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const backend = await WebGLBackend.create(canvas, { width: W, height: H });
    const createBuffer = vi.spyOn(WebGL2RenderingContext.prototype, "createBuffer");

    // Without offsets: no offset buffer, and as many GL buffers as with offsets minus one per offset column.
    const before = { ...offsetColumnStats };
    for (const p of PRIMITIVES) backend.setInstancedLayer({ ...layer(p, "screen", 2, "none"), name: `plain-${p}` });
    expect(offsetColumnStats).toEqual(before);
    const plainBuffers = createBuffer.mock.calls.length;

    createBuffer.mockClear();
    const withOffsets = PRIMITIVES.map((p) => ({ ...layer(p, "screen", 2, "offsets"), name: `offset-${p}` }));
    for (const l of withOffsets) backend.setInstancedLayer(l);
    const columns = 1 + 2 + 2 + 2; // circles: offsets; links: source + target offsets
    expect(offsetColumnStats.buffers - before.buffers).toBe(columns);
    expect(createBuffer.mock.calls.length - plainBuffers).toBe(columns);

    // A zoom sweep: 0 bytes uploaded, offsets or otherwise (the lanes are static; the view is a uniform).
    const sub = vi.spyOn(WebGL2RenderingContext.prototype, "bufferSubData");
    const data = vi.spyOn(WebGL2RenderingContext.prototype, "bufferData");
    const sweepStart = { ...offsetColumnStats };
    for (const k of [0.25, 0.5, 1, 2, 4, 8, 16]) {
      backend.setTransform(zoomAbout(k));
      backend.render();
    }
    const uploaded = (calls: readonly unknown[][], at: number): number =>
      calls.reduce((sum, c) => {
        const v = c[at];
        return sum + (ArrayBuffer.isView(v) ? v.byteLength : typeof v === "number" ? v : 0);
      }, 0);
    expect(uploaded(sub.mock.calls, 2) + uploaded(data.mock.calls, 1)).toBe(0);
    expect(offsetColumnStats).toEqual(sweepStart);

    // A lane re-emit with new positions and the SAME offset arrays: the offsets are not re-uploaded.
    for (const l of withOffsets) backend.updateInstancedLayer(withNewPositions(l));
    expect(offsetColumnStats).toEqual(sweepStart);
    backend.destroy();
  });
});
