import { describe, it, expect } from "vitest";
import { TextMeasurer, ELLIPSIS, trimToWidth } from "../measure.js";

// Node env: measureText falls back to ceil(len * px * 0.55); 10px font -> 5.5 -> width = ceil(len * 5.5).
const FONT = "10px sans-serif";
const width = (s: string) => Math.ceil(s.length * 5.5);

describe("trimToWidth (#496)", () => {
  it("returns the text untouched when it fits", () => {
    expect(trimToWidth("abc", 100, width)).toBe("abc");
  });
  it("cuts to the longest prefix that fits with the ellipsis", () => {
    const out = trimToWidth("abcdefghijklmnopqrstuvwxyz", 60, width);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
    expect(width(out)).toBeLessThanOrEqual(60);
    // One more character would not fit.
    expect(width(out.slice(0, -1) + "x" + ELLIPSIS)).toBeGreaterThan(60);
  });
  it("is just the ellipsis when not even one character fits", () => {
    expect(trimToWidth("abcdef", 1, width)).toBe(ELLIPSIS);
  });
  it("never leaves trailing whitespace before the ellipsis", () => {
    const out = trimToWidth("ab      cdefghijkl", width("ab    ") + width(ELLIPSIS), width);
    expect(out).toBe(`ab${ELLIPSIS}`);
  });
  it("never splits a surrogate pair", () => {
    const out = trimToWidth("a😀😀😀😀😀😀", width("a😀") + width(ELLIPSIS) - 1, width);
    expect(out).not.toMatch(/[\ud800-\udbff]…$/);
  });
});

describe("TextMeasurer.trim (#496)", () => {
  it("memoizes: one measurement pass per distinct text", () => {
    const m = new TextMeasurer(FONT);
    const long = "x".repeat(80);
    const a = m.trim(long, 60);
    expect(m.trim(long, 60)).toBe(a);
    expect(m.width(a)).toBeLessThanOrEqual(60);
  });
  it("re-trims when the max width changes", () => {
    const m = new TextMeasurer(FONT);
    const long = "x".repeat(80);
    const narrow = m.trim(long, 40);
    const wide = m.trim(long, 120);
    expect(wide.length).toBeGreaterThan(narrow.length);
  });
  it("leaves a short text as the same string", () => {
    const m = new TextMeasurer(FONT);
    expect(m.trim("short", 200)).toBe("short");
  });
});
