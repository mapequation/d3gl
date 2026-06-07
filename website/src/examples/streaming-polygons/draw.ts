import { geoEquirectangular } from "d3-geo";
import { geoMap, type LayerHandle } from "@mapequation/d3gl/map";
import { loadWorld, makeStreamingPolygons, type StreamPolygon } from "../shared/geo-data.js";
import { StreamController, randomHsl } from "../shared/streaming.js";
import type { ImperativeSetup } from "../types.js";

const OCEAN = "#dbe7f3";
const LAND = "#e9e7df";

/**
 * Stream small random polygon cells and append them live with `layer.append`.
 * Only the new cells are projected/tessellated per batch; existing ones stay put.
 * A retained GeoJSON array backs the "Randomize colors" recolor.
 */
export const setup: ImperativeSetup = (host, { width, height, backend, options }) => {
  const world = loadWorld();
  const projection = geoEquirectangular().fitSize([width, height], { type: "Sphere" });
  const map = geoMap(host, { width, height, projection, backend });
  map.layer("ocean", [world.sphere], { fill: OCEAN });
  map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.4 });
  map.enableZoom([1, 40]);

  const retained: StreamPolygon[] = [];
  const cellOpts = {
    fill: (f: StreamPolygon) => f.properties.color,
    stroke: "#00000022",
    lineWidth: 0.2,
    id: (f: StreamPolygon) => f.properties.id,
  };
  let cells: LayerHandle<StreamPolygon> = map.layer("cells", [], cellOpts);
  map.render();

  let seed = 1;
  const ctrl = new StreamController<StreamPolygon>({
    source: (o) => makeStreamingPolygons({ total: 10_000_000, size: 1.5, ...o }),
    onBatch: (batch) => {
      retained.push(...batch);
      cells.append(batch);
    },
    onReset: () => {
      retained.length = 0;
      cells = map.layer("cells", [], cellOpts);
    },
  });
  ctrl.batchSize = Number(options.batch);
  ctrl.delayMs = Number(options.rate);
  ctrl.setRunning(options.stream === "run");
  ctrl.restart(seed);

  let lastRandomize = Number(options.randomize) || 0;
  let lastRestart = Number(options.restart) || 0;

  return {
    engine: map,
    render: (o) => {
      ctrl.setRunning(o.stream === "run");
      if (o.randomize !== lastRandomize) {
        lastRandomize = Number(o.randomize) || 0;
        for (const f of retained) f.properties.color = randomHsl();
        cells.recolor();
      }
      const batch = Number(o.batch);
      const rate = Number(o.rate);
      if (batch !== ctrl.batchSize || rate !== ctrl.delayMs || o.restart !== lastRestart) {
        lastRestart = Number(o.restart) || 0;
        ctrl.batchSize = batch;
        ctrl.delayMs = rate;
        ctrl.restart(++seed);
      }
    },
    dispose: () => ctrl.dispose(),
  };
};
