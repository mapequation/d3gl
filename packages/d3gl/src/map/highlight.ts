import type { GroupBuilder, PathContext, DrawableVector } from "../core/index.js";
import type { StyleOverride } from "./style-overrides.js";

/** Layer-name suffix reserved for internal highlight overlay groups. */
export const HIGHLIGHT_SUFFIX = ":highlight";

/** Style for highlight-overlay geometry. Unlike bulk StyleOverrides,
 *  `lineWidth` IS allowed: only one item is re-tessellated per hover change. */
export interface HighlightStyle {
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  /** Circle drawables only: multiply the point radius (default 1). */
  radiusScale?: number;
}

export type HighlightDraw<F = unknown> = (datum: F, g: HighlightBuilder) => void;
/** The hovered-item style payload: `true` = default style, a style = replay with it,
 *  a function = full custom draw of the hovered item. */
export type HoverOption<F = unknown> = true | HighlightStyle | HighlightDraw<F>;

/**
 * Hover styling (#162), symmetric with {@link SelectionOptions}: `hovered` = how the hovered item looks
 * (a {@link HighlightStyle} redraw / custom draw fn on Scene layers; on instanced lanes the ring uses its
 * `stroke`), `others` = fade the non-hovered glyphs — the hover analogue of `selection.others`, opt-in.
 * The layer `hover` option accepts either this object OR a bare {@link HoverOption} (the flat forms:
 * `true` / a style / a draw fn) for the common "just style the hovered item" case.
 */
export interface HoverOptions<F = unknown> {
  hovered?: HighlightStyle | HighlightDraw<F>;
  others?: StyleOverride;
}

/** Split a layer's `hover` option into its hovered-style payload (for the overlay / ring) and its
 *  `others` dim. A flat {@link HoverOption} (`true` / style / fn) is the hovered style with no dim;
 *  a {@link HoverOptions} object (has `hovered`/`others` keys) is read directly. */
export function hoverParts<F = unknown>(
  hover: HoverOption<F> | HoverOptions<F> | undefined,
): { hovered: HoverOption<F> | undefined; others: StyleOverride | undefined } {
  if (hover === true) return { hovered: true, others: undefined };
  if (typeof hover === "function") return { hovered: hover, others: undefined };
  if (hover && typeof hover === "object") {
    if ("hovered" in hover || "others" in hover) return { hovered: hover.hovered, others: hover.others };
    // No `hovered`/`others` key ⇒ a flat HighlightStyle (back-compat). (HoverOptions' fields are optional,
    // so structural typing can't narrow it out here; the key check above is the runtime discriminator.)
    return { hovered: hover as HighlightStyle, others: undefined };
  }
  return { hovered: undefined, others: undefined };
}

/** A color write deferred until the overlay group build commits (Scene.setFill
 *  rejects a group that is still being built). */
export interface PendingColor { id: string; fill?: string; stroke?: string }

/** Convert stored RGBA bytes (0–255 each) to a CSS rgba() string. */
const css = (c: readonly [number, number, number, number]): string =>
  `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;

/** Walk a source drawable's already-flattened subpaths into the overlay PathContext.
 *  No reprojection — geometry is already in world coords from the scene build. */
function replaySubpaths(ctx: PathContext, d: DrawableVector): void {
  for (const s of d.subpaths) {
    const p = s.points;
    if (p.length < 2) continue;
    ctx.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
    if (s.closed) ctx.closePath();
  }
}

/**
 * Builder handed to custom hover/highlight draw fns, scoped to ONE source drawable.
 * Everything recorded lands in the overlay group (drawn on top, inheriting the source
 * layer's clipTo/sizeMode). World coordinates throughout. Geometry comes from the
 * Scene's already-projected subpaths/circles — no re-projection, no datum re-processing.
 */
export class HighlightBuilder {
  /** The drawable's glyph anchor, or a point feature's projected center; null for plain paths. */
  readonly anchor: [number, number] | null;
  // Counter to make sub-ids unique within one source drawable (multiple replay/path/point
  // calls are valid, e.g. defaultHighlight calls both path() and nothing else — keep counting).
  private n = 0;
  constructor(
    private readonly g: GroupBuilder,
    private readonly d: DrawableVector,
    private readonly colors: PendingColor[],
  ) {
    // Prefer the explicit glyph anchor; fall back to the first circle center (point drawables).
    this.anchor = this.d.anchor ?? (this.d.circles[0] ? [this.d.circles[0].x, this.d.circles[0].y] : null);
  }
  /** Overlay ids: source id + space + tag + counter — collision-proof against sibling ids. */
  private nextId(tag: string): string { return `${String(this.d.id)} ${tag}${this.n++}`; }

  /** Re-emit the source drawable's geometry with new styling. Omitted fill/stroke keep
   *  the source's current colors (note: a translucent base fill re-drawn on top of
   *  itself compounds — pass an explicit fill to avoid that). */
  replay(style: HighlightStyle = {}): void {
    const d = this.d;
    const id = this.nextId("r");
    if (d.circles.length > 0) {
      // Circle drawable: emit a new points batch, optionally scaled.
      const scale = style.radiusScale ?? 1;
      this.g.points(id, d.circles.map((c) => [c.x, c.y] as [number, number]), (d.circles[0]?.r ?? 0) * scale);
      this.colors.push({ id, fill: style.fill ?? css(d.fill) });
      return;
    }
    // Path drawable: re-emit flattened subpaths preserving stroke/join/cap metadata so
    // the overlay tessellates the same expansion (useful for exact-outline highlights).
    this.g.drawable(id, (ctx) => replaySubpaths(ctx, d), {
      lineWidth: style.lineWidth ?? d.lineWidth,
      lineJoin: d.lineJoin,
      miterLimit: d.miterLimit,
      lineCap: d.lineCap,
      anchor: d.anchor ?? undefined,
    });
    this.colors.push({
      id,
      fill: style.fill ?? css(d.fill),
      stroke: style.stroke ?? css(d.stroke),
    });
  }

  /** Record an arbitrary path (standard PathContext: moveTo/lineTo/arc/rect/…).
   *  Note: a stroke is only visible when `style.lineWidth > 0` (backends suppress zero-width strokes). */
  path(draw: (ctx: PathContext) => void, style: HighlightStyle = {}): void {
    const id = this.nextId("p");
    this.g.drawable(id, draw, { lineWidth: style.lineWidth ?? 0 });
    this.colors.push({ id, fill: style.fill, stroke: style.stroke });
  }

  /** A filled circle at world (x, y). */
  point(x: number, y: number, radius: number, style: { fill?: string } = {}): void {
    const id = this.nextId("c");
    this.g.point(id, x, y, radius);
    this.colors.push({ id, fill: style.fill ?? "#fff" });
  }

  /** The `hover: true` default: a white outline for paths (fill stays transparent so
   *  translucent bases don't compound); a stroked ring just outside circle drawables
   *  (circles themselves are fill-only so a ring is drawn separately). */
  defaultHighlight(): void {
    const d = this.d;
    if (d.circles.length > 0) {
      // One ring per circle, 30% larger radius, white stroke, no fill.
      for (const c of d.circles)
        this.path(
          (ctx) => { ctx.arc(c.x, c.y, c.r * 1.3, 0, 2 * Math.PI); ctx.closePath(); },
          { stroke: "#fff", lineWidth: 1.5 },
        );
      return;
    }
    // Path drawable: replay geometry with transparent fill + white stroke.
    this.replay({ fill: "rgba(0,0,0,0)", stroke: "#fff", lineWidth: 1.5 });
  }
}

/** Normalize a HoverOption (or nothing) to a draw fn. */
export function resolveHighlight(opt: HoverOption | undefined): HighlightDraw {
  if (typeof opt === "function") return opt;
  if (opt !== undefined && opt !== true) return (_d, g) => g.replay(opt);
  return (_d, g) => g.defaultHighlight();
}
