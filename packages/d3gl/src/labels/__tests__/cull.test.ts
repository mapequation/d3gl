import { describe, it, expect } from "vitest";
import { cullLabels } from "../cull.js";

const viewport = { width: 100, height: 100 };

describe("cullLabels", () => {
  it("keeps non-overlapping in-viewport labels", () => {
    const out = cullLabels(
      [
        { id: "a", x: 10, y: 10, width: 20, height: 10 },
        { id: "b", x: 60, y: 60, width: 20, height: 10 },
      ],
      { viewport },
    );
    expect(out.map((l) => l.id).sort()).toEqual(["a", "b"]);
  });

  it("drops labels whose anchor is outside the viewport (+padding)", () => {
    const out = cullLabels(
      [
        { id: "in", x: 50, y: 50, width: 10, height: 10 },
        { id: "out", x: 200, y: 50, width: 10, height: 10 },
      ],
      { viewport },
    );
    expect(out.map((l) => l.id)).toEqual(["in"]);
  });

  it("resolves overlap by keeping the higher-priority label", () => {
    const out = cullLabels(
      [
        { id: "low", x: 10, y: 10, width: 40, height: 20, priority: 1 },
        { id: "high", x: 15, y: 12, width: 40, height: 20, priority: 5 },
      ],
      { viewport },
    );
    expect(out.map((l) => l.id)).toEqual(["high"]);
  });

  it("places both when priority ties but they do not overlap", () => {
    const out = cullLabels(
      [
        { id: "a", x: 5, y: 5, width: 10, height: 10, priority: 1 },
        { id: "b", x: 80, y: 80, width: 10, height: 10, priority: 1 },
      ],
      { viewport },
    );
    expect(out).toHaveLength(2);
  });
});
