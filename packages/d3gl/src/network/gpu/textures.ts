import type { Device, Texture, Framebuffer } from "@luma.gl/core";

/** Side length of a square atlas that fits `n` texels. */
export function atlasWidth(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

/**
 * The slot → texel mapping every per-slot pass shares (row-major in an atlas of width `width`). A
 * *slot* is an index into the solver's per-node textures. {@link SLOT_TEXEL_GLSL} is the shader twin;
 * change both together, never one pass on its own.
 */
export function slotTexel(slot: number, width: number): [number, number] {
  return [slot % width, Math.floor(slot / width)];
}

/** The texel → slot inverse of {@link slotTexel}. */
export function texelSlot(x: number, y: number, width: number): number {
  return y * width + x;
}

/** GLSL twin of {@link slotTexel} / {@link texelSlot}, spliced into every per-slot shader. */
export const SLOT_TEXEL_GLSL = /* glsl */ `\
ivec2 slotTexel(int slot, int width) { return ivec2(slot % width, slot / width); }
int texelSlot(ivec2 texel, int width) { return texel.y * width + texel.x; }
`;

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
 * Pack a flat `Float32Array` into an `r32float` texture atlas — the float twin of
 * {@link packUintTexture}, with the same atlas width for the same length (so an array parallel to a
 * packed uint array is addressed with the same texel coordinate).
 */
export function packFloatTexture(
  device: Device,
  data: Float32Array,
): { texture: Texture; width: number; height: number } {
  const count = data.length;
  const width = Math.max(1, Math.ceil(Math.sqrt(count)));
  const height = Math.ceil(count / width);
  const padded = new Float32Array(width * height);
  padded.set(data);
  const texture = device.createTexture({
    width,
    height,
    format: "r32float",
    data: padded,
    mipLevels: 1,
    sampler: { minFilter: "nearest", magFilter: "nearest" },
  });
  return { texture, width, height };
}

/**
 * Read back an entire `rgba32float` texture (all `width × height` texels, 4
 * channels each) via a throwaway FBO. Returns a `Float32Array` of length
 * `width * height * 4` in row-major (x, y) order. Test-only — the layout hot
 * path never reads back to the CPU.
 */
export function readbackRgbaFbo(
  device: Device,
  texture: Texture,
): Float32Array {
  const width = texture.width;
  const height = texture.height;
  const fbo: Framebuffer = device.createFramebuffer({
    width,
    height,
    colorAttachments: [texture],
  });
  const pixels = device.readPixelsToArrayWebGL(fbo, {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: width,
    sourceHeight: height,
  }) as Float32Array;
  fbo.destroy();
  // Copy out so the caller owns a plain Float32Array (readPixels may return a
  // view into a pooled buffer).
  return Float32Array.from(pixels);
}

/**
 * Read back `count` (x, y) pairs from an `rg32float` texture via a throwaway FBO.
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

/**
 * Write the first `count` texels of a `width`-wide texture from `data` (`channels` values per texel, tightly
 * packed, at least `count · channels` long): the full rows straight from a view of `data` — no copy — and a
 * last partial row through `rowScratch` (at least `width · channels` long), whose unused tail texels get
 * whatever the scratch held. Texels past `count` are left as they were, apart from that tail. Two
 * sub-uploads, no allocation: how a multilevel seed level rewrites the prefix of its capacity textures (#353).
 */
export function writeTexels<T extends Uint32Array | Float32Array>(
  texture: Texture,
  data: T,
  count: number,
  width: number,
  channels: number,
  rowScratch: T,
): void {
  const full = Math.floor(count / width);
  if (full > 0) texture.writeData(data.subarray(0, full * width * channels), { x: 0, y: 0, width, height: full });
  if (count > full * width) {
    if (rowScratch.length < width * channels) throw new Error("writeTexels: the row scratch is shorter than a row");
    rowScratch.set(data.subarray(full * width * channels, count * channels));
    texture.writeData(rowScratch.subarray(0, width * channels), { x: 0, y: full, width, height: 1 });
  }
}
