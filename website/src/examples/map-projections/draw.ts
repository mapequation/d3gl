import {
  geoNaturalEarth1, geoEqualEarth, geoMercator, geoTransverseMercator,
  geoEquirectangular, geoConicConformal, geoConicEqualArea, geoConicEquidistant,
  geoAlbers, geoOrthographic, geoStereographic, geoAzimuthalEqualArea,
  geoAzimuthalEquidistant, geoGnomonic, type GeoProjection,
} from "d3-geo";
import { scaleSequential } from "d3-scale";
import { interpolateViridis } from "d3-scale-chromatic";
import { geoMap } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import type { ImperativeSetup } from "../types.js";
import {
  loadWorld, makeGraticule, makeCities, makeRoute, makeDemoPolygon, centreCells,
} from "../shared/geo-data.js";

const OCEAN = "#d4e6f5";
const LAND = "#e3e6ea";
const GRATICULE = "#c2d4e4";
const heat = scaleSequential(interpolateViridis).domain([0, 1]);

interface ProjEntry { create: () => GeoProjection; spherical: boolean; }

/** d3-geo core projections. Spherical (azimuthal) ones rotate; the rest zoom. */
const PROJECTIONS: Record<string, ProjEntry> = {
  Orthographic: { create: geoOrthographic, spherical: true },
  Stereographic: { create: geoStereographic, spherical: true },
  "Azimuthal Equal Area": { create: geoAzimuthalEqualArea, spherical: true },
  "Azimuthal Equidistant": { create: geoAzimuthalEquidistant, spherical: true },
  Gnomonic: { create: geoGnomonic, spherical: true },
  "Natural Earth": { create: geoNaturalEarth1, spherical: false },
  "Equal Earth": { create: geoEqualEarth, spherical: false },
  Mercator: { create: geoMercator, spherical: false },
  "Transverse Mercator": { create: geoTransverseMercator, spherical: false },
  Equirectangular: { create: geoEquirectangular, spherical: false },
  "Conic Conformal": { create: geoConicConformal, spherical: false },
  "Conic Equal Area": { create: geoConicEqualArea, spherical: false },
  "Conic Equidistant": { create: geoConicEquidistant, spherical: false },
  Albers: { create: geoAlbers, spherical: false },
};

export const PROJECTION_NAMES = Object.keys(PROJECTIONS);
const DEFAULT = "Orthographic";

/**
 * Pick any d3-geo projection. Spherical projections (orthographic, azimuthal, …)
 * become a drag-to-rotate globe — each drag frame re-projects the land via
 * `projection.rotate(...)`; the wheel scales it. Flat projections use d3-zoom
 * pan/zoom. Switching projection calls `map.setProjection(...)`, which re-projects
 * the existing layers and resets the view.
 *
 * On top of the base map (ocean, graticule, land) it adds GeoJSON feature layers:
 * a fine grid of cells clipped to land (many small polygons), a demo region
 * polygon, a route line, and city points. The "Features" toggle flags those layers
 * `hideOnInteraction`, so while you rotate (or zoom/pan) only the cheap land
 * re-projects per frame and the dense features reappear when the gesture ends.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const world = loadWorld();
  const graticule = makeGraticule();
  const cells = centreCells();
  const cities = makeCities();
  const route = makeRoute();
  const region = makeDemoPolygon();
  const fit = (name: string): GeoProjection =>
    fitProjection((PROJECTIONS[name] ?? PROJECTIONS[DEFAULT]!).create(), { type: "Sphere" }, width, height);

  const map = geoMap(host, { width, height, projection: fit(DEFAULT), backend });
  map.layer("ocean", [world.sphere], { fill: OCEAN });
  map.layer("graticule", [graticule], { stroke: GRATICULE, lineWidth: 0.5 });
  map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.5 });

  return {
    engine: map,
    // Switch projection on the existing map (re-projects layers, resets the view),
    // (re)declare the feature layers with the current hide-on-interaction flag, then
    // enable the interaction the projection calls for.
    render: (options) => {
      const name = (options.projection as string) ?? DEFAULT;
      const hideFeatures = ((options.features as string) ?? "show") !== "show";

      map.setProjection(fit(name));
      map.layer("cells", cells.map((c) => c.geometry), {
        id: (_g, i) => cells[i]!.id,
        fill: (_g, i) => heat(cells[i]!.value),
        clipTo: "land", // clip the grid to the land outline
        hideOnInteraction: hideFeatures,
      });
      map.layer("region", [region], { fill: "#9bd1a466", stroke: "#3b8c4e", lineWidth: 1, hideOnInteraction: hideFeatures });
      map.layer("route", [route], { stroke: "#e8932f", lineWidth: 1.5, hideOnInteraction: hideFeatures });
      map.layer("cities", cities.map((c) => c.geometry), {
        id: (_g, i) => cities[i]!.id,
        fill: "#e23b2f",
        pointRadius: 3.5,
        hideOnInteraction: hideFeatures,
      });

      // One call for every projection: the engine auto-dispatches versor rotation for
      // spherical projections (GPU-accelerated globe on WebGL) and affine pan/zoom for flat.
      map.enableZoom([1, 8]);
      map.render();
    },
  };
};
