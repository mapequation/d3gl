/** A label positioned in SCREEN pixels (after the view transform is applied). */
export interface LabelBox {
  id: string | number;
  /** Screen-space anchor (top-left of the label box). */
  x: number;
  y: number;
  /** Box size in pixels; used for collision. Defaults to a small box if omitted. */
  width?: number;
  height?: number;
  /** Higher wins collisions; defaults to 0. */
  priority?: number;
  /** Carried through untouched (e.g. text, datum). */
  [key: string]: unknown;
}

export interface CullOptions {
  viewport: { width: number; height: number };
  /** Anchors within this many pixels outside the viewport are still considered. */
  padding?: number;
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  const aw = a.width ?? 0;
  const ah = a.height ?? 0;
  const bw = b.width ?? 0;
  const bh = b.height ?? 0;
  return a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y;
}

/**
 * Reduce label candidates to a renderable subset: drop anchors outside the
 * viewport (+padding), then greedily place highest-priority first, skipping any
 * that collide with an already-placed box. This keeps the DOM at a few hundred
 * nodes regardless of how many features exist (the "geometry on GPU, only visible
 * labels in DOM" approach).
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

  const placed: LabelBox[] = [];
  for (const cand of ordered) {
    if (!placed.some((p) => overlaps(cand, p))) placed.push(cand);
  }
  return placed;
}
