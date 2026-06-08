import { describe, it, expect } from "vitest";
import { projectPoints } from "../point-batch.js";

describe("projectPoints", () => {
  const data = [
    { lon: 0, lat: 0, c: "#ff0000" },
    { lon: 10, lat: 20, c: "#00ff00" },
    { lon: 999, lat: 999, c: "#0000ff" }, // culled by project returning null
  ];
  const project = (d: (typeof data)[number]) =>
    d.lon > 360 ? null : ([d.lon, d.lat] as [number, number]);

  it("projects to a packed Float32 position array, skipping culled points", () => {
    const b = projectPoints(data, {
      project,
      radius: () => 2,
      color: (d) => d.c,
    });
    expect(b.count).toBe(2);
    expect(Array.from(b.positions)).toEqual([0, 0, 10, 20]);
  });

  it("packs radii and RGBA colors parallel to positions", () => {
    const b = projectPoints(data, { project, radius: (d) => (d.lon === 0 ? 3 : 5), color: (d) => d.c });
    expect(Array.from(b.radii)).toEqual([3, 5]);
    expect(Array.from(b.colors.slice(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(b.colors.slice(4, 8))).toEqual([0, 255, 0, 255]);
  });

  it("accepts a constant radius number", () => {
    const b = projectPoints(data, { project, radius: 4, color: () => "#000" });
    expect(Array.from(b.radii)).toEqual([4, 4]);
  });
});
