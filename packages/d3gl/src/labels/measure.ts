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
  const height = Math.ceil(px * 1.25);
  const ctx = context();
  if (!ctx) return { width: Math.ceil(text.length * (px * 0.55)), height }; // no DOM: coarse fallback
  ctx.font = font;
  return { width: Math.ceil(ctx.measureText(text).width), height };
}

/** Strip a `/line-height` token from a CSS font shorthand so it is valid for the canvas `font`
 *  property (which rejects line-height), e.g. `"600 11px/1 system-ui"` → `"600 11px system-ui"`. */
export function canvasFont(font: string): string {
  return font.replace(/(\d+(?:\.\d+)?px)\/\S+/, "$1");
}
