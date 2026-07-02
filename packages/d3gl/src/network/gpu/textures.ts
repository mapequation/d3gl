import type { Device, Texture, Framebuffer } from "@luma.gl/core";

/** Side length of a square atlas that fits `n` texels. */
export function atlasWidth(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

/**
 * Pack a flat `[x0, y0, x1, y1, …]` positions array into an `rg32float` texture.
 * Each texel stores one node's (x, y) position.
 * Pads the last row if `count` is not a perfect rectangle.
 */
export function packPositionsTexture(
  device: Device,
  positions: Float32Array,
): { texture: Texture; width: number; height: number; count: number } {
  const count = positions.length / 2;
  const width = atlasWidth(count);
  const height = Math.ceil(count / width);
  // Allocate padded buffer so the full width×height rectangle is initialised.
  const data = new Float32Array(width * height * 2);
  data.set(positions);
  const texture = device.createTexture({
    width,
    height,
    format: "rg32float",
    data,
    mipmaps: false,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
  return { texture, width, height, count };
}

/**
 * Read back `count` (x, y) pairs from an `rg32float` texture via an FBO.
 * Returns a `Float32Array` of length `count * 2`.
 */
export function readbackFloatFbo(
  device: Device,
  texture: Texture,
  width: number,
  count: number,
): Float32Array {
  const height = texture.height;
  const fbo: Framebuffer = device.createFramebuffer({
    width,
    height,
    colorAttachments: [texture],
  });
  // readPixelsToArrayWebGL auto-deduces sourceFormat/sourceType from the
  // texture's glFormat/glType (RG, FLOAT for rg32float). EXT_color_buffer_float
  // is enabled automatically by luma.gl's WebGLDeviceFeatures constructor.
  const pixels = device.readPixelsToArrayWebGL(fbo, {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: width,
    sourceHeight: height,
  }) as Float32Array;
  fbo.destroy();
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    out[i * 2] = pixels[i * 2]!;
    out[i * 2 + 1] = pixels[i * 2 + 1]!;
  }
  return out;
}
