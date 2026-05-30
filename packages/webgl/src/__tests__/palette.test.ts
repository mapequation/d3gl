import { describe, it, expect } from "vitest";
import {
  paletteDimensions,
  padPalette,
  padFlags,
  encodePickColor,
  decodePickColor,
} from "../palette.js";

describe("paletteDimensions", () => {
  it("is a single row up to the max width", () => {
    expect(paletteDimensions(10)).toEqual({ width: 10, height: 1 });
  });
  it("wraps into multiple rows beyond max width", () => {
    expect(paletteDimensions(300)).toEqual({ width: 256, height: 2 });
  });
  it("never returns a zero dimension", () => {
    expect(paletteDimensions(0)).toEqual({ width: 1, height: 1 });
  });
});

describe("padPalette", () => {
  it("lays RGBA colors into a width*height*4 buffer, zero-padded", () => {
    const colors = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); // 2 drawables
    const out = padPalette(colors, { width: 4, height: 1 });
    expect(out.length).toBe(4 * 1 * 4);
    expect(Array.from(out.slice(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(out.slice(8))).toEqual(new Array(8).fill(0));
  });
});

describe("padFlags", () => {
  it("lays 1-byte flags into a width*height buffer", () => {
    const flags = new Uint8Array([1, 0]);
    const out = padFlags(flags, { width: 4, height: 1 });
    expect(out.length).toBe(4);
    expect(Array.from(out)).toEqual([1, 0, 0, 0]);
  });
});

describe("pick id codec", () => {
  it("round-trips a drawableId through RGB bytes", () => {
    for (const id of [0, 1, 255, 256, 70000]) {
      const [r, g, b] = encodePickColor(id);
      expect(decodePickColor(r, g, b)).toBe(id);
    }
  });
  it("reserves black (0,0,0) for 'no drawable' (-1)", () => {
    expect(decodePickColor(0, 0, 0)).toBe(-1);
    // id 0 must therefore NOT encode to black
    expect(encodePickColor(0)).toEqual([1, 0, 0]);
  });
});
