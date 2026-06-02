export interface PaletteDimensions {
  width: number;
  height: number;
}

/**
 * Texel dimensions for a per-drawable side-table of `count` entries. A single row
 * up to `maxWidth`, then wrapping into rows. drawableId -> texel is therefore
 * (id % width, floor(id / width)); the shader recovers `width` via textureSize().
 */
export function paletteDimensions(count: number, maxWidth = 256): PaletteDimensions {
  if (count <= 0) return { width: 1, height: 1 };
  const width = Math.min(count, maxWidth);
  const height = Math.ceil(count / width);
  return { width, height };
}

/** RGBA colors (4 bytes/drawable) laid into a width*height*4 buffer, zero-padded. */
export function padPalette(colors: Uint8Array, dims: PaletteDimensions): Uint8Array {
  const data = new Uint8Array(dims.width * dims.height * 4);
  data.set(colors.subarray(0, data.length));
  return data;
}

/** Flags (1 byte/drawable) laid into a width*height buffer, zero-padded. */
export function padFlags(flags: Uint8Array, dims: PaletteDimensions): Uint8Array {
  const data = new Uint8Array(dims.width * dims.height);
  data.set(flags.subarray(0, data.length));
  return data;
}

/**
 * Encode a drawableId into RGB bytes for GPU color-picking. Offset by +1 so that
 * a cleared (black) pick buffer decodes to -1 ("no drawable").
 */
export function encodePickColor(drawableId: number): [number, number, number] {
  const v = drawableId + 1;
  return [v & 255, (v >> 8) & 255, (v >> 16) & 255];
}

/** Decode RGB pick bytes back to a drawableId (-1 for the cleared background). */
export function decodePickColor(r: number, g: number, b: number): number {
  return (r | (g << 8) | (b << 16)) - 1;
}
