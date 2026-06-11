import { rgb } from "d3-color";

/** Bulk per-drawable style override, composed over the base colors the layer's
 *  fill/stroke accessors produce. Colors only — stroke geometry has its width baked
 *  in at tessellation time, so a bulk width change would be O(n) re-tessellation
 *  (widths are available in the single-item highlight overlay instead). */
export interface StyleOverride {
  /** Replaces the base fill (any CSS color). */
  fill?: string;
  /** Replaces the base stroke. */
  stroke?: string;
  /** Multiplies the base alpha (0..1) — dimming keeps each drawable's own hue. */
  opacity?: number;
}

/** Styles for select(): the selected set and its complement.
 *  Defaults: `selected` keeps the base style (items stand out because the others
 *  dim); `others` is `{ opacity: 0.3 }`. */
export interface SelectionOption {
  selected?: StyleOverride;
  others?: StyleOverride;
}

/**
 * Compose one channel: the override color (if any) replaces the base, then `opacity`
 * multiplies the result's alpha. Returns the CSS color to write, or null when there
 * is nothing to paint (no base and no override color — opacity alone can't conjure
 * a color). The no-opacity path returns the source string untouched (no parse cost).
 */
export function composeColor(
  base: string | undefined,
  overrideColor: string | undefined,
  opacity: number | undefined,
): string | null {
  const src = overrideColor ?? base;
  if (src === undefined) return null;
  if (opacity === undefined) return src;
  const c = rgb(src);
  if (Number.isNaN(c.r)) throw new Error(`invalid color: ${src}`);
  const a = Number.isNaN(c.opacity) ? 1 : c.opacity;
  c.opacity = Math.max(0, Math.min(1, a * opacity));
  return c.toString();
}
