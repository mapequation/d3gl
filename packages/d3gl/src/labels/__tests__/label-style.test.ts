import { describe, it, expect } from "vitest";
import { resolveLabelStyle, DEFAULT_LABEL_STYLE } from "../label-layer.js";

// The engine-label styling policy (#224): what net.labels() (and, later, the other engines — #223)
// passes to LabelLayer. The raw LabelLayer itself applies the result verbatim.
describe("resolveLabelStyle (#224)", () => {
  it("defaults to DEFAULT_LABEL_STYLE when neither className nor style is given", () => {
    expect(resolveLabelStyle(undefined, undefined)).toEqual(DEFAULT_LABEL_STYLE);
  });

  it("merges a partial style over the defaults (the override wins, the rest is kept)", () => {
    expect(resolveLabelStyle(undefined, { color: "#1f2937" })).toEqual({ ...DEFAULT_LABEL_STYLE, color: "#1f2937" });
  });

  it("className alone skips the defaults so the class's CSS keeps full control", () => {
    expect(resolveLabelStyle("my-label", undefined)).toBeUndefined();
  });

  it("className + style applies only the explicit style (no defaults injected over the class)", () => {
    expect(resolveLabelStyle("my-label", { color: "red" })).toEqual({ color: "red" });
  });
});
