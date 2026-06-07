import { geoEquirectangular } from "d3-geo";
import { geoMap, type LayerHandle } from "@mapequation/d3gl/map";
import {
  loadWorld,
  makeStreamingPoints,
  DEFAULT_STREAM_COLOR,
  type StreamPoint,
} from "../shared/geo-data.js";
import { StreamController, randomHsl, DATA_SIZE_TOTALS } from "../shared/streaming.js";
import { createStatsOverlay } from "../shared/stats-overlay.js";
import type { ImperativeSetup } from "../types.js";

const OCEAN = "#dbe7f3";
const LAND = "#e9e7df";

/**
 * Stream points (clustered around cities + rivers) and append them live with
 * `layer.append(batch)` — only the NEW points project; existing ones are
 * untouched and clipped to land. Every feature carries a `color` the example
 * owns: all start red, and "Randomize colors" picks a new color for FUTURE
 * points AND rewrites the retained ones' properties + `recolor()`s them — showing
 * streaming and retained-for-redraw working together.
 */
export const setup: ImperativeSetup = (host, { width, height, backend, options }) => {
  const world = loadWorld();
  const projection = geoEquirectangular().fitSize([width, height], { type: "Sphere" });
  const map = geoMap(host, { width, height, projection, backend });
  map.layer("ocean", [world.sphere], { fill: OCEAN });
  map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.4 });
  map.enableZoom([1, 40]);

  const retained: StreamPoint[] = [];
  let currentColor = DEFAULT_STREAM_COLOR; // the color new points get (until randomized)
  const pointOpts = {
    fill: (f: StreamPoint) => f.properties.color,
    pointRadius: 0.5,
    id: (f: StreamPoint) => f.properties.id,
    clipTo: "land", // only show points over land
  };
  let points: LayerHandle<StreamPoint> = map.layer("points", [], pointOpts);
  map.render();

  const stats = createStatsOverlay(host);
  let count = 0; // records appended this session
  let appendMs = 0; // total time spent in append() — gives the average speed

  let seed = 1;
  let total = DATA_SIZE_TOTALS[String(options.size)] ?? 1_000_000;
  const ctrl = new StreamController<StreamPoint>({
    source: (o) => makeStreamingPoints({ total, ...o }),
    onBatch: (batch) => {
      for (const f of batch) f.properties.color = currentColor; // new points get the current color
      retained.push(...batch); // retain for redraw / recolor
      const t0 = performance.now();
      points.append(batch); // incremental append — only the new points project
      appendMs += performance.now() - t0;
      count += batch.length;
      stats.update(count, total, count / (appendMs / 1000));
    },
    onReset: () => {
      retained.length = 0;
      count = 0;
      appendMs = 0;
      points = map.layer("points", [], pointOpts); // re-register empty to clear
      stats.update(0, total, 0, true);
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
        currentColor = randomHsl(); // future points...
        for (const f of retained) f.properties.color = currentColor; // ...and already-stored ones
        points.recolor(); // re-render from the retained, updated properties
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
    dispose: () => {
      ctrl.dispose();
      stats.destroy();
    },
  };
};
