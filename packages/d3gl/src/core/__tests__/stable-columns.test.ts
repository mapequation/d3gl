import { describe, it, expect } from "vitest";
import { StableColumns } from "../stable-columns.js";

describe("StableColumns", () => {
  it("hands back the previous array when the new column holds the same values", () => {
    const memo = new StableColumns();
    const first = memo.float32("links.widths", new Float32Array([1, 2, 3]));
    expect(memo.float32("links.widths", new Float32Array([1, 2, 3]))).toBe(first);
    const colours = memo.uint8("links.colors", new Uint8Array([9, 8, 7, 255]));
    expect(memo.uint8("links.colors", new Uint8Array([9, 8, 7, 255]))).toBe(colours);
  });

  it("adopts the new array when a value, the length or the key differs", () => {
    const memo = new StableColumns();
    const a = memo.float32("k", new Float32Array([1, 2, 3]));
    const b = new Float32Array([1, 2, 4]);
    expect(memo.float32("k", b)).toBe(b);
    const c = new Float32Array([1, 2, 4, 0]);
    expect(memo.float32("k", c)).toBe(c);
    const d = new Float32Array([1, 2, 3]);
    expect(memo.float32("other", d)).toBe(d); // keys are independent
    expect(memo.float32("k", new Float32Array([1, 2, 4, 0]))).toBe(c); // the latest adopted array is the reference
    expect(a).not.toBe(c);
  });

  it("treats NaN as changed (re-upload is the safe direction) and forgets everything on clear()", () => {
    const memo = new StableColumns();
    const nan = memo.float32("k", new Float32Array([Number.NaN]));
    const again = new Float32Array([Number.NaN]);
    expect(memo.float32("k", again)).toBe(again);
    expect(again).not.toBe(nan);
    memo.clear();
    const fresh = new Float32Array([Number.NaN]);
    expect(memo.float32("k", fresh)).toBe(fresh);
  });
});
