import { describe, it, expect } from "vitest";
import { makeMajorRivers, centreCells } from "./geo-data.js";

describe("makeMajorRivers", () => {
  it("returns one named LineString feature per river", () => {
    const rivers = makeMajorRivers();
    expect(rivers.length).toBe(7);
    expect(rivers.map((r) => r.properties.name)).toContain("Amazon");
    for (const r of rivers) {
      expect(r.geometry.type).toBe("LineString");
      expect(r.geometry.coordinates.length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("centreCells", () => {
  it("is the 4° grid restricted to lon ±60°, lat ±30°", () => {
    const cells = centreCells();
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(Math.abs(c.center[0])).toBeLessThanOrEqual(60);
      expect(Math.abs(c.center[1])).toBeLessThanOrEqual(30);
    }
  });
});
