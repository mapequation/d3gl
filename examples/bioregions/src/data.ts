import type { Feature, FeatureCollection, Polygon } from "geojson";

/** A synthetic grid cell with a continuous value and a categorical bioregion. */
export interface Cell {
  id: string;
  geometry: Polygon;
  /** Continuous field in [0, 1] (heatmap). */
  value: number;
  /** Categorical bioregion id in 0..7. */
  bioregion: number;
}

const STEP = 4; // degrees

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Generate a global grid of 4°×4° cells with smooth synthetic fields. */
export function makeCells(): Cell[] {
  const cells: Cell[] = [];
  let col = 0;
  for (let lon = -180; lon < 180; lon += STEP, col++) {
    let row = 0;
    for (let lat = -90; lat < 90; lat += STEP, row++) {
      const lonR = (lon * Math.PI) / 180;
      const latR = (lat * Math.PI) / 180;
      const value = clamp01(0.5 + 0.5 * Math.sin(lonR * 2) * Math.cos(latR * 3));
      const field = (Math.sin(lon / 40) + Math.cos(lat / 30)) * 0.5 + 1; // ~[0,2]
      const bioregion = Math.min(7, Math.max(0, Math.floor((field / 2) * 8)));
      // Clockwise ring: d3-geo's spherical geoPath fills the small cell interior,
      // not its complement (the whole sphere minus the cell). A counter-clockwise
      // ring would project every cell to a giant map-covering polygon.
      const geometry: Polygon = {
        type: "Polygon",
        coordinates: [
          [
            [lon, lat],
            [lon, lat + STEP],
            [lon + STEP, lat + STEP],
            [lon + STEP, lat],
            [lon, lat],
          ],
        ],
      };
      cells.push({ id: `${col}-${row}`, geometry, value, bioregion });
    }
  }
  return cells;
}

/** Wrap cells as a FeatureCollection for projection fitting. */
export function cellsToFeatureCollection(cells: readonly Cell[]): FeatureCollection {
  const features: Feature[] = cells.map((c) => ({
    type: "Feature",
    properties: { id: c.id },
    geometry: c.geometry,
  }));
  return { type: "FeatureCollection", features };
}
