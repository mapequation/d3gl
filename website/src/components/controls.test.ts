// @vitest-environment jsdom
// website/src/components/controls.test.ts
import { describe, it, expect, vi } from "vitest";
import { segmented, slider } from "./controls.js";

describe("controls", () => {
  it("renders one button per option and emits the chosen value", () => {
    const onChange = vi.fn();
    const el = segmented("Backend", ["webgl", "canvas", "svg"], "webgl", onChange);
    const buttons = el.querySelectorAll("button");
    expect(buttons.length).toBe(3);
    (buttons[1] as HTMLButtonElement).click();
    expect(onChange).toHaveBeenCalledWith("canvas");
    // clicking updates the active button to the chosen option
    expect(el.querySelector("button.is-active")?.textContent).toBe("canvas");
  });

  it("slider formats with display labels and emits the numeric value on change", () => {
    const onChange = vi.fn();
    const el = slider("Cell size", { min: 0, max: 3, step: 1, value: 2, display: ["1°", "2°", "4°", "8°"] }, onChange);
    expect(el.querySelector(".d3gl-seg-label")?.textContent).toBe("Cell size 4°");
    const input = el.querySelector("input")!;
    input.value = "0";
    input.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledWith(0);
  });
});
