import { geoEquirectangular } from "d3-geo";
import { geoMap, type LayerHandle } from "@mapequation/d3gl/map";
import {
  loadWorld,
  makeStreamingPoints,
  DEFAULT_STREAM_COLOR,
  type StreamPoint,
} from "../shared/geo-data.js";
import { StreamController, randomHsl, DATA_SIZE_TOTALS, ADAPTIVE_SEED_BATCH } from "../shared/streaming.js";
import { createStatsOverlay } from "../shared/stats-overlay.js";
import type { ImperativeSetup } from "../types.js";

const OCEAN = "#dbe7f3";
const LAND = "#e9e7df";

/**
 * Stream points (clustered around cities + rivers) using the pass-through path
 * (`passThrough: true`). The engine re-reads `() => retained` each repaint so the
 * full point set re-projects on pan/zoom — flat GPU memory, no retained ceiling.
 * New batches are also drawn immediately via `points.append(batch)`.
 *
 * Contrast with the `streaming-points` example (retained path): that example caps
 * at ~4–16M and builds a hit index; this one is uncapped, not pickable, and shows
 * a slightly stale raster during pan/zoom (re-crisps on settle).
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
    // pass-through layers are not pickable (no hit index); no id/clipTo needed
  };
  // passThrough: true — engine re-invokes `() => retained` each repaint (pan/zoom)
  let points: LayerHandle<StreamPoint> = map.layer("points", () => retained, { passThrough: true, ...pointOpts });
  map.render();

  const stats = createStatsOverlay(host);
  let count = 0; // records appended this session
  let appendMs = 0; // total time spent in append() — gives the average speed

  let seed = 1;
  let total = DATA_SIZE_TOTALS[String(options.size)] ?? 10_000_000;
  const ctrl = new StreamController<StreamPoint>({
    source: (o) => makeStreamingPoints({ total, ...o }),
    onBatch: (batch) => {
      for (const f of batch) {
        f.properties.color = currentColor; // new points get the current color
        retained.push(f); // retain for repaint via the callback — loop (not spread) for large batches
      }
      const t0 = performance.now();
      points.append(batch); // incremental draw — only the new batch projects immediately
      appendMs += performance.now() - t0;
      count += batch.length;
      stats.update(count, total, count / (appendMs / 1000), ctrl.batchSize);
    },
    onReset: () => {
      retained.length = 0;
      count = 0;
      appendMs = 0;
      // Re-register the layer (clears the pass-through buffer); callback still points at retained
      points = map.layer("points", () => retained, { passThrough: true, ...pointOpts });
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
    engine: map,
    render: (o) => {
      userRunning = o.stream === "run";
      ctrl.setRunning(userRunning && visible);
      if (o.randomize !== lastRandomize) {
        lastRandomize = Number(o.randomize) || 0;
        currentColor = randomHsl(); // future points...
        for (const f of retained) f.properties.color = currentColor; // ...and already-stored ones
        points.recolor(); // re-render from the retained, updated properties
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
