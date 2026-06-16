import type { CSSProperties } from "react";

/**
 * The host `<div>` sizing style that matches the engine's sizing mode, so React's style
 * reconciliation and the engine's resize logic agree:
 *
 * - fixed (both `width` & `height`, no `aspectRatio`): a static pixel box.
 * - width-driven (`aspectRatio` set): fill the available width and keep the ratio (CSS
 *   `aspect-ratio` sizes the height); the engine's ResizeObserver tracks the box.
 * - fill-parent (none set): fill the parent box — the parent must supply a height.
 */
export function hostSizeStyle(width?: number, height?: number, aspectRatio?: number): CSSProperties {
  if (aspectRatio != null) return { width: width ?? "100%", aspectRatio };
  if (width != null && height != null) return { width, height };
  return { width: "100%", height: "100%" };
}

/** True when the size is fixed (both axes pinned, no aspect ratio) — the only mode where a
 *  width/height prop change should drive `engine.setSize()` (responsive modes self-track). */
export function isFixedSize(width?: number, height?: number, aspectRatio?: number): boolean {
  return aspectRatio == null && width != null && height != null;
}
