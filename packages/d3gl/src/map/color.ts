import { rgb } from "d3-color";

/** Clamp to a 0–255 byte (CSS clamps out-of-range channels; Uint8Array would wrap). */
function toByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Parse a CSS color string into RGBA bytes [r, g, b, a].
 * Throws `invalid color: <color>` if the string is not recognized by d3-color.
 * Matches the fail-fast convention used in scene.ts's writeColor.
 */
export function packColor(color: string): [number, number, number, number] {
  const c = rgb(color);
  if (Number.isNaN(c.r)) throw new Error(`invalid color: ${color}`);
  return [
    toByte(c.r),
    toByte(c.g),
    toByte(c.b),
    toByte((Number.isNaN(c.opacity) ? 1 : c.opacity) * 255),
  ];
}
