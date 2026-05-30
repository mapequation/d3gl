import { describe, it, expect } from "vitest";
import { geoPath, geoEquirectangular } from "d3-geo";
import { arc as d3arc } from "d3-shape";
import { PathRecorder } from "../path-recorder.js";
import { tessellateFill } from "../tessellate.js";

describe("d3 conformance", () => {
  it("d3-geo geoPath drives the PathRecorder for a polygon feature", () => {
    const recorder = new PathRecorder();
    const projection = geoEquirectangular();
    // geoPath calls moveTo/lineTo/closePath on the context we pass.
    const path = geoPath(projection, recorder);

    const square: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ],
    };
    recorder.beginPath();
    path(square);

    expect(recorder.subpaths.length).toBeGreaterThanOrEqual(1);
    const sp = recorder.subpaths[0]!;
    expect(sp.closed).toBe(true);
    // The recorded ring tessellates into at least 2 triangles.
    const { indices } = tessellateFill([sp]);
    expect(indices.length).toBeGreaterThanOrEqual(6);
  });

  it("d3-shape arc generator drives the recorder and flattens its curves", () => {
    const recorder = new PathRecorder();
    const generator = d3arc().innerRadius(0).outerRadius(100);
    recorder.beginPath();
    generator.context(recorder)({
      startAngle: 0,
      endAngle: Math.PI / 2,
      innerRadius: 0,
      outerRadius: 100,
    });
    expect(recorder.subpaths.length).toBeGreaterThanOrEqual(1);
    const sp = recorder.subpaths[0]!;
    // A 90-degree wedge flattens into many points.
    expect(sp.points.length / 2).toBeGreaterThan(4);
  });
});
