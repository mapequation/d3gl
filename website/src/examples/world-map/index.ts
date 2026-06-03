import { geoNaturalEarth1 } from "d3-geo";
import { geoMap } from "@mapequation/d3gl/map";
import { fitProjection } from "@mapequation/d3gl/geo";
import type { GeoInput } from "@mapequation/d3gl/geo";
import type { ExampleHandle, ExampleOptions } from "../types.js";
import { loadWorld } from "../shared/geo-data.js";

const W = 900, H = 450;
const OCEAN = "#d4e6f5", LAND = "#e7e7e0";

export function mount(el: HTMLElement, opts: ExampleOptions): ExampleHandle {
  const world = loadWorld();
  const projection = fitProjection(geoNaturalEarth1(), { type: "Sphere" } as any, W, H);
  const map = geoMap(el, { width: W, height: H, projection, backend: opts.backend });
  map.layer("ocean", [world.sphere as unknown as GeoInput], { fill: OCEAN });
  map.layer("land", [world.land], { fill: LAND });
  map.render();
  return {
    dispose: () => map.destroy(),
    exportImage: () =>
      opts.backend === "svg" ? { format: "svg", data: map.toSVG() } : { format: "png", data: map.toPNG() },
  };
}
