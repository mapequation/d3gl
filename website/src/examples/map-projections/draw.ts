import {
  geoNaturalEarth1, geoEqualEarth, geoMercator, geoTransverseMercator,
  geoEquirectangular, geoConicConformal, geoConicEqualArea, geoConicEquidistant,
  geoAlbers, geoOrthographic, geoStereographic, geoAzimuthalEqualArea,
  geoAzimuthalEquidistant, geoGnomonic, type GeoProjection,
} from "d3-geo";
import { geoMap } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import type { ImperativeSetup } from "../types.js";
import { loadWorld, makeGraticule } from "../shared/geo-data.js";

const OCEAN = "#d4e6f5";
const LAND = "#e3e6ea";
const GRATICULE = "#c2d4e4";

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
 * pan/zoom. Switching projection calls `map.setProjection(...)`, which
 * re-projects the existing layers and resets the view.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const world = loadWorld();
  const graticule = makeGraticule();
  const fit = (name: string): GeoProjection =>
    fitProjection((PROJECTIONS[name] ?? PROJECTIONS[DEFAULT]!).create(), { type: "Sphere" }, width, height);

  const map = geoMap(host, { width, height, projection: fit(DEFAULT), backend });
  map.layer("ocean", [world.sphere], { fill: OCEAN });
  map.layer("graticule", [graticule], { stroke: GRATICULE, lineWidth: 0.5 });
  map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.5 });

  return {
    engine: map,
    // Switch projection on the existing map (re-projects layers, resets the view),
    // then enable the interaction the projection calls for.
    render: (options) => {
      const name = (options.projection as string) ?? DEFAULT;
      const entry = PROJECTIONS[name] ?? PROJECTIONS[DEFAULT]!;
      map.setProjection(fit(name));
      if (entry.spherical) map.enableRotation();
      else map.enableZoom([1, 8]);
      map.render();
    },
  };
};
