import { plot, type LayerHandle } from "@mapequation/d3gl/map";
import { makeStreamingPoints, DEFAULT_STREAM_COLOR, type StreamPoint } from "../shared/geo-data.js";
import { StreamController, randomHsl, DATA_SIZE_TOTALS, ADAPTIVE_SEED_BATCH } from "../shared/streaming.js";
import { createStatsOverlay } from "../shared/stats-overlay.js";
import type { ImperativeSetup } from "../types.js";

/**
 * The same streaming point source as the world-map example, but plotted on a
 * scatter chart: x = longitude, y = −latitude (so north is up). Reusing
 * `makeStreamingPoints` shows `Plot.points().append()` is the same incremental
 * append as the map's `GeoMap.layer().append()`. Points start red; "Randomize
 * colors" recolors future + retained points.
 */
export const setup: ImperativeSetup = (host, { width, height, backend, options }) => {
  const chart = plot(host, { width, height, backend });
  // Fit lon∈[-180,180], lat∈[-90,90] into the canvas (x=lon, y=−lat, 0,0 centered).
  const k = Math.min(width / 360, height / 180) * 0.92;
  chart.setTransform({ k, x: width / 2, y: height / 2 });
  chart.enableZoom([0.5, 40]);

  const retained: StreamPoint[] = [];
  let currentColor = DEFAULT_STREAM_COLOR;
  const pointOpts = {
    x: (f: StreamPoint) => f.geometry.coordinates[0], // longitude
    y: (f: StreamPoint) => -f.geometry.coordinates[1], // −latitude (north up)
    radius: 1,
    fill: (f: StreamPoint) => f.properties.color,
    id: (f: StreamPoint) => f.properties.id,
    sizeMode: "screen" as const, // constant 1px dots regardless of zoom
  };
  let points: LayerHandle<StreamPoint> = chart.points("points", [], pointOpts);
  chart.render();

  const stats = createStatsOverlay(host);
  let count = 0;
  let appendMs = 0;

  let seed = 1;
  let total = DATA_SIZE_TOTALS[String(options.size)] ?? 1_000_000;
  const ctrl = new StreamController<StreamPoint>({
    source: (o) => makeStreamingPoints({ total, ...o }),
    onBatch: (batch) => {
      for (const f of batch) {
        f.properties.color = currentColor;
        retained.push(f); // loop, not push(...spread): batch can be up to 1M
      }
      const t0 = performance.now();
      points.append(batch);
      appendMs += performance.now() - t0;
      count += batch.length;
      stats.update(count, total, count / (appendMs / 1000), ctrl.batchSize);
    },
    onReset: () => {
      retained.length = 0;
      count = 0;
      appendMs = 0;
      points = chart.points("points", [], pointOpts);
      stats.update(0, total, 0, ctrl.batchSize, true);
    },
  });
  // "adaptive" auto-tunes the batch to a frame budget; a number fixes it.
  const applyBatch = (opt: string): void => {
    ctrl.adaptive = opt === "adaptive";
    ctrl.batchSize = ctrl.adaptive ? ADAPTIVE_SEED_BATCH : Number(opt);
  };
  // Stream runs only when the user wants it AND the canvas is on-screen (the harness
  // calls setVisible). A manual pause persists across scroll-out/in.
  let visible = true;
  let userRunning = options.stream === "run";
  let lastBatchOpt = String(options.batch);
  applyBatch(lastBatchOpt);
  ctrl.delayMs = Number(options.rate);
  ctrl.setRunning(userRunning && visible);
  ctrl.restart(seed);

  let lastRandomize = Number(options.randomize) || 0;
  let lastRestart = Number(options.restart) || 0;

  return {
    engine: chart,
    render: (o) => {
      userRunning = o.stream === "run";
      ctrl.setRunning(userRunning && visible);
      if (o.randomize !== lastRandomize) {
        lastRandomize = Number(o.randomize) || 0;
        currentColor = randomHsl();
        for (const f of retained) f.properties.color = currentColor;
        points.recolor();
      }
      const batchOpt = String(o.batch);
      const rate = Number(o.rate);
      const newTotal = DATA_SIZE_TOTALS[String(o.size)] ?? total;
      if (
        batchOpt !== lastBatchOpt ||
        rate !== ctrl.delayMs ||
        newTotal !== total ||
        o.restart !== lastRestart
      ) {
        lastRestart = Number(o.restart) || 0;
        lastBatchOpt = batchOpt;
        applyBatch(batchOpt);
        ctrl.delayMs = rate;
        total = newTotal;
        ctrl.restart(++seed);
      }
    },
    setVisible: (v) => {
      visible = v;
      ctrl.setRunning(userRunning && visible); // pause offscreen; resume only if user wants run
    },
    dispose: () => {
      ctrl.dispose();
      stats.destroy();
    },
  };
};
