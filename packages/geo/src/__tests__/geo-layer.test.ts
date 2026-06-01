import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { Scene } from "@d3gl/core";
import { geoLayer } from "../geo-layer.js";

const proj = geoEquirectangular().scale(50).translate([180, 90]);

function build(features: any[], opts: any) {
  const scene = new Scene();
  scene.group("g", geoLayer(features, proj, opts));
  return scene;
}

describe("geoLayer", () => {
  it("renders Point/MultiPoint as analytic circle drawables", () => {
    const scene = build(
      [
        { type: "Point", coordinates: [0, 0] },
        { type: "MultiPoint", coordinates: [[10, 10], [20, 20]] },
      ],
      { pointRadius: 4 },
    );
    const ds = scene.drawables("g");
    expect(ds.length).toBe(2);
    // Points are circle drawables (center+radius), not flattened polygons.
    expect(ds[0]!.subpaths.length).toBe(0);
    expect(ds[0]!.circles.length).toBe(1);
    expect(ds[0]!.circles[0]!.r).toBe(4);
    expect(ds[1]!.circles.length).toBe(2); // two circles in one MultiPoint drawable
  });

  it("renders Polygon (closed) and LineString (open stroke)", () => {
    const scene = build(
      [
        { type: "Polygon", coordinates: [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]] },
        { type: "LineString", coordinates: [[0, 0], [10, 10], [20, 0]] },
      ],
      { lineWidth: 1 },
    );
    const ds = scene.drawables("g");
    expect(ds[0]!.subpaths[0]!.closed).toBe(true);   // polygon ring
    expect(ds[1]!.subpaths[0]!.closed).toBe(false);  // line is open
  });

  it("applies the id accessor", () => {
    const scene = build([{ type: "Point", coordinates: [0, 0] }], { id: () => "x" });
    expect(scene.drawables("g")[0]!.id).toBe("x");
  });
});
