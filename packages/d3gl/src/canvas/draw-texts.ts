import type { TextData } from "../core/index.js";

/**
 * Paint screen-space text labels (#105 N7b-2) onto a 2D context: per label an optional halo stroked
 * behind the fill for legibility, then the fill, with font/align/opacity from the {@link TextData}.
 * Coords are CSS px; the caller sets the context transform (identity for a CSS-px surface, or a
 * dpr scale for a HiDPI backing store). Shared by the live Canvas render path and the WebGL
 * `toPNG()` export composite (#219) so both rasterize labels identically.
 */
export function paintTexts(ctx: CanvasRenderingContext2D, texts: readonly TextData[]): void {
  if (texts.length === 0) return;
  ctx.textBaseline = "middle";
  for (const td of texts) {
    ctx.font = td.font ?? "12px sans-serif";
    ctx.textAlign = td.align === "middle" ? "center" : td.align === "end" ? "right" : "left";
    ctx.globalAlpha = td.opacity ?? 1;
    if (td.halo) {
      ctx.strokeStyle = td.halo.color;
      ctx.lineWidth = td.halo.width * 2;
      ctx.lineJoin = "round";
      ctx.strokeText(td.text, td.x, td.y);
    }
    ctx.fillStyle = td.color ?? "#000";
    ctx.fillText(td.text, td.x, td.y);
  }
  ctx.globalAlpha = 1;
}
