import { describe, it, expect } from "vitest";
import { resolveRingColors, ringCircles } from "../highlight-ring.js";

const center = () => [0, 0] as [number, number];
const radius = () => 5;
const colorAt = (data: ReturnType<typeof ringCircles>, k: number): [number, number, number, number] =>
  [data.borderColors[k * 4]!, data.borderColors[k * 4 + 1]!, data.borderColors[k * 4 + 2]!, data.borderColors[k * 4 + 3]!];

describe("ringCircles colors (#105 / #140)", () => {
  it("colors selected vs hover vs will-remove rings distinctly", () => {
    const colors = resolveRingColors({}); // defaults: blue select, green hover, red remove
    expect(colors.select).toEqual([37, 99, 235, 255]); // #2563eb
    expect(colors.hover).toEqual([22, 163, 74, 255]); // #16a34a
    expect(colors.remove).toEqual([220, 38, 38, 255]); // #dc2626

    // ids: 10 selected (blue), 11 hover (green), 12 selected-but-in-subtract-box (red overrides select).
    const ids = Uint32Array.from([10, 11, 12]);
    const selected = new Set([10, 12]);
    const remove = new Set([12]);
    const data = ringCircles(ids, center, radius, (g) => selected.has(g), colors, (g) => remove.has(g));

    expect(colorAt(data, 0)).toEqual([37, 99, 235, 255]); // 10 → blue (selected)
    expect(colorAt(data, 1)).toEqual([22, 163, 74, 255]); // 11 → green (hover / will-add)
    expect(colorAt(data, 2)).toEqual([220, 38, 38, 255]); // 12 → red (will-remove wins over selected)
  });

  it("without an isRemove predicate, falls back to select/hover (unchanged #105 behavior)", () => {
    const colors = resolveRingColors({});
    const data = ringCircles(Uint32Array.from([1]), center, radius, () => true, colors);
    expect(colorAt(data, 0)).toEqual([37, 99, 235, 255]); // blue — no remove path
  });
});
