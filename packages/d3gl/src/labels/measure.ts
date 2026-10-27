/**
 * Real text measurement for label collision boxes (#223). Replaces the copy-pasted
 * `name.length * 6.2 + N, height: 14` estimates the website examples used to hand-wire: the
 * engine measures each label's text ONCE at candidate registration (never per frame) and retains
 * the box on the anchor, so per-transform placement/culling reflects the label's true footprint.
 *
 * Uses a single lazily-created, module-shared 2D canvas context (measurement only — no pixels are
 * drawn, so one context is reused for every measurement). The width comes from `measureText`; the
 * height is derived from the font's pixel size (a stable per-font line box, not the per-glyph tight
 * bounds — collision wants a consistent row height). In a non-DOM environment (Node unit tests) it
 * falls back to a coarse estimate so pure placement logic stays testable without a canvas.
 */

let sharedCtx: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (sharedCtx === undefined) {
    sharedCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  }
  return sharedCtx;
}

/** Parse the pixel size out of a CSS font shorthand (e.g. `"600 11px system-ui"` → 11). Default 12. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? parseFloat(m[1]!) : 12;
}

/**
 * Measure a label's screen box (CSS px) for collision. `font` is a **canvas** font shorthand
 * (no `/line-height` — strip it first). Width is measured; height is the font size × 1.25 (a
 * consistent row box; 11px → 14, matching the estimates this replaces).
 */
export function measureText(text: string, font: string): { width: number; height: number } {
  const px = fontPx(font);
  const height = fontRowHeight(font);
  const ctx = context();
  if (!ctx) return { width: Math.ceil(text.length * (px * 0.55)), height }; // no DOM: coarse fallback
  ctx.font = font;
  return { width: Math.ceil(ctx.measureText(text).width), height };
}

/** The label row-box height for a font (px size × 1.25, e.g. 11px → 14) — derived from the font
 *  string alone, so getting it never costs a `measureText` call. */
export function fontRowHeight(font: string): number {
  return Math.ceil(fontPx(font) * 1.25);
}

/** Strip a `/line-height` token from a CSS font shorthand so it is valid for the canvas `font`
 *  property (which rejects line-height), e.g. `"600 11px/1 system-ui"` → `"600 11px system-ui"`, with
 *  or without spaces around the slash (browsers serialize it as `"11px / 1"`). */
export function canvasFont(font: string): string {
  return font.replace(/(\d+(?:\.\d+)?px)\s*\/\s*[^\s,]+/, "$1");
}

/** The trim marker (#496): U+2026 HORIZONTAL ELLIPSIS, one glyph. */
export const ELLIPSIS = "\u2026";

/**
 * Trim `text` to at most `maxWidth` px with a trailing {@link ELLIPSIS} (#496). `widthOf` measures a
 * string's px width. A text that already fits comes back as the same string. Otherwise it is the
 * longest prefix that fits together with the ellipsis (binary search: O(log length) measurements),
 * cut on a whole character (never between the halves of a surrogate pair) and without whitespace
 * before the ellipsis. When not even one character fits it is the ellipsis alone.
 */
export function trimToWidth(text: string, maxWidth: number, widthOf: (s: string) => number): string {
  if (widthOf(text) <= maxWidth) return text;
  let lo = 0, hi = text.length - 1; // longest prefix length n in [0, len-1] with width(prefix + …) <= maxWidth
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (widthOf(text.slice(0, mid) + ELLIPSIS) <= maxWidth) lo = mid; else hi = mid - 1;
  }
  let n = lo;
  const last = text.charCodeAt(n - 1);
  if (n > 0 && last >= 0xd800 && last <= 0xdbff) n--; // do not split a surrogate pair
  return text.slice(0, n).trimEnd() + ELLIPSIS;
}

/**
 * Hard cap on distinct cached label texts — see {@link TextMeasurer}. Deliberately far above any set
 * that can be *visible* at once (a viewport holds ~2000 label boxes): the cap exists only so a pan
 * across a graph with millions of distinct names cannot retain unboundedly, never to evict the
 * working set. Sizing it near the visible set would be the worst of both worlds — the cache would
 * thrash and every frame would re-measure.
 */
const MEASURE_CACHE_LIMIT = 1_000_000;

/**
 * Text measurement for label sets whose *text* is derived per frame rather than registered once
 * (#204): the network builds its label candidates from the current LOD frontier / viewport, so a
 * width has to be available for every candidate on every placement pass. Measuring there directly
 * would put a `measureText` on the per-frame path; this memoizes by text so each distinct string is
 * measured exactly ONCE and every later frame is a Map lookup.
 *
 * The height is a per-font constant (the row box), so only widths are cached, and the key is the text
 * itself — so a changed `labelOf` or a rebuilt LOD tree invalidates itself, with no id-remap hook to
 * forget. Memory is O(distinct texts shown): a Map slot + a number (~60 B) each, while the string is
 * normally already retained by the caller's data. {@link MEASURE_CACHE_LIMIT} caps that, clearing
 * wholesale on overflow. One measurer per font — rebuild it when the font changes.
 */
export class TextMeasurer {
  /** The row-box height for this font, in px (constant — text width is what varies). */
  readonly height: number;
  private readonly widths = new Map<string, number>();
  /** Trimmed texts (#496), valid for {@link trimmedFor}; cleared when the max width changes or on overflow. */
  private readonly trimmed = new Map<string, string>();
  private trimmedFor = NaN;

  constructor(
    private readonly font: string,
    private readonly limit: number = MEASURE_CACHE_LIMIT,
  ) {
    this.height = fontRowHeight(font); // from the font string — no measurement at all
  }

  /** The label box width for `text`, measured once and cached. */
  width(text: string): number {
    const hit = this.widths.get(text);
    if (hit !== undefined) return hit;
    const w = measureText(text, this.font).width;
    if (this.widths.size >= this.limit) this.widths.clear();
    this.widths.set(text, w);
    return w;
  }

  /**
   * `text` trimmed to `maxWidth` px with an ellipsis (#496), memoized like {@link width}: each distinct
   * text is trimmed once (O(log length) measurements), every later frame is a Map lookup. A text that
   * fits is returned as is. Changing `maxWidth` drops the memo. The prefix probes are measured directly,
   * not cached in {@link width}'s map, so they cannot evict the working set.
   */
  trim(text: string, maxWidth: number): string {
    if (maxWidth !== this.trimmedFor) { this.trimmed.clear(); this.trimmedFor = maxWidth; }
    const hit = this.trimmed.get(text);
    if (hit !== undefined) return hit;
    // The text's own width is the cached one (a label that fits is measured once, for both its box and
    // this check); only the prefix probes of a cut text are measured directly.
    const full = this.width(text);
    const out = full <= maxWidth ? text : trimToWidth(text, maxWidth, (s) => (s === text ? full : measureText(s, this.font).width));
    if (this.trimmed.size >= this.limit) this.trimmed.clear();
    this.trimmed.set(text, out);
    return out;
  }
}
