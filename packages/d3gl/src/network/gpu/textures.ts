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
    mipLevels: 1,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
  return { texture, width, height, count };
}

/**
 * A single-target ping-pong pair. The consumer reads from `readTex` and renders
 * into `writeTex`. Calling `swap()` makes the write target the new read source
 * for the next pass.
 */
export interface PingPong {
  /** The current source texture (read side). */
  readonly readTex: Texture;
  /** The current write target texture. */
  readonly writeTex: Texture;
  /** Flip read ↔ write for the next pass. */
  swap(): void;
  /** Release both GPU textures. */
  destroy(): void;
}

/**
 * Create a ping-pong pair of `rg32float` textures of size `width × height`.
 * If `seedData` is given, it seeds the read (A) side (must be `width*height*2`
 * floats, matching {@link packPositionsTexture}'s padded layout); the write (B)
 * side always starts zeroed. Without a seed both sides start zeroed.
 */
export function pingPong(
  device: Device,
  width: number,
  height: number,
  seedData?: Float32Array,
): PingPong {
  const make = (data?: Float32Array): Texture =>
    device.createTexture({
      width,
      height,
      format: "rg32float",
      ...(data ? { data } : {}),
      mipLevels: 1,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });

  let texA = make(seedData);
  let texB = make();

  return {
    get readTex() { return texA; },
    get writeTex() { return texB; },
    swap() { const tmp = texA; texA = texB; texB = tmp; },
    destroy() { texA.destroy(); texB.destroy(); },
  };
}

/**
 * Pack a flat `Uint32Array` into an `r32uint` texture atlas.
 * Each texel stores one uint32 value.
 * Returns the texture and the atlas width used.
 */
export function packUintTexture(
  device: Device,
  data: Uint32Array,
): { texture: Texture; width: number; height: number } {
  const count = data.length;
  const width = Math.max(1, Math.ceil(Math.sqrt(count)));
  const height = Math.ceil(count / width);
  // Allocate padded buffer so the full width×height rectangle is initialised.
  const padded = new Uint32Array(width * height);
  padded.set(data);
  const texture = device.createTexture({
    width,
    height,
    format: "r32uint",
    data: padded,
    mipLevels: 1,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
  return { texture, width, height };
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
