/**
 * Half-arrow link geometry (#104 N6) — the "map of networks" directed-link glyph.
 *
 * A directed link is drawn as a single filled shape: it pinches to the **source node centre**,
 * runs as a tapered strip that bows around a **shared centre curve**, and ends in a barbed
 * **arrowhead whose tip lands on the target node's boundary**. A reciprocal A→B / B→A pair shares
 * that centre curve and fills opposite sides of it, so the two arrows nest instead of overlapping.
 *
 * This is a clean-room port of the math in mapequation's `network-rendering` (`halfLink()`), used
 * as the **single source of truth**: the SVG/Canvas export path traces these points as real
 * quadratic curves (so vector output matches publication tooling exactly), the WebGL lane mirrors
 * the same formulas in its instanced vertex shader, and {@link halfLinkPathString} is golden-tested
 * against that reference's `example.svg`.
 *
 * The {@link HalfLinkParams.bend} is an **absolute perpendicular offset in world units** (as in the
 * reference), not a fraction of the chord; the side it bows to is derived from the link direction so
 * reciprocal links are consistent without the caller tracking which is which.
 */

/** Inputs for one directed half-arrow link (world coordinates/units). */
export interface HalfLinkParams {
  /** Source node centre + radius. */
  x0: number;
  y0: number;
  r0: number;
  /** Target node centre + radius. */
  x1: number;
  y1: number;
  r1: number;
  /** This link's width (drives the strip width and arrowhead size). */
  width: number;
  /**
   * The reciprocal link's width, if any — its arrowhead lands at *this* link's source end, so we
   * leave room for it there. Defaults to `width` (symmetric) when there's no opposite link.
   */
  oppositeWidth?: number;
  /** Bend: absolute perpendicular offset of the centre curve, in world units (the reference's `bend`). */
  bend: number;
}

/** The resolved anchor + control points of a half-arrow link (the vertices its outline visits). */
export interface HalfLinkGeometry {
  /** Source centre — the strip pinches to a point here. */
  x0: number;
  y0: number;
  /** Inner strip start at the source (boundary + opposite-arrow clearance, toward the inner control). */
  x02: number;
  y02: number;
  /** Source-centre + width (the source-side foot of the strip). */
  x04: number;
  y04: number;
  /** Outer strip start at the source. */
  x03: number;
  y03: number;
  /** Inner / outer quadratic control points (the inner = the shared centre curve). */
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  /** Outer strip end, meeting the arrowhead. */
  x13: number;
  y13: number;
  /** Arrowhead barb (the wide outer corner). */
  x14: number;
  y14: number;
  /** Arrow tip — on the target node's boundary. */
  x11: number;
  y11: number;
  /** Inner arrowhead base. */
  x12: number;
  y12: number;
}

/** A minimal 2-D path sink (matches the subset of `CanvasRenderingContext2D` / d3gl's PathContext we use). */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  closePath(): void;
}

/**
 * Resolve the half-arrow link's outline vertices, or `null` when the link should be skipped (the
 * nodes overlap and the bend is too small to route around them — matches the reference's guard).
 */
export function halfLinkGeometry(p: HalfLinkParams): HalfLinkGeometry | null {
  const { x0, y0, r0, x1, y1, r1, width } = p;
  const oppositeWidth = p.oppositeWidth ?? width;
  const bend = p.bend;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const l = Math.sqrt(dx * dx + dy * dy);
  const lBetween = l - r0 - r1;
  // Skip drawing when the nodes overlap, unless the bend is large enough to route around them.
  if (lBetween <= 0 && Math.abs(bend) < 50) return null;

  // Unit direction source→target, and its perpendicular ("right" in screen/y-down space).
  const dirx = dx / l;
  const diry = dy / l;
  const rightx = -diry;
  const righty = dirx;

  // Arrowhead sizes: tip length tapers with width (capped to a third of the gap); the barb adds
  // `tipWidth` beyond the strip width. The opposite link's tip length spaces our source foot.
  // (Use the reference's exact `Math.pow(x, 1/3)` / `Math.pow(x, 1/2)` — not cbrt/sqrt — so the
  // golden test matches `example.svg` to the last bit.)
  const tipLength = Math.min(lBetween / 3, 10 * Math.pow(width, 1 / 3));
  const tipWidth = 2 * Math.pow(width, 1 / 2);
  const oppositeTipLength = Math.min(lBetween / 3, 10 * Math.pow(oppositeWidth, 1 / 3));

  // Bend: the side is fixed by the link direction (so a reciprocal pair bows consistently to one
  // world side and the two halves nest), times the sign of `bend`.
  const bendMagnitude = Math.abs(bend);
  const outerBendAddition = Math.pow(bendMagnitude / 10, 0.4);
  const positiveCurvature = dirx > 0 || (dirx === 0 && diry < 0);
  const curvatureSign = positiveCurvature ? 1 : -1;
  const bendSign = bend > 0 ? 1 : -1;
  const signedBend = curvatureSign * bendSign * bendMagnitude;

  // Endpoints of the centre curve (boundary + arrow clearance at each end), then the two controls:
  // cp1 is the shared centre curve, cp2 the outer edge (offset by the strip width + a little).
  const x02tmp = x0 + (r0 + oppositeTipLength) * dirx;
  const y02tmp = y0 + (r0 + oppositeTipLength) * diry;
  const x12tmp = x1 - (r1 + tipLength) * dirx;
  const y12tmp = y1 - (r1 + tipLength) * diry;
  const xMid = 0.5 * (x02tmp + x12tmp);
  const yMid = 0.5 * (y02tmp + y12tmp);
  const cp1x = xMid + signedBend * rightx;
  const cp1y = yMid + signedBend * righty;
  const cp2x = xMid + (signedBend + width + outerBendAddition) * rightx;
  const cp2y = yMid + (signedBend + width + outerBendAddition) * righty;

  // Source-side foot: aim from the source centre toward the inner control, plant the inner strip
  // start on the boundary (+ opposite clearance) and the outer start a strip-width across.
  const dx1 = cp1x - x0;
  const dy1 = cp1y - y0;
  const l1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
  const dir0x = dx1 / l1;
  const dir0y = dy1 / l1;
  const right0x = -dir0y;
  const right0y = dir0x;
  const x01 = x0 + r0 * dir0x;
  const y01 = y0 + r0 * dir0y;
  const x02 = x01 + oppositeTipLength * dir0x;
  const y02 = y01 + oppositeTipLength * dir0y;
  const x03 = x02 + width * right0x;
  const y03 = y02 + width * right0y;
  const x04 = x0 + width * right0x;
  const y04 = y0 + width * right0y;

  // Target-side arrowhead: aim from the target centre toward the inner control; tip sits on the
  // boundary, the base steps back by tipLength, and the barb juts out by the strip width + tipWidth.
  const dx2 = cp1x - x1;
  const dy2 = cp1y - y1;
  const l2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
  const dir1x = dx2 / l2;
  const dir1y = dy2 / l2;
  const x11 = x1 + r1 * dir1x;
  const y11 = y1 + r1 * dir1y;
  const x12 = x11 + tipLength * dir1x;
  const y12 = y11 + tipLength * dir1y;
  const left1x = dir1y;
  const left1y = -dir1x;
  const x13 = x12 + width * left1x;
  const y13 = y12 + width * left1y;
  const x14 = x13 + tipWidth * left1x;
  const y14 = y13 + tipWidth * left1y;

  return { x0, y0, x02, y02, x04, y04, x03, y03, cp1x, cp1y, cp2x, cp2y, x13, y13, x14, y14, x11, y11, x12, y12 };
}

/**
 * Trace a resolved half-arrow link onto a {@link PathSink} (Canvas/SVG export), as the reference does:
 * inner-start → source centre → foot → outer edge (quadratic via `cp2`) → barb → tip → inner base →
 * inner edge (quadratic via `cp1`) → close.
 */
export function traceHalfLink(g: HalfLinkGeometry, ctx: PathSink): void {
  ctx.moveTo(g.x02, g.y02);
  ctx.lineTo(g.x0, g.y0);
  ctx.lineTo(g.x04, g.y04);
  ctx.lineTo(g.x03, g.y03);
  ctx.quadraticCurveTo(g.cp2x, g.cp2y, g.x13, g.y13);
  ctx.lineTo(g.x14, g.y14);
  ctx.lineTo(g.x11, g.y11);
  ctx.lineTo(g.x12, g.y12);
  ctx.quadraticCurveTo(g.cp1x, g.cp1y, g.x02, g.y02);
  ctx.closePath();
}

/**
 * The reference SVG path string for a half-arrow link (or `""` when skipped) — same command sequence
 * and number formatting as mapequation's `network-rendering`, so it is golden-tested against its
 * `example.svg`.
 */
export function halfLinkPathString(p: HalfLinkParams): string {
  const g = halfLinkGeometry(p);
  if (!g) return "";
  return [
    `M ${g.x02} ${g.y02}`,
    `L ${g.x0} ${g.y0}`,
    `L ${g.x04} ${g.y04}`,
    `L ${g.x03} ${g.y03}`,
    `Q ${g.cp2x} ${g.cp2y}, ${g.x13} ${g.y13}`,
    `L ${g.x14} ${g.y14}`,
    `L ${g.x11} ${g.y11}`,
    `L ${g.x12} ${g.y12}`,
    `Q ${g.cp1x} ${g.cp1y}, ${g.x02} ${g.y02}`,
    `Z`,
  ].join(" ");
}
