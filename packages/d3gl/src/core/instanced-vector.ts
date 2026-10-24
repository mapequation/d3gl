import type { DrawableVector } from "./scene.js";
import type {
  InstancedLayer,
  InstancedCirclesData,
  InstancedPieData,
  InstancedLinesData,
  InstancedArrowsData,
  InstancedHalfArrowsData,
  InstancedLoopsData,
  VectorLayer,
} from "./backend.js";
import { PathRecorder } from "./path-recorder.js";
import { headLength, traceArrowOutline } from "./arrowhead.js";
import { DEFAULT_CURVE_TOLERANCE, anchoredCurveTolerance } from "./flatten.js";
import { DEFAULT_MITER_LIMIT } from "./stroke.js";
import { LOOP_LEG, loopPieceLength, loopsSpreadCot, traceLoop, traceLoopArrowOutline, traceLoopHalfArrowOutline } from "./loop-drop.js";
import { bezierControl, halfLinkGeometry, traceHalfLink, scaleHalfLink, chordBend } from "./half-link.js";
import type { Subpath } from "./path-context.js";

/**
 * Vector view of the GPU-instanced lanes, for **export only** (#200).
 *
 * The instanced lanes (network nodes/links/pies, decluttered plot points) are pushed straight to
 * the GPU as SoA typed arrays — they have no retained {@link Scene}, so `toSVG()` on the WebGL
 * backend used to serialize an empty document. These converters turn one emit's SoA back into
 * {@link DrawableVector}s, reusing the *same* curve math the shaders and the Canvas/SVG Scene
 * emitters use ({@link bezierControl}/{@link arrowOutline}/{@link halfLinkGeometry}), so an
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

/** An indexed link draw's (#447) style row for instance `e` — its edge id — and its colour, faded as the
 *  shader fades it; a plain draw's row is `e` itself. */
function styleRow(d: { index?: Float32Array }, e: number): number {
  return d.index ? (d.index[e] ?? 0) : e;
}
function linkColor(d: { index?: Float32Array; fade?: Float32Array; colors: Uint8Array }, e: number): [number, number, number, number] {
  const c = rgbaAt(d.colors, styleRow(d, e));
  const f = d.index && d.fade ? (d.fade[e] ?? 1) : 1;
  return f === 1 ? c : [c[0], c[1], c[2], Math.round(c[3] * f)];
}

/** A drawable with the shared defaults (bevel joins / butt caps — see the compositing-equivalence
 *  notes in LOG.md) filled in, so instanced output strokes like Scene output does. */
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
 *
 * With {@link InstancedCirclesData.bordersPx} the entries are px widths instead (#495), turned into the fraction
 * the shader draws at the export's zoom: `pxPerUnit` is the zoom `k` for a world layer, 1 for a screen one.
 *
 * {@link InstancedCirclesData.offsets} (#509) move each centre by `offset · offsetScale` world units:
 * `offsetScale` is `1 / k` for a screen layer (px offsets at the export's zoom) and 1 for a world one.
 */
export function circlesToDrawables(c: InstancedCirclesData, pxPerUnit = 1, offsetScale = 1): DrawableVector[] {
  const out: DrawableVector[] = [];
  const { centers, radii, borders, borderColors, offsets } = c;
  for (let i = 0; i < c.count; i++) {
    const r = radii[i] ?? 0;
    const raw = borders ? (borders[i] ?? 0) : 0;
    // A px ring (#495) as the shader draws it at this zoom: `pxPerUnit` px per radius unit.
    const b = c.bordersPx ? (r > 0 ? Math.min(1, raw / (r * pxPerUnit)) : 0) : raw;
    const ring = b > 0 && r > 0;
    out.push(
      drawable(i, {
        circles: [{ x: (centers[i * 2] ?? 0) + offsetAt(offsets, i * 2, offsetScale), y: (centers[i * 2 + 1] ?? 0) + offsetAt(offsets, i * 2 + 1, offsetScale), r: ring ? r * (1 - b / 2) : r }],
        fill: rgbaAt(c.colors, i),
        stroke: ring ? rgbaAt(borderColors, i) : NONE,
        lineWidth: ring ? r * b : 0,
      }),
    );
  }
  return out;
}

/** Component `j` of an optional offset column (#509), scaled to the caller's working units; 0 without a column. */
function offsetAt(offsets: Float32Array | undefined, j: number, scale: number): number {
  return offsets ? (offsets[j] ?? 0) * scale : 0;
}

/** Full turn — the wedge fraction → angle convention the pie fragment shader uses (CCW from +x). */
const TAU = Math.PI * 2;

/**
 * One pie wedge's sector between radii `r0 ≤ r1`, angles in radians: `r0 = 0` is the plain sector from the
 * centre, `r0 > 0` the annular sector of its outer band (#507). The one geometry the Canvas/SVG Scene pie
 * (`tracePieWedges`, network/glyphs.ts) and the `toSVG()` export of the instanced pie trace,
 * so the vector band meets the WebGL shader's `r > 1 − border` test on the same circle.
 */
export function tracePieSector(ctx: PathRecorder, cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): void {
  if (r0 > 0) {
    ctx.arc(cx, cy, r1, a0, a1, false);
    ctx.arc(cx, cy, r0, a1, a0, true);
  } else {
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r1, a0, a1, false);
  }
  ctx.closePath();
}

/** A pie wedge's band radius (#507): where its outer band of `fraction` of `radius` starts. The WebGL
 *  shader's `r > 1 − border` boundary, and the vector band's inner edge. */
export function pieBandRadius(radius: number, fraction: number): number {
  return radius * (1 - fraction);
}

/** RGBA `c` with RGB × `factor`, rounded as the GPU quantises a darkened fragment (alpha kept). */
export function darkenRGBA(c: readonly [number, number, number, number], factor: number): [number, number, number, number] {
  return [Math.round(c[0] * factor), Math.round(c[1] * factor), Math.round(c[2] * factor), c[3]];
}

/** Instanced pie wedges → one filled arc sector per wedge. Screen sizeMode pins the sector at a
 *  constant pixel size around its (projected) centre via the drawable anchor, as `tracePieWedges` does
 *  — so a screen wedge is an anchored glyph and bakes at {@link anchoredCurveTolerance}, exactly like
 *  its Canvas/SVG Scene twin (#283); a world wedge is world-scaled and bakes at `tolerance`. A wedge with
 *  an outer band (`borders`, #507) is two drawables: its inner sector, then the band as an annular sector
 *  in its darker colour (id `count + i`), as the shader draws it in one instance. */
export function pieToDrawables(
  p: InstancedPieData,
  screen: boolean,
  tolerance = DEFAULT_CURVE_TOLERANCE,
): DrawableVector[] {
  const out: DrawableVector[] = [];
  const bake = anchoredCurveTolerance(tolerance, screen);
  const darken = p.borderDarken ?? 1;
  for (let i = 0; i < p.count; i++) {
    const cx = p.centers[i * 2] ?? 0;
    const cy = p.centers[i * 2 + 1] ?? 0;
    const r = p.radii[i] ?? 0;
    const a0 = (p.angles[i * 2] ?? 0) * TAU;
    const a1 = (p.angles[i * 2 + 1] ?? 0) * TAU;
    const b = p.borders ? (p.borders[i] ?? 0) : 0;
    const inner = b > 0 ? pieBandRadius(r, Math.min(b, 1)) : r;
    const fill = rgbaAt(p.colors, i);
    const anchor: [number, number] | null = screen ? [cx, cy] : null;
    if (inner > 0) out.push(drawable(i, { subpaths: record((ctx) => tracePieSector(ctx, cx, cy, 0, inner, a0, a1), bake), fill, anchor }));
    if (inner < r) out.push(drawable(p.count + i, { subpaths: record((ctx) => tracePieSector(ctx, cx, cy, inner, r, a0, a1), bake), fill: darkenRGBA(fill, darken), anchor }));
  }
  return out;
}

/** Instanced lines → one stroked path per line (straight, or a quadratic bow for `bends`). World
 *  endpoints with a per-line width, so screen sizeMode needs no bake (the width alone is in px). The end
 *  offsets (#509) move each end by `offset · offsetScale` world units: `1 / k` on a screen layer, 1 on a world one
 *  (the bend is a fraction of the chord, so the bow on the moved ends is the one the shader draws in px). */
export function linesToDrawables(l: InstancedLinesData, offsetScale = 1): DrawableVector[] {
  const out: DrawableVector[] = [];
  const { sourceOffsets: so, targetOffsets: to } = l;
  for (let e = 0; e < l.count; e++) {
    const sx = (l.sources[e * 2] ?? 0) + offsetAt(so, e * 2, offsetScale);
    const sy = (l.sources[e * 2 + 1] ?? 0) + offsetAt(so, e * 2 + 1, offsetScale);
    const tx = (l.targets[e * 2] ?? 0) + offsetAt(to, e * 2, offsetScale);
    const ty = (l.targets[e * 2 + 1] ?? 0) + offsetAt(to, e * 2 + 1, offsetScale);
    const r = styleRow(l, e);
    const bend = l.bends ? (l.bends[r] ?? 0) : 0;
    out.push(
      drawable(e, {
        subpaths: record((ctx) => {
          if (bend) {
            ctx.moveTo(sx, sy);
            const [cx, cy] = bezierControl(sx, sy, tx, ty, bend);
            ctx.quadraticCurveTo(cx, cy, tx, ty);
          } else {
            ctx.moveTo(sx, sy);
            ctx.lineTo(tx, ty);
          }
        }),
        stroke: linkColor(l, e),
        lineWidth: l.widths[r] ?? 0,
      }),
    );
  }
  return out;
}

/**
 * Instanced whole arrows (#542) → one filled outline per arrow: shaft + head as ONE closed polygon
 * ({@link traceArrowOutline}, the GPU strip's twin, each edge ONE cubic), so a translucent arrow blends once. `bake` mirrors the Scene twin's
 * screen-sizeMode trick: solve in pixel space (×k) and emit ÷k, so the world-coordinate output reproduces the
 * constant-pixel GPU render under the view's ×k transform. The end offsets (#509) are in size units, so they add
 * unscaled in the solve space: px at `bake = k` (screen), world units at `bake = 1` (world).
 */
export function arrowsToDrawables(l: InstancedArrowsData, bake = 1): DrawableVector[] {
  const inv = 1 / bake;
  const { sourceOffsets: so, targetOffsets: to } = l;
  const out: DrawableVector[] = [];
  for (let e = 0; e < l.count; e++) {
    const r = styleRow(l, e);
    const p = {
      sx: (l.sources[e * 2] ?? 0) * bake + offsetAt(so, e * 2, 1),
      sy: (l.sources[e * 2 + 1] ?? 0) * bake + offsetAt(so, e * 2 + 1, 1),
      tx: (l.targets[e * 2] ?? 0) * bake + offsetAt(to, e * 2, 1),
      ty: (l.targets[e * 2 + 1] ?? 0) * bake + offsetAt(to, e * 2 + 1, 1),
      radius: l.radii[r] ?? 0,
      width: l.widths[r] ?? 0,
      size: l.arrowSize,
      bend: l.bends ? (l.bends[r] ?? 0) : 0,
    };
    if (p.sx === p.tx && p.sy === p.ty) continue; // zero length: no arrow
    out.push(drawable(e, { subpaths: record((ctx) => traceArrowOutline(ctx, p, inv)), fill: linkColor(l, e) }));
  }
  return out;
}

/**
 * Self-link loops (#505, #542) → one drawable per loop, the loop lane's twin, with its centre solve
 * ({@link loopsSpreadCot}), leg length and piece length `h` ({@link loopPieceLength}) as the shader solves them. A headless loop is ONE
 * stroked path ({@link traceLoop}) whose ends move by `offset / bake` world units, as {@link linesToDrawables}' do (the
 * loop is linear in its ends and `h`, so the loop on the moved ends is the one the shader draws in px). A headed loop
 * is ONE filled outline, {@link traceLoopArrowOutline} or {@link traceLoopHalfArrowOutline}, solved in px (×k) on a screen
 * layer and emitted ÷k, as {@link arrowsToDrawables}.
 */
export function loopsToDrawables(l: InstancedLoopsData, bake = 1): DrawableVector[] {
  const inv = 1 / bake;
  const cot = loopsSpreadCot(l.spread);
  const leg = l.legLength ?? LOOP_LEG;
  const { startOffsets: so, endOffsets: to } = l;
  const out: DrawableVector[] = [];
  for (let e = 0; e < l.count; e++) {
    const width = l.widths[e] ?? 0;
    const color = rgbaAt(l.colors, e);
    if (l.head === "none") {
      const cx = l.centers[e * 2] ?? 0;
      const cy = l.centers[e * 2 + 1] ?? 0;
      const sx = cx + offsetAt(so, e * 2, inv), sy = cy + offsetAt(so, e * 2 + 1, inv);
      const tx = cx + offsetAt(to, e * 2, inv), ty = cy + offsetAt(to, e * 2 + 1, inv);
      const subpaths = record((ctx) => traceLoop(ctx, sx, sy, tx, ty, loopPieceLength(l.arrowSize, width) * inv, leg, cot));
      if (subpaths.length > 0) out.push(drawable(e, { subpaths, stroke: color, lineWidth: width }));
      continue;
    }
    const cx = (l.centers[e * 2] ?? 0) * bake;
    const cy = (l.centers[e * 2 + 1] ?? 0) * bake;
    const sx = cx + offsetAt(so, e * 2, 1), sy = cy + offsetAt(so, e * 2 + 1, 1);
    const tx = cx + offsetAt(to, e * 2, 1), ty = cy + offsetAt(to, e * 2 + 1, 1);
    const half = l.head === "half";
    const subpaths = record((ctx) => (half ? traceLoopHalfArrowOutline(ctx, sx, sy, tx, ty, width, l.arrowSize, leg, cot, inv) : traceLoopArrowOutline(ctx, sx, sy, tx, ty, width, l.arrowSize, leg, cot, inv)));
    if (subpaths.length > 0) out.push(drawable(e, { subpaths, fill: color }));
  }
  return out;
}

/** Instanced half-arrows → one filled "map of networks" link shape per instance, via the shared
 *  {@link halfLinkGeometry} reference path. Same `bake` trick, and end offsets, as {@link arrowsToDrawables}. */
export function halfArrowsToDrawables(h: InstancedHalfArrowsData, bake = 1): DrawableVector[] {
  const inv = 1 / bake;
  const { sourceOffsets: so, targetOffsets: to } = h;
  const out: DrawableVector[] = [];
  for (let e = 0; e < h.count; e++) {
    const x0 = (h.sources[e * 2] ?? 0) * bake + offsetAt(so, e * 2, 1);
    const y0 = (h.sources[e * 2 + 1] ?? 0) * bake + offsetAt(so, e * 2 + 1, 1);
    const x1 = (h.targets[e * 2] ?? 0) * bake + offsetAt(to, e * 2, 1);
    const y1 = (h.targets[e * 2 + 1] ?? 0) * bake + offsetAt(to, e * 2 + 1, 1);
    const r = styleRow(h, e);
    const geom = halfLinkGeometry({
      x0,
      y0,
      r0: h.radii[r * 2] ?? 0,
      x1,
      y1,
      r1: h.radii[r * 2 + 1] ?? 0,
      width: h.widths[r * 2] ?? 0,
      oppositeWidth: h.widths[r * 2 + 1] ?? 0,
      bend: chordBend(x0, y0, x1, y1, h.bends[r] ?? 0),
    });
    if (!geom) continue;
    const g = bake === 1 ? geom : scaleHalfLink(geom, inv);
    out.push(drawable(e, { subpaths: record((ctx) => traceHalfLink(g, ctx)), fill: linkColor(h, e) }));
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
        out.push({ name: layer.name, sizeMode: layer.sizeMode, drawables: circlesToDrawables(layer.circles, screen ? 1 : k || 1, 1 / bake) });
        break;
      case "pie":
        out.push({ name: layer.name, sizeMode: layer.sizeMode, drawables: pieToDrawables(layer.pie, screen, tolerance) });
        break;
      case "lines":
        out.push({ name: layer.name, sizeMode: layer.sizeMode, drawables: linesToDrawables(layer.lines, 1 / bake) });
        break;
      case "arrows":
        out.push({ name: layer.name, sizeMode: bake !== 1 ? "world" : layer.sizeMode, drawables: arrowsToDrawables(layer.arrows, bake) });
        break;
      case "half-arrows":
        out.push({ name: layer.name, sizeMode: bake !== 1 ? "world" : layer.sizeMode, drawables: halfArrowsToDrawables(layer.halfArrows, bake) });
        break;
      case "loops":
        // A headless loop is stroked like a line (its layer's sizeMode); a headed one is a filled outline, baked.
        out.push({ name: layer.name, sizeMode: layer.loops.head === "none" || bake === 1 ? layer.sizeMode : "world", drawables: loopsToDrawables(layer.loops, bake) });
        break;
    }
  }
  return out;
}
