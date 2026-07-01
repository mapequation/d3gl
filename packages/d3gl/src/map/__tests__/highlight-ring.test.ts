import { describe, it, expect } from "vitest";
import { resolveRingColors, ringCircles } from "../highlight-ring.js";

const center = () => [0, 0] as [number, number];
const radius = () => 5;
const colorAt = (data: ReturnType<typeof ringCircles>, k: number): [number, number, number, number] =>
  [data.borderColors[k * 4]!, data.borderColors[k * 4 + 1]!, data.borderColors[k * 4 + 2]!, data.borderColors[k * 4 + 3]!];

describe("ringCircles colors (#105 / #140 / #162)", () => {
  it("colors selected vs hover vs will-remove rings distinctly", () => {
    const colors = resolveRingColors({}); // defaults (#162): red select + hover, yellow remove
    expect(colors.select).toEqual([220, 38, 38, 255]); // #dc2626 red
    expect(colors.hover).toEqual([220, 38, 38, 255]); // #dc2626 red (same as selected — one focus colour)
    expect(colors.remove).toEqual([234, 179, 8, 255]); // #eab308 yellow

    // ids: 10 selected (red), 11 hover (red), 12 selected-but-in-subtract-box (yellow overrides select).
    const ids = Uint32Array.from([10, 11, 12]);
    const selected = new Set([10, 12]);
    const remove = new Set([12]);
    const data = ringCircles(ids, center, radius, (g) => selected.has(g), colors, (g) => remove.has(g));

    expect(colorAt(data, 0)).toEqual([220, 38, 38, 255]); // 10 → red (selected)
    expect(colorAt(data, 1)).toEqual([220, 38, 38, 255]); // 11 → red (hover)
    expect(colorAt(data, 2)).toEqual([234, 179, 8, 255]); // 12 → yellow (will-remove wins over selected)
  });

  it("a custom selection.selected.stroke still overrides the default ring colour", () => {
    const colors = resolveRingColors({ selection: { selected: { stroke: "#00f" } } });
    const data = ringCircles(Uint32Array.from([1]), center, radius, () => true, colors);
    expect(colorAt(data, 0)).toEqual([0, 0, 255, 255]); // the custom stroke, not the red default
  });
});
