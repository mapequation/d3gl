import { describe, it, expect } from "vitest";
import { geoEquirectangular, geoOrthographic } from "d3-geo";
import { projectVisiblePoint } from "../geo-layer.js";

describe("projectVisiblePoint", () => {
  it("projects a visible point to screen coords", () => {
    const proj = geoEquirectangular().scale(50).translate([180, 90]);
    const p = projectVisiblePoint(proj, [0, 0]);
    expect(p).not.toBeNull();
    // [0,0] maps to the projection's translate origin.
    expect(p![0]).toBeCloseTo(180);
    expect(p![1]).toBeCloseTo(90);
  });

  it("culls a point over the horizon on an azimuthal (orthographic) projection", () => {
    // Default rotation → visible hemisphere centred on lon/lat [0,0].
    const ortho = geoOrthographic().scale(100).translate([100, 100]);
    expect(projectVisiblePoint(ortho, [0, 0])).not.toBeNull();   // front centre
    expect(projectVisiblePoint(ortho, [180, 0])).toBeNull();     // antipode → culled
  });

  it("keeps all points on a projection without a clipAngle (equirectangular)", () => {
    const proj = geoEquirectangular().scale(50).translate([180, 90]);
    expect(projectVisiblePoint(proj, [0, 0])).not.toBeNull();
    expect(projectVisiblePoint(proj, [180, 0])).not.toBeNull();
  });
});
