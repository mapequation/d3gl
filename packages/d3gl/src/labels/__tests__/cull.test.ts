import { describe, it, expect } from "vitest";
import { cullLabels, labelGeometry } from "../cull.js";

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

  it("packs rotated labels by their true footprint, not the un-rotated box", () => {
    // Two long labels stacked vertically, each rotated to read straight up (-90°). As
    // un-rotated 60×12 boxes they would overlap (wide horizontal strips); as vertical
    // boxes (12 wide, 60 tall) sitting 16px apart they do not.
    const rotation = -Math.PI / 2;
    const labels = [
      { id: "a", x: 50, y: 50, width: 60, height: 12, rotation, priority: 1 },
      { id: "b", x: 66, y: 50, width: 60, height: 12, rotation, priority: 1 },
    ];
    expect(cullLabels(labels, { viewport }).map((l) => l.id).sort()).toEqual(["a", "b"]);
    // Same anchors WITHOUT rotation collide → only the first survives.
    const flat = labels.map(({ rotation: _r, ...rest }) => rest);
    expect(cullLabels(flat, { viewport })).toHaveLength(1);
  });

  it("still resolves genuine overlap between rotated labels", () => {
    const rotation = -Math.PI / 2;
    const out = cullLabels(
      [
        { id: "low", x: 50, y: 50, width: 60, height: 12, rotation, priority: 1 },
        { id: "high", x: 53, y: 55, width: 60, height: 12, rotation, priority: 5 },
      ],
      { viewport },
    );
    expect(out.map((l) => l.id)).toEqual(["high"]);
  });
});

describe("labelGeometry", () => {
  it("returns the axis-aligned top-left box for a plain label", () => {
    const g = labelGeometry({ id: "a", x: 10, y: 20, width: 30, height: 12 });
    expect(g.axisAligned).toBe(true);
    expect([g.minX, g.minY, g.maxX, g.maxY]).toEqual([10, 20, 40, 32]);
    expect(g.transform).toBe("");
  });

  it("derives a transform and oriented box for a rotated upright label", () => {
    // 90° outward radius at the top of a radial fan: text reads bottom-to-top, vertically
    // centred on the anchor. The CSS matches the classic radial-tree rotate/translate idiom.
    const g = labelGeometry({
      id: "a", x: 0, y: 0, width: 40, height: 12, rotation: -Math.PI / 2, keepUpright: true,
    });
    expect(g.axisAligned).toBe(false);
    expect(g.transform).toBe("rotate(-90deg) translate(0%, -50%)");
    // Box: ~12 wide (height), ~40 tall (width), extending upward (negative y) from the anchor.
    expect(g.maxX - g.minX).toBeCloseTo(12);
    expect(g.maxY - g.minY).toBeCloseTo(40);
    expect(g.minY).toBeCloseTo(-40);
    expect(g.maxY).toBeCloseTo(0);
  });

  it("flips to stay upright on the far side and swaps the text side", () => {
    // Reading direction points left (cos < 0) → +180° and start→end so text still radiates out.
    // rotation = -π is the west pole of a radial fan (tree-angle -π/2).
    const g = labelGeometry({
      id: "a", x: 0, y: 0, width: 40, height: 12, rotation: -Math.PI, keepUpright: true,
    });
    expect(g.transform).toBe("rotate(0deg) translate(-100%, -50%)");
  });
});
