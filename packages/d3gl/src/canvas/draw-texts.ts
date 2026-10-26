import type { TextData } from "../core/index.js";

/**
 * Paint screen-space text labels (#105 N7b-2) onto a 2D context: per label an optional halo stroked
 * behind the fill for legibility, then the fill, with font/align/opacity/rotation from the {@link TextData}.
 * Coords are CSS px; the caller sets the context transform (identity for a CSS-px surface, or a
 * dpr scale for a HiDPI backing store). Shared by the live Canvas render path and the WebGL
 * `toPNG()` export composite (#219) so both rasterize labels identically.
 */
export function paintTexts(ctx: CanvasRenderingContext2D, texts: readonly TextData[]): void {
  if (texts.length === 0) return;
  ctx.textBaseline = "middle";
  // The caller's transform, restored after each rotated label; read only when one is rotated.
  let base: DOMMatrix | null = null;
  for (const td of texts) {
    ctx.font = td.font ?? "12px sans-serif";
    ctx.textAlign = td.align === "middle" ? "center" : td.align === "end" ? "right" : "left";
    ctx.globalAlpha = td.opacity ?? 1;
    // A rotated label (#580) is drawn at the origin of a frame turned about its anchor.
    let x = td.x, y = td.y;
    if (td.rotation) {
      base ??= ctx.getTransform();
      ctx.translate(x, y);
      ctx.rotate(td.rotation);
      x = 0;
      y = 0;
    }
    // Width 0 means no halo: Canvas ignores `lineWidth = 0`, so stroking would reuse the previous width.
    if (td.halo && td.halo.width > 0) {
      ctx.strokeStyle = td.halo.color;
      ctx.lineWidth = td.halo.width * 2;
      ctx.lineJoin = "round";
      ctx.strokeText(td.text, x, y);
    }
    ctx.fillStyle = td.color ?? "#000";
    ctx.fillText(td.text, x, y);
    if (td.rotation && base) ctx.setTransform(base);
  }
  ctx.globalAlpha = 1;
}
