// @vitest-environment jsdom
// website/src/components/controls.test.ts
import { describe, it, expect } from "vitest";
import { setActive, formatRange, ACTIVE_CLASS, INACTIVE_CLASS } from "./controls.js";

/** Build a segmented ButtonGroup like ExampleFrame.astro renders, with the
 *  first option pre-marked active. */
function segGroup(values: string[]): HTMLElement {
  const group = document.createElement("div");
  values.forEach((v, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.controlValue = v;
    b.className = i === 0 ? ACTIVE_CLASS : INACTIVE_CLASS;
    if (i === 0) b.setAttribute("data-active", "");
    group.appendChild(b);
  });
  return group;
}

describe("setActive", () => {
  it("moves the active marker + styling to the chosen segmented option", () => {
    const group = segGroup(["webgl", "canvas", "svg"]);
    const buttons = Array.from(group.querySelectorAll("button"));
    expect(group.querySelector("[data-active]")).toBe(buttons[0]);

    setActive(group, buttons[1]);

    // exactly one active button, and it is the chosen one with the primary class
    const active = group.querySelectorAll("[data-active]");
    expect(active.length).toBe(1);
    expect(active[0]).toBe(buttons[1]);
    expect(buttons[1].className).toBe(ACTIVE_CLASS);
    expect(buttons[0].className).toBe(INACTIVE_CLASS);
    expect(buttons[2].className).toBe(INACTIVE_CLASS);
  });

  it("derives distinct active vs inactive Starwind button classes (red primary)", () => {
    expect(ACTIVE_CLASS).not.toBe(INACTIVE_CLASS);
    expect(ACTIVE_CLASS).toContain("bg-primary");
    expect(INACTIVE_CLASS).toContain("bg-background");
  });
});

describe("formatRange", () => {
  it("maps the value to a per-step display label when provided", () => {
    const spec = { min: 0, step: 1, display: ["1°", "2°", "4°", "8°"] };
    expect(formatRange(2, spec)).toBe("4°");
    expect(formatRange(0, spec)).toBe("1°");
  });

  it("falls back to the raw value when no display labels exist", () => {
    expect(formatRange(7, { min: 0, step: 1 })).toBe("7");
  });
});
