import { describe, it, expect } from "vitest";
import { geoEquirectangular, geoNaturalEarth1 } from "d3-geo";
import { Scene } from "../../core/index.js";
import { fitProjection, featureGroup } from "../project.js";
import { geoLayer } from "../geo-layer.js";
import type { GeoInput } from "../project.js";

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

describe("nested rings survive projection (#73)", () => {
  /** An island in a lake in land, with a pond on the island — RFC 7946 shape: a
   *  MultiPolygon of `[land, lake]` and `[island, pond]`, exteriors CLOCKWISE in
   *  [lon, lat] and holes counter-clockwise (AGENTS.md "GeoJSON winding"). */
  const cw = (h: number): [number, number][] => [[-h, -h], [-h, h], [h, h], [h, -h], [-h, -h]];
  const ccw = (h: number): [number, number][] => [...cw(h)].reverse();
  const atoll: GeoJSON.Feature = {
    type: "Feature",
    properties: { id: "atoll" },
    geometry: { type: "MultiPolygon", coordinates: [[cw(16), ccw(12)], [cw(8), ccw(4)]] },
  };

  /** True when (x, y) lands on one of the drawable's tessellated fill triangles. */
  const filled = (buf: { fillVertices: Float32Array; fillIndices: Uint32Array }, x: number, y: number): boolean => {
    const { fillVertices: v, fillIndices: ix } = buf;
    for (let t = 0; t < ix.length; t += 3) {
      const [a, b, c] = [(ix[t] ?? 0) * 3, (ix[t + 1] ?? 0) * 3, (ix[t + 2] ?? 0) * 3];
      const ax = v[a] ?? 0, ay = v[a + 1] ?? 0;
      const bx = v[b] ?? 0, by = v[b + 1] ?? 0;
      const cx = v[c] ?? 0, cy = v[c + 1] ?? 0;
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (d === 0) continue;
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
      if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) return true;
    }
    return false;
  };

  it("fills land ▸ lake ▸ island ▸ pond alternately after geoPath projects them", () => {
    const projection = fitProjection(geoEquirectangular(), atoll, 256, 256);
    const scene = new Scene();
    scene.group("atoll", featureGroup([atoll], projection, { id: () => "atoll" }));
    const buf = scene.buffers("atoll");
    // Probe on the equator, walking outwards in longitude through every band. Projection
    // is monotone in lon, so these land in the right ring on screen too.
    const at = (lon: number): [number, number] => projection([lon, 0]) ?? [NaN, NaN];
    for (const [lon, want, what] of [[14, true, "land"], [10, false, "lake"], [6, true, "island"], [2, false, "pond"]] as const) {
      const [x, y] = at(lon);
      expect(filled(buf, x, y), `${what} at lon ${lon}`).toBe(want);
    }
  });
});

describe("GeoInput accepts a GeoJSON Sphere without casts", () => {
  it("fitProjection + geoLayer take { type: 'Sphere' } and build a fillable ocean", () => {
    // No `as any` / `as unknown as GeoInput`: a Sphere is a first-class GeoInput now.
    const sphere: GeoInput = { type: "Sphere" };
    const projection = fitProjection(geoNaturalEarth1(), sphere, 256, 128);
    const scene = new Scene();
    scene.group("ocean", geoLayer([sphere], projection, { id: () => "ocean" }));
    // The sphere outline becomes one fillable drawable (the whole-globe silhouette).
    const buf = scene.buffers("ocean");
    expect(buf.drawableCount).toBe(1);
    expect(buf.fillIndices.length).toBeGreaterThanOrEqual(6);
  });
});
