/** Where the anchor point sits along the label's own text axis — like SVG `text-anchor`. */
export type TextAnchor = "start" | "middle" | "end";

/** A label positioned in SCREEN pixels (after the view transform is applied). */
export interface LabelBox {
  id: string | number;
  /** Screen-space anchor. For a plain label this is the box's top-left; for an oriented
   *  label (see `rotation`) it is the rotation/transform origin the text radiates from. */
  x: number;
  y: number;
  /** Box size in pixels; used for collision. Defaults to a small box if omitted. */
  width?: number;
  height?: number;
  /** Higher wins collisions; defaults to 0. */
  priority?: number;
  /**
   * Reading-direction angle in radians (CSS-clockwise, i.e. `rotate(rotation·180/π deg)`).
   * Setting it switches the label to the ORIENTED model: text runs along the rotated axis,
   * vertically centred on the anchor, and both the collision box and the rendered CSS
   * transform are derived from it — so the two can never disagree. Leave undefined for a
   * plain axis-aligned, top-left box (the caller then owns any CSS transform).
   */
  rotation?: number;
  /** Oriented labels only: which way the text runs from the anchor. Defaults to "start". */
  textAnchor?: TextAnchor;
  /** Oriented labels only: flip 180° (and the text side) when the rotation would render
   *  the text upside down — the standard radial-tree readability flip. */
  keepUpright?: boolean;
  /** Carried through untouched (e.g. text, datum). */
  [key: string]: unknown;
}

export interface CullOptions {
  viewport: { width: number; height: number };
  /** Anchors within this many pixels outside the viewport are still considered. */
  padding?: number;
}

type Point = [number, number];

/** The realised screen geometry of a label: its four corners, their AABB, whether it is
 *  axis-aligned (fast-path collision), and the CSS transform that reproduces the box. */
export interface LabelGeometry {
  corners: Point[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  axisAligned: boolean;
  /** CSS transform reproducing the box (oriented labels only; "" for plain labels). */
  transform: string;
}

/**
 * Resolve a {@link LabelBox} to its on-screen geometry. Plain labels (no `rotation`) keep the
 * historical top-left box and own their CSS transform. Oriented labels (`rotation` set) place
 * the text along the rotated axis, vertically centred on the anchor, with `text-anchor` and the
 * optional upright flip folded in — and emit the matching CSS transform. The collision corners
 * and the transform come from the same computation, so render and culling stay consistent.
 */
export function labelGeometry(box: LabelBox): LabelGeometry {
  const w = box.width ?? 0;
  const h = box.height ?? 0;
  const { x, y } = box;

  if (box.rotation === undefined) {
    return {
      corners: [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      minX: x,
      minY: y,
      maxX: x + w,
      maxY: y + h,
      axisAligned: true,
      transform: "",
    };
  }

  // Upright flip: when the reading direction points left (cos < 0) the text would be upside
  // down, so add π and swap the text side so it still radiates outward.
  const flip = box.keepUpright === true && Math.cos(box.rotation) < 0;
  const rot = flip ? box.rotation + Math.PI : box.rotation;
  let anchor: TextAnchor = box.textAnchor ?? "start";
  if (flip) anchor = anchor === "start" ? "end" : anchor === "end" ? "start" : "middle";

  // Local box (origin at the anchor, transform-origin 0 0): text along +x per `anchor`,
  // vertically centred.
  const [lx0, lx1] = anchor === "start" ? [0, w] : anchor === "end" ? [-w, 0] : [-w / 2, w / 2];
  const ly0 = -h / 2;
  const ly1 = h / 2;

  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const toScreen = (lx: number, ly: number): Point => [
    x + lx * cos - ly * sin,
    y + lx * sin + ly * cos,
  ];
  const corners: Point[] = [
    toScreen(lx0, ly0),
    toScreen(lx1, ly0),
    toScreen(lx1, ly1),
    toScreen(lx0, ly1),
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [cx, cy] of corners) {
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
  }

  const deg = (rot * 180) / Math.PI;
  const txPct = anchor === "start" ? 0 : anchor === "end" ? -100 : -50;
  const transform = `rotate(${deg}deg) translate(${txPct}%, -50%)`;

  return { corners, minX, minY, maxX, maxY, axisAligned: false, transform };
}

/** Separating-axis test for two convex quads. Touching edges count as non-overlapping. */
function satOverlap(a: Point[], b: Point[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      if (!p1 || !p2) continue;
      const [x1, y1] = p1;
      const [x2, y2] = p2;
      const nx = -(y2 - y1);
      const ny = x2 - x1;
      let aMin = Infinity;
      let aMax = -Infinity;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (const [px, py] of a) {
        const d = px * nx + py * ny;
        if (d < aMin) aMin = d;
        if (d > aMax) aMax = d;
      }
      for (const [px, py] of b) {
        const d = px * nx + py * ny;
        if (d < bMin) bMin = d;
        if (d > bMax) bMax = d;
      }
      if (aMax <= bMin || bMax <= aMin) return false;
    }
  }
  return true;
}

function overlaps(a: LabelGeometry, b: LabelGeometry): boolean {
  // AABB reject (also the exact test when both boxes are axis-aligned).
  if (a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY) return false;
  if (a.axisAligned && b.axisAligned) return true;
  return satOverlap(a.corners, b.corners);
}

/**
 * Reduce label candidates to a renderable subset: drop anchors outside the
 * viewport (+padding), then greedily place highest-priority first, skipping any
 * that collide with an already-placed box. Collision uses each label's true
 * oriented footprint (see {@link labelGeometry}), so rotated labels pack by the
 * space they actually occupy on screen rather than their un-rotated dimensions.
 * This keeps the DOM at a few hundred nodes regardless of how many features exist
 * (the "geometry on GPU, only visible labels in DOM" approach).
 */
export function cullLabels(candidates: readonly LabelBox[], options: CullOptions): LabelBox[] {
  const pad = options.padding ?? 0;
  const { width, height } = options.viewport;
  const inView = candidates.filter(
    (c) => c.x >= -pad && c.x <= width + pad && c.y >= -pad && c.y <= height + pad,
  );
  // Stable sort by priority desc (preserve input order on ties).
  const ordered = inView
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.priority ?? 0) - (a.c.priority ?? 0) || a.i - b.i)
    .map((e) => e.c);

  const placed: LabelGeometry[] = [];
  const result: LabelBox[] = [];
  for (const cand of ordered) {
    const geom = labelGeometry(cand);
    if (!placed.some((p) => overlaps(geom, p))) {
      placed.push(geom);
      result.push(cand);
    }
  }
  return result;
}
