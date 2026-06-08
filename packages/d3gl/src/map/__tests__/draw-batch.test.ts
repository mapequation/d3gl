import { describe, it, expect } from "vitest";
import { buildBatch } from "../draw-batch.js";
import type { DrawItem } from "../draw-batch.js";
import type { Subpath } from "../../core/path-context.js";

const closedSubpath: Subpath = { points: [0, 0, 10, 0, 10, 10, 0, 10], closed: true };

describe("buildBatch", () => {
  it("packs points from multiple items, combining multi-center items", () => {
    const items: DrawItem[] = [
      { kind: "points", centers: [[1, 2], [3, 4]], radius: 5, color: "#ff0000" },
      { kind: "points", centers: [[7, 8]], radius: 3, color: "#00ff00" },
    ];
    const batch = buildBatch(items, (d) => d);

    expect(batch.points).not.toBeNull();
    expect(batch.points!.count).toBe(3);
    expect(Array.from(batch.points!.positions)).toEqual([1, 2, 3, 4, 7, 8]);
    expect(Array.from(batch.points!.radii)).toEqual([5, 5, 3]);
    // First two points: red (#ff0000) → [255, 0, 0, 255]
    expect(Array.from(batch.points!.colors.slice(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(batch.points!.colors.slice(4, 8))).toEqual([255, 0, 0, 255]);
    // Third point: green (#00ff00) → [0, 255, 0, 255]
    expect(Array.from(batch.points!.colors.slice(8, 12))).toEqual([0, 255, 0, 255]);
    expect(batch.paths).toBeNull();
  });

  it("collects path items with parsed RGBA fill and null stroke", () => {
    const items: DrawItem[] = [
      {
        kind: "path",
        subpaths: [closedSubpath],
        fill: "#ff0000",
        stroke: null,
        lineWidth: 0,
      },
    ];
    const batch = buildBatch(items, (d) => d);

    expect(batch.points).toBeNull();
    expect(batch.paths).not.toBeNull();
    expect(batch.paths!.length).toBe(1);
    expect(batch.paths![0]!.fill).toEqual([255, 0, 0, 255]);
    expect(batch.paths![0]!.stroke).toBeNull();
    expect(batch.paths![0]!.lineWidth).toBe(0);
    expect(batch.paths![0]!.subpaths).toEqual([closedSubpath]);
  });

  it("handles a mixed batch: points + path together", () => {
    const items: DrawItem[] = [
      { kind: "points", centers: [[1, 2], [3, 4]], radius: 5, color: "#ff0000" },
      { kind: "points", centers: [[9, 10]], radius: 2, color: "#0000ff" },
      { kind: "path", subpaths: [closedSubpath], fill: "#ff0000", stroke: null, lineWidth: 0 },
    ];
    const batch = buildBatch(items, (d) => d);

    expect(batch.points!.count).toBe(3);
    expect(batch.paths!.length).toBe(1);
  });

  it("culls null buildItem results and does not count them", () => {
    const data = [1, 2, 3, 4];
    const batch = buildBatch(data, (d) => {
      if (d === 2 || d === 4) return null;
      return { kind: "points", centers: [[d, d]], radius: 1, color: "#000" } satisfies DrawItem;
    });

    // Only d=1 and d=3 survive
    expect(batch.points!.count).toBe(2);
    expect(Array.from(batch.points!.positions)).toEqual([1, 1, 3, 3]);
  });

  it("returns points=null when there are only path items", () => {
    const items: DrawItem[] = [
      { kind: "path", subpaths: [closedSubpath], fill: null, stroke: "#ff0000", lineWidth: 2 },
    ];
    const batch = buildBatch(items, (d) => d);
    expect(batch.points).toBeNull();
    expect(batch.paths).not.toBeNull();
  });

  it("returns paths=null when there are only point items", () => {
    const items: DrawItem[] = [
      { kind: "points", centers: [[0, 0]], radius: 1, color: "#000" },
    ];
    const batch = buildBatch(items, (d) => d);
    expect(batch.paths).toBeNull();
    expect(batch.points).not.toBeNull();
  });

  it("returns points=null and paths=null when all items are culled", () => {
    const batch = buildBatch([1, 2, 3], () => null);
    expect(batch.points).toBeNull();
    expect(batch.paths).toBeNull();
  });

  it("throws on an invalid color in a points item", () => {
    const items: DrawItem[] = [
      { kind: "points", centers: [[0, 0]], radius: 1, color: "not-a-color" },
    ];
    expect(() => buildBatch(items, (d) => d)).toThrow(/invalid color/);
  });

  it("throws on an invalid fill color in a path item", () => {
    const items: DrawItem[] = [
      { kind: "path", subpaths: [closedSubpath], fill: "not-a-color", stroke: null, lineWidth: 0 },
    ];
    expect(() => buildBatch(items, (d) => d)).toThrow(/invalid color/);
  });

  it("parses non-null stroke color in a path item", () => {
    const items: DrawItem[] = [
      {
        kind: "path",
        subpaths: [closedSubpath],
        fill: null,
        stroke: "rgb(0,0,255)",
        lineWidth: 1,
      },
    ];
    const batch = buildBatch(items, (d) => d);
    expect(batch.paths![0]!.stroke).toEqual([0, 0, 255, 255]);
    expect(batch.paths![0]!.fill).toBeNull();
  });
});
