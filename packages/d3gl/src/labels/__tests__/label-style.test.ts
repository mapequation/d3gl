import { describe, it, expect } from "vitest";
import { resolveLabelStyle, resolveLabelHalo, resolveLabelText, haloStyle, overlayFont, DEFAULT_LABEL_STYLE, DEFAULT_LABEL_TEXT } from "../label-layer.js";

// The engine-label styling policy (#224): what net.labels() (and, later, the other engines — #223)
// passes to LabelLayer. The raw LabelLayer itself applies the result verbatim.
describe("resolveLabelStyle (#224)", () => {
  it("defaults to DEFAULT_LABEL_STYLE and the default halo when neither className nor style is given", () => {
    expect(resolveLabelStyle(undefined, undefined)).toEqual({ ...DEFAULT_LABEL_STYLE, ...haloStyle(DEFAULT_LABEL_TEXT.halo) });
  });

  it("merges a partial style over the defaults (the override wins, the rest is kept)", () => {
    expect(resolveLabelStyle(undefined, { color: "#1f2937" })).toEqual({ ...DEFAULT_LABEL_STYLE, ...haloStyle(DEFAULT_LABEL_TEXT.halo), color: "#1f2937" });
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
    expect(resolveLabelStyle(undefined, undefined, { ...DEFAULT_LABEL_TEXT, halo: undefined })).toEqual(DEFAULT_LABEL_STYLE);
  });

  it("adds the halo's stroke to the default overlay look, under the caller's style", () => {
    const text = { ...DEFAULT_LABEL_TEXT, halo };
    expect(resolveLabelStyle(undefined, undefined, text)).toEqual({ ...DEFAULT_LABEL_STYLE, ...haloStyle(halo) });
    expect(resolveLabelStyle(undefined, { webkitTextStroke: "none" }, text)?.webkitTextStroke).toBe("none");
  });

  it("a className keeps full control: no halo is injected", () => {
    expect(resolveLabelStyle("my-label", undefined, { ...DEFAULT_LABEL_TEXT, halo })).toBeUndefined();
  });

  it("the halo is the explicit one, else none for textShadow 'none', else the default", () => {
    expect(resolveLabelHalo({ color: "red", width: 2 }, { textShadow: "none" })).toEqual({ color: "red", width: 2 });
    expect(resolveLabelHalo(undefined, { textShadow: "none" })).toBeUndefined();
    expect(resolveLabelHalo(undefined, { color: "#333" })).toEqual(DEFAULT_LABEL_TEXT.halo);
    expect(resolveLabelHalo(undefined, undefined)).toEqual(DEFAULT_LABEL_TEXT.halo);
  });
});

// #577: one font and colour for the overlay, the native text and the measurement.
describe("label text (#577)", () => {
  it("takes the explicit font/color, else style's, else the default", () => {
    expect(resolveLabelText({})).toEqual(DEFAULT_LABEL_TEXT);
    expect(resolveLabelText({ style: { font: "13px/1.4 serif", color: "#333" } })).toEqual({ font: "13px serif", color: "#333", halo: DEFAULT_LABEL_TEXT.halo });
    expect(resolveLabelText({ font: "14px serif", color: "red", style: { font: "13px serif", color: "#333" } })).toEqual({ font: "14px serif", color: "red", halo: DEFAULT_LABEL_TEXT.halo });
    expect(resolveLabelText({ style: { textShadow: "none" } }).halo).toBeUndefined();
  });

  it("the overlay draws the resolved font (line-height 1) and colour, over style's", () => {
    const text = resolveLabelText({ font: "14px serif", color: "red", style: { font: "9px sans-serif", color: "blue" } });
    const css = resolveLabelStyle(undefined, { font: "9px sans-serif", color: "blue" }, text);
    expect(css?.font).toBe("14px/1 serif");
    expect(css?.color).toBe("red");
  });

  it("a style.lineHeight is applied after the font shorthand", () => {
    const css = resolveLabelStyle(undefined, { lineHeight: "1.5" }) ?? {};
    const keys = Object.keys(css);
    expect(keys.indexOf("lineHeight")).toBeGreaterThan(keys.indexOf("font"));
  });

  it("overlayFont sets line-height 1 unless the font names one", () => {
    expect(overlayFont("600 11px system-ui, sans-serif")).toBe("600 11px/1 system-ui, sans-serif");
    expect(overlayFont("12.5px serif")).toBe("12.5px/1 serif");
    expect(overlayFont("14px/1.2 serif")).toBe("14px/1.2 serif");
  });
});
