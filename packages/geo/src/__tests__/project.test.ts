import { describe, it, expect } from "vitest";
import { geoEquirectangular } from "d3-geo";
import { Scene } from "@d3gl/core";
import { fitProjection, featureGroup } from "../project.js";

const featureA: GeoJSON.Feature = {
  type: "Feature",
  properties: { id: "a" },
  geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
};
const featureB: GeoJSON.Feature = {
  type: "Feature",
  properties: { id: "b" },
  geometry: { type: "Polygon", coordinates: [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]] },
};

describe("fitProjection", () => {
  it("fits the projection so geometry falls within the viewport", () => {
    const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [featureA, featureB] };
    const projection = fitProjection(geoEquirectangular(), fc, 256, 128);
    const p = projection([5, 5])!; // a lon/lat inside the data
    expect(p[0]).toBeGreaterThanOrEqual(0);
    expect(p[0]).toBeLessThanOrEqual(256);
    expect(p[1]).toBeGreaterThanOrEqual(0);
    expect(p[1]).toBeLessThanOrEqual(128);
  });
});

describe("featureGroup", () => {
  it("builds one drawable per feature, projected once into the Scene", () => {
    const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [featureA, featureB] };
    const projection = fitProjection(geoEquirectangular(), fc, 256, 128);
    const scene = new Scene();
    scene.group(
      "land",
      featureGroup([featureA, featureB], projection, {
        id: (f) => String((f.properties as { id: string }).id),
        lineWidth: 1,
      }),
    );
    const buf = scene.buffers("land");
    expect(buf.drawableCount).toBe(2);
    expect(buf.fillIndices.length).toBeGreaterThanOrEqual(2 * 6);
    expect(buf.strokeIndices.length).toBeGreaterThan(0);
    expect(() => scene.range("land", "a")).not.toThrow();
    expect(() => scene.range("land", "b")).not.toThrow();
  });

  it("omits stroke geometry when no lineWidth is given", () => {
    const projection = fitProjection(geoEquirectangular(), featureA, 256, 128);
    const scene = new Scene();
    scene.group("land", featureGroup([featureA], projection, { id: () => "a" }));
    expect(scene.buffers("land").strokeIndices.length).toBe(0);
  });
});
