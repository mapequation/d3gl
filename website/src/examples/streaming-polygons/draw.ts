import { geoEquirectangular } from "d3-geo";
import { geoMap, type LayerHandle } from "@mapequation/d3gl/map";
import {
  loadWorld,
  makeStreamingPolygons,
  DEFAULT_STREAM_COLOR,
  type StreamPolygon,
} from "../shared/geo-data.js";
import { StreamController, randomHsl, DATA_SIZE_TOTALS } from "../shared/streaming.js";
import type { ImperativeSetup } from "../types.js";

const OCEAN = "#dbe7f3";
const LAND = "#e9e7df";

/**
 * Stream small polygon cells (clustered around cities + rivers) and append them
 * live with `layer.append`. Only new cells project/tessellate per batch; existing
 * ones stay put, clipped to land. All cells start red; "Randomize colors" sets the
 * color for future cells and rewrites + `recolor()`s the retained ones.
 */
export const setup: ImperativeSetup = (host, { width, height, backend, options }) => {
  const world = loadWorld();
  const projection = geoEquirectangular().fitSize([width, height], { type: "Sphere" });
  const map = geoMap(host, { width, height, projection, backend });
  map.layer("ocean", [world.sphere], { fill: OCEAN });
  map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.4 });
  map.enableZoom([1, 40]);

  const retained: StreamPolygon[] = [];
  let currentColor = DEFAULT_STREAM_COLOR;
  const cellOpts = {
    fill: (f: StreamPolygon) => f.properties.color,
    stroke: "#00000022",
    lineWidth: 0.2,
    id: (f: StreamPolygon) => f.properties.id,
    clipTo: "land", // only show cells over land
  };
  let cells: LayerHandle<StreamPolygon> = map.layer("cells", [], cellOpts);
  map.render();

  let seed = 1;
  let total = DATA_SIZE_TOTALS[String(options.size)] ?? 1_000_000;
  const ctrl = new StreamController<StreamPolygon>({
    source: (o) => makeStreamingPolygons({ total, size: 1.5, ...o }),
    onBatch: (batch) => {
      for (const f of batch) f.properties.color = currentColor;
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
        currentColor = randomHsl();
        for (const f of retained) f.properties.color = currentColor;
        cells.recolor();
      }
      const batch = Number(o.batch);
      const rate = Number(o.rate);
      const newTotal = DATA_SIZE_TOTALS[String(o.size)] ?? total;
      if (
        batch !== ctrl.batchSize ||
        rate !== ctrl.delayMs ||
        newTotal !== total ||
        o.restart !== lastRestart
      ) {
        lastRestart = Number(o.restart) || 0;
        ctrl.batchSize = batch;
        ctrl.delayMs = rate;
        total = newTotal;
        ctrl.restart(++seed);
      }
    },
    dispose: () => ctrl.dispose(),
  };
};
