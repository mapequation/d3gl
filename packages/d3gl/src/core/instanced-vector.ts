import type { DrawableVector } from "./scene.js";
import type {
  InstancedLayer,
  InstancedCirclesData,
  InstancedPieData,
  InstancedLinesData,
  InstancedArrowsData,
  InstancedHalfArrowsData,
  VectorLayer,
} from "./backend.js";
import { PathRecorder } from "./path-recorder.js";
import { DEFAULT_CURVE_TOLERANCE } from "./flatten.js";
import { DEFAULT_MITER_LIMIT } from "./stroke.js";
import { bezierControl, bentEndTangent, straightUnit, halfLinkGeometry, traceHalfLink, scaleHalfLink } from "./half-link.js";
import type { Subpath } from "./path-context.js";

/**
 * Vector view of the GPU-instanced lanes, for **export only** (#200).
 *
 * The instanced lanes (network nodes/links/pies, decluttered plot points) are pushed straight to
 * the GPU as SoA typed arrays — they have no retained {@link Scene}, so `toSVG()` on the WebGL
 * backend used to serialize an empty document. These converters turn one emit's SoA back into
 * {@link DrawableVector}s, reusing the *same* curve math the shaders and the Canvas/SVG Scene
 * emitters use ({@link bezierControl}/{@link bentEndTangent}/{@link halfLinkGeometry}), so an
 * export reproduces the drawn view on every backend.
 *
 * **Export-only, never per frame.** Nothing here runs on a `setTransform`/`render` path: the engine
 * calls it from `toSVG()` alone, on the layers the lane emitted for the current view (O(visible)).
 */

/** Transparent black — the RGBA a drawable with no fill (or no stroke) carries. */
const NONE: [number, number, number, number] = [0, 0, 0, 0];

/** RGBA quad at instance `i` of a packed colour buffer. */
function rgbaAt(colors: Uint8Array | undefined, i: number): [number, number, number, number] {
  if (!colors) return NONE;
  return [colors[i * 4] ?? 0, colors[i * 4 + 1] ?? 0, colors[i * 4 + 2] ?? 0, colors[i * 4 + 3] ?? 0];
}

/** A drawable with the shared defaults (bevel joins / butt caps — see the compositing-equivalence
 *  notes in AGENTS.md) filled in, so instanced output strokes like Scene output does. */
function drawable(
  id: number,
  parts: { subpaths?: Subpath[]; circles?: { x: number; y: number; r: number }[]; fill?: [number, number, number, number]; stroke?: [number, number, number, number]; lineWidth?: number; anchor?: [number, number] | null },
): DrawableVector {
  return {
    id,
    subpaths: parts.subpaths ?? [],
    fill: parts.fill ?? NONE,
    stroke: parts.stroke ?? NONE,
    lineWidth: parts.lineWidth ?? 0,
    lineJoin: "bevel",
    miterLimit: DEFAULT_MITER_LIMIT,
    lineCap: "butt",
    flags: 1, // visible: the lane already dropped everything outside the emitted (visible) set
    circles: parts.circles ?? [],
    anchor: parts.anchor ?? null,
  };
}

/** Record a path through the shared {@link PathRecorder} (curve flattening identical to the Scene's,
 *  so an exported wedge and its Canvas/SVG Scene twin are baked at the SAME tolerance — #45). */
function record(draw: (ctx: PathRecorder) => void, tolerance = DEFAULT_CURVE_TOLERANCE): Subpath[] {
  const rec = new PathRecorder(tolerance);
  draw(rec);
  return rec.subpaths as Subpath[];
}

/**
 * Instanced circles → one drawable per instance.
 *
 * A `borders` entry is the ring thickness as a fraction of the radius, which the fragment shader
 * paints as the outer annulus over the fill disc. The exact vector equivalent is ONE circle stroked
 * on its ring centreline: `r·(1 − b/2)` with `stroke-width = r·b` covers `[r·(1−b), r]` in the ring
 * colour and leaves the fill visible inside — which also renders a *transparent-fill* ring (the LOD
 * aggregate halo) correctly, where two stacked discs would fill the hole.
 */
export function circlesToDrawables(c: InstancedCirclesData): DrawableVector[] {
  const out: DrawableVector[] = [];
  const { centers, radii, borders, borderColors } = c;
  for (let i = 0; i < c.count; i++) {
    const r = radii[i] ?? 0;
    const b = borders ? (borders[i] ?? 0) : 0;
    const ring = b > 0 && r > 0;
    out.push(
      drawable(i, {
        circles: [{ x: centers[i * 2] ?? 0, y: centers[i * 2 + 1] ?? 0, r: ring ? r * (1 - b / 2) : r }],
        fill: rgbaAt(c.colors, i),
        stroke: ring ? rgbaAt(borderColors, i) : NONE,
        lineWidth: ring ? r * b : 0,
      }),
    );
  }
  return out;
}

/** Full turn — the wedge fraction → angle convention the pie fragment shader uses (CCW from +x). */
const TAU = Math.PI * 2;

/** Instanced pie wedges → one filled arc sector per wedge. Screen sizeMode pins the sector at a
 *  constant pixel size around its (projected) centre via the drawable anchor, as `tracePieWedges` does. */
export function pieToDrawables(
  p: InstancedPieData,
  screen: boolean,
  tolerance = DEFAULT_CURVE_TOLERANCE,
): DrawableVector[] {
  const out: DrawableVector[] = [];
  for (let i = 0; i < p.count; i++) {
    const cx = p.centers[i * 2] ?? 0;
    const cy = p.centers[i * 2 + 1] ?? 0;
    const r = p.radii[i] ?? 0;
    const a0 = (p.angles[i * 2] ?? 0) * TAU;
    const a1 = (p.angles[i * 2 + 1] ?? 0) * TAU;
    out.push(
      drawable(i, {
        subpaths: record((ctx) => {
          ctx.moveTo(cx, cy);
          ctx.arc(cx, cy, r, a0, a1, false);
          ctx.closePath();
        }, tolerance),
        fill: rgbaAt(p.colors, i),
        anchor: screen ? [cx, cy] : null,
      }),
    );
  }
  return out;
}

/** Instanced lines → one stroked path per line (straight, or a quadratic bow for `bends`). World
 *  endpoints with a per-line width, so screen sizeMode needs no bake (the width alone is in px). */
export function linesToDrawables(l: InstancedLinesData): DrawableVector[] {
  const out: DrawableVector[] = [];
  for (let e = 0; e < l.count; e++) {
    const sx = l.sources[e * 2] ?? 0;
    const sy = l.sources[e * 2 + 1] ?? 0;
    const tx = l.targets[e * 2] ?? 0;
    const ty = l.targets[e * 2 + 1] ?? 0;
    const bend = l.bends ? (l.bends[e] ?? 0) : 0;
    out.push(
      drawable(e, {
        subpaths: record((ctx) => {
          ctx.moveTo(sx, sy);
          if (bend) {
            const [cx, cy] = bezierControl(sx, sy, tx, ty, bend);
            ctx.quadraticCurveTo(cx, cy, tx, ty);
          } else {
            ctx.lineTo(tx, ty);
          }
        }),
        stroke: rgbaAt(l.colors, e),
        lineWidth: l.widths[e] ?? 0,
      }),
    );
  }
  return out;
}

/**
 * Instanced arrowheads → one filled triangle per arrow, tip set back to the target node's boundary.
 * `bake` mirrors the Scene twin's screen-sizeMode trick: solve in pixel space (×k) and emit ÷k, so
 * the world-coordinate output reproduces the constant-pixel GPU render under the view's ×k transform.
 */
export function arrowsToDrawables(a: InstancedArrowsData, bake = 1): DrawableVector[] {
  const inv = 1 / bake;
  const half = a.half === true;
  const out: DrawableVector[] = [];
  for (let e = 0; e < a.count; e++) {
    const sx = (a.sources[e * 2] ?? 0) * bake;
    const sy = (a.sources[e * 2 + 1] ?? 0) * bake;
    const tx = (a.targets[e * 2] ?? 0) * bake;
    const ty = (a.targets[e * 2 + 1] ?? 0) * bake;
    const bend = a.bends ? (a.bends[e] ?? 0) : 0;
    const [ux, uy] = bend ? bentEndTangent(sx, sy, tx, ty, bend) : straightUnit(sx, sy, tx, ty);
    const px = -uy;
    const py = ux;
    const setback = a.radii[e] ?? 0;
    const size = a.sizes[e] ?? 0;
    const tipX = tx - ux * setback;
    const tipY = ty - uy * setback;
    const baseX = tipX - ux * 2 * size;
    const baseY = tipY - uy * 2 * size;
    out.push(
      drawable(e, {
        subpaths: record((ctx) => {
          ctx.moveTo(tipX * inv, tipY * inv);
          ctx.lineTo((half ? baseX : baseX - px * size) * inv, (half ? baseY : baseY - py * size) * inv);
          ctx.lineTo((baseX + px * size) * inv, (baseY + py * size) * inv);
          ctx.closePath();
        }),
        fill: rgbaAt(a.colors, e),
      }),
    );
  }
  return out;
}

/** Instanced half-arrows → one filled "map of networks" link shape per instance, via the shared
 *  {@link halfLinkGeometry} reference path. Same `bake` trick as {@link arrowsToDrawables}. */
export function halfArrowsToDrawables(h: InstancedHalfArrowsData, bake = 1): DrawableVector[] {
  const inv = 1 / bake;
  const out: DrawableVector[] = [];
  for (let e = 0; e < h.count; e++) {
    const geom = halfLinkGeometry({
      x0: (h.sources[e * 2] ?? 0) * bake,
      y0: (h.sources[e * 2 + 1] ?? 0) * bake,
      r0: h.radii[e * 2] ?? 0,
      x1: (h.targets[e * 2] ?? 0) * bake,
      y1: (h.targets[e * 2 + 1] ?? 0) * bake,
      r1: h.radii[e * 2 + 1] ?? 0,
      width: h.widths[e * 2] ?? 0,
      oppositeWidth: h.widths[e * 2 + 1] ?? 0,
      bend: h.bends[e] ?? 0,
    });
    if (!geom) continue;
    const g = bake === 1 ? geom : scaleHalfLink(geom, inv);
    out.push(drawable(e, { subpaths: record((ctx) => traceHalfLink(g, ctx)), fill: rgbaAt(h.colors, e) }));
  }
  return out;
}

/**
 * One emit of the instanced lanes → the export-only vector layers a serializer can draw (#200).
 *
 * `k` is the live view scale, needed only to bake the screen-sizeMode shapes whose constant-pixel
 * terms (arrow tip setback, half-arrow taper/bend) are non-linear in the zoom: those bake to world
 * coordinates at `k` and are emitted as `sizeMode: "world"`, exactly as the Canvas/SVG Scene twin
 * does. Circles, pies and lines carry their sizeMode through — the serializers already place a
 * screen-mode circle at a projected centre with a constant radius.
 */
export function instancedVectorLayers(
  layers: readonly InstancedLayer[],
  k: number,
  tolerance = DEFAULT_CURVE_TOLERANCE,
): VectorLayer[] {
  const out: VectorLayer[] = [];
  for (const layer of layers) {
    const screen = layer.sizeMode === "screen";
    const bake = screen ? k || 1 : 1;
    switch (layer.primitive) {
      case "circles":
        out.push({ name: layer.name, sizeMode: layer.sizeMode, drawables: circlesToDrawables(layer.circles) });
        break;
      case "pie":
        out.push({ name: layer.name, sizeMode: layer.sizeMode, drawables: pieToDrawables(layer.pie, screen, tolerance) });
        break;
      case "lines":
        out.push({ name: layer.name, sizeMode: layer.sizeMode, drawables: linesToDrawables(layer.lines) });
        break;
      case "arrows":
        out.push({ name: layer.name, sizeMode: bake !== 1 ? "world" : layer.sizeMode, drawables: arrowsToDrawables(layer.arrows, bake) });
        break;
      case "half-arrows":
        out.push({ name: layer.name, sizeMode: bake !== 1 ? "world" : layer.sizeMode, drawables: halfArrowsToDrawables(layer.halfArrows, bake) });
        break;
    }
  }
  return out;
}
