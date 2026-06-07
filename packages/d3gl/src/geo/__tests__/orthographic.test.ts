import { describe, it, expect } from "vitest";
import { geoOrthographic, geoStereographic, geoGnomonic, geoMercator, geoAzimuthalEqualArea } from "d3-geo";
import { isOrthographic } from "../orthographic.js";

describe("isOrthographic", () => {
  it("is true for geoOrthographic at any scale/translate/rotate", () => {
    expect(isOrthographic(geoOrthographic())).toBe(true);
    expect(isOrthographic(geoOrthographic().scale(120).translate([200, 150]).rotate([30, -20, 5]))).toBe(true);
  });
  it("is false for other spherical projections", () => {
    expect(isOrthographic(geoStereographic())).toBe(false);
    expect(isOrthographic(geoGnomonic())).toBe(false);
    expect(isOrthographic(geoAzimuthalEqualArea())).toBe(false);
  });
  it("is false for flat projections", () => {
    expect(isOrthographic(geoMercator())).toBe(false);
  });
});
