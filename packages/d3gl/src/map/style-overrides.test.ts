import { describe, it, expect } from "vitest";
import { composeColor } from "./style-overrides.js";

describe("composeColor", () => {
  it("passes the base through untouched when there is no override", () => {
    expect(composeColor("#ff0000", undefined, undefined)).toBe("#ff0000");
  });
  it("override color replaces the base", () => {
    expect(composeColor("#ff0000", "#00ff00", undefined)).toBe("#00ff00");
  });
  it("opacity multiplies the base alpha, keeping the hue", () => {
    expect(composeColor("rgba(255, 0, 0, 0.5)", undefined, 0.5)).toBe("rgba(255, 0, 0, 0.25)");
    expect(composeColor("#ff0000", undefined, 0.3)).toBe("rgba(255, 0, 0, 0.3)");
  });
  it("opacity applies to the override color when both are set", () => {
    expect(composeColor("#ff0000", "#0000ff", 0.5)).toBe("rgba(0, 0, 255, 0.5)");
  });
  it("returns null when there is nothing to paint", () => {
    expect(composeColor(undefined, undefined, 0.3)).toBeNull();
    expect(composeColor(undefined, undefined, undefined)).toBeNull();
  });
  it("clamps opacity products into [0, 1] and rejects invalid colors", () => {
    expect(composeColor("#ff0000", undefined, 4)).toBe("rgb(255, 0, 0)");
    expect(() => composeColor("not-a-color", undefined, 0.5)).toThrow(/invalid color/);
  });
});
