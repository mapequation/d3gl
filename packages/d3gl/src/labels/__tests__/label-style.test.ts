import { describe, it, expect } from "vitest";
import { resolveLabelStyle, resolveLabelHalo, haloStyle, DEFAULT_LABEL_STYLE, DEFAULT_LABEL_TEXT } from "../label-layer.js";

// The engine-label styling policy (#224): what net.labels() (and, later, the other engines — #223)
// passes to LabelLayer. The raw LabelLayer itself applies the result verbatim.
describe("resolveLabelStyle (#224)", () => {
  it("defaults to DEFAULT_LABEL_STYLE and the default halo when neither className nor style is given", () => {
    expect(resolveLabelStyle(undefined, undefined)).toEqual({ ...DEFAULT_LABEL_STYLE, ...haloStyle(DEFAULT_LABEL_TEXT.halo) });
  });

  it("merges a partial style over the defaults (the override wins, the rest is kept)", () => {
    expect(resolveLabelStyle(undefined, { color: "#1f2937" }, null)).toEqual({ ...DEFAULT_LABEL_STYLE, color: "#1f2937" });
  });

  it("className alone skips the defaults so the class's CSS keeps full control", () => {
    expect(resolveLabelStyle("my-label", undefined)).toBeUndefined();
  });

  it("className + style applies only the explicit style (no defaults injected over the class)", () => {
    expect(resolveLabelStyle("my-label", { color: "red" })).toEqual({ color: "red" });
  });
});

// #571: one halo for every backend. The overlay strokes it in CSS, as Canvas/SVG stroke it natively.
describe("label halo (#571)", () => {
  const halo = { color: "#ffffff", width: 1 };

  it("the default halo is 1px beyond the glyphs", () => {
    expect(DEFAULT_LABEL_TEXT.halo).toEqual(halo);
  });

  it("strokes the halo under the fill at twice its width, with round joins", () => {
    expect(haloStyle(halo)).toEqual({ webkitTextStroke: "2px #ffffff", paintOrder: "stroke", strokeLinejoin: "round" });
    expect(haloStyle({ color: "red", width: 1.5 }).webkitTextStroke).toBe("3px red");
  });

  it("draws no halo at width 0 or without one", () => {
    expect(haloStyle({ color: "#fff", width: 0 })).toEqual({});
    expect(haloStyle(undefined)).toEqual({});
    expect(resolveLabelStyle(undefined, undefined, null)).toEqual(DEFAULT_LABEL_STYLE);
  });

  it("adds the halo's stroke to the default overlay look, under the caller's style", () => {
    expect(resolveLabelStyle(undefined, undefined, halo)).toEqual({ ...DEFAULT_LABEL_STYLE, ...haloStyle(halo) });
    expect(resolveLabelStyle(undefined, { webkitTextStroke: "none" }, halo)?.webkitTextStroke).toBe("none");
  });

  it("a className keeps full control: no halo is injected", () => {
    expect(resolveLabelStyle("my-label", undefined, halo)).toBeUndefined();
  });

  it("the halo is the explicit one, else none for textShadow 'none', else the default", () => {
    expect(resolveLabelHalo({ color: "red", width: 2 }, { textShadow: "none" })).toEqual({ color: "red", width: 2 });
    expect(resolveLabelHalo(undefined, { textShadow: "none" })).toBeUndefined();
    expect(resolveLabelHalo(undefined, { color: "#333" })).toEqual(DEFAULT_LABEL_TEXT.halo);
    expect(resolveLabelHalo(undefined, undefined)).toEqual(DEFAULT_LABEL_TEXT.halo);
  });
});
