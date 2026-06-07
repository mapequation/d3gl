import { plot, type LayerHandle } from "@mapequation/d3gl/map";
import { makeStreamingPoints, type StreamPoint } from "../shared/geo-data.js";
import { StreamController, randomHsl } from "../shared/streaming.js";
import type { ImperativeSetup } from "../types.js";

/**
 * The same streaming point source as the world-map example, but plotted on a
 * scatter chart: x = longitude, y = −latitude (so north is up). Reusing
 * `makeStreamingPoints` shows `Plot.points().append()` is the same incremental
 * append as the map's `GeoMap.layer().append()`.
 */
export const setup: ImperativeSetup = (host, { width, height, backend, options }) => {
  const chart = plot(host, { width, height, backend });
  // Fit lon∈[-180,180], lat∈[-90,90] into the canvas (x=lon, y=−lat, 0,0 centered).
  const k = Math.min(width / 360, height / 180) * 0.92;
  chart.setTransform({ k, x: width / 2, y: height / 2 });
  chart.enableZoom([0.5, 40]);

  const retained: StreamPoint[] = [];
  const pointOpts = {
    x: (f: StreamPoint) => f.geometry.coordinates[0], // longitude
    y: (f: StreamPoint) => -f.geometry.coordinates[1], // −latitude (north up)
    radius: 2,
    fill: (f: StreamPoint) => f.properties.color,
    id: (f: StreamPoint) => f.properties.id,
    sizeMode: "screen" as const, // constant 2px dots regardless of zoom
  };
  let points: LayerHandle<StreamPoint> = chart.points("points", [], pointOpts);
  chart.render();

  let seed = 1;
  const ctrl = new StreamController<StreamPoint>({
    source: (o) => makeStreamingPoints({ total: 10_000_000, ...o }),
    onBatch: (batch) => {
      retained.push(...batch);
      points.append(batch);
    },
    onReset: () => {
      retained.length = 0;
      points = chart.points("points", [], pointOpts);
    },
  });
  ctrl.batchSize = Number(options.batch);
  ctrl.delayMs = Number(options.rate);
  ctrl.setRunning(options.stream === "run");
  ctrl.restart(seed);

  let lastRandomize = Number(options.randomize) || 0;
  let lastRestart = Number(options.restart) || 0;

  return {
    engine: chart,
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
