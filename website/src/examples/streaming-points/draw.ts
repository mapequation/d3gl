import { geoEquirectangular } from "d3-geo";
import { geoMap, type LayerHandle } from "@mapequation/d3gl/map";
import { loadWorld, makeStreamingPoints, type StreamPoint } from "../shared/geo-data.js";
import { StreamController, randomHsl } from "../shared/streaming.js";
import type { ImperativeSetup } from "../types.js";

const OCEAN = "#dbe7f3";
const LAND = "#e9e7df";

/**
 * Stream random world points and append them live. Each batch is appended with
 * `layer.append(batch)` — only the NEW points project, the existing ones are
 * untouched. The example also keeps its own `retained` GeoJSON array so the
 * "Randomize colors" button can recolor the data already on screen.
 */
export const setup: ImperativeSetup = (host, { width, height, backend, options }) => {
  const world = loadWorld();
  const projection = geoEquirectangular().fitSize([width, height], { type: "Sphere" });
  const map = geoMap(host, { width, height, projection, backend });
  map.layer("ocean", [world.sphere], { fill: OCEAN });
  map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.4 });
  map.enableZoom([1, 40]);

  const retained: StreamPoint[] = [];
  const pointOpts = {
    fill: (f: StreamPoint) => f.properties.color,
    pointRadius: 1.4,
    id: (f: StreamPoint) => f.properties.id,
  };
  let points: LayerHandle<StreamPoint> = map.layer("points", [], pointOpts);
  map.render();

  let seed = 1;
  const ctrl = new StreamController<StreamPoint>({
    source: (o) => makeStreamingPoints({ total: 10_000_000, ...o }),
    onBatch: (batch) => {
      retained.push(...batch); // retain for redraw / recolor
      points.append(batch); // incremental append — only the new points project
    },
    onReset: () => {
      retained.length = 0;
      points = map.layer("points", [], pointOpts); // re-register empty to clear
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
        points.recolor();
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
