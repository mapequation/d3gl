import { geoEquirectangular } from "d3-geo";
import { geoMap, type LayerHandle } from "@mapequation/d3gl/map";
import { loadWorld, makeStreamingPolygons, type StreamPolygon } from "../shared/geo-data.js";
import { StreamController, randomHsl, DATA_SIZE_TOTALS, ADAPTIVE_SEED_BATCH } from "../shared/streaming.js";
import { createStatsOverlay } from "../shared/stats-overlay.js";
import type { ImperativeSetup } from "../types.js";

const OCEAN = "#dbe7f3";
const LAND = "#e9e7df";
const RANGE_ALPHA = 0.05; // very transparent so overlapping ranges build up a density gradient

/**
 * Stream polygon "ranges" using the pass-through path (`passThrough: true`).
 * The engine re-reads `() => retained` on each repaint — so pan/zoom re-projects
 * (and on WebGL re-tessellates) the full set, with no ceiling inside d3gl.
 *
 * Contrast with `streaming-polygons` (retained path): that example supports
 * picking and per-feature recolor; this one is uncapped and not pickable.
 * New batches draw immediately via `cells.append(batch)`; the callback
 * covers full repaints (pan/zoom settle).
 *
 * WebGL re-tessellates the full set on every pan/zoom settle — the documented
 * cost of pass-through for polygon/line geometry. Use a modest data-size default
 * so the demo stays responsive; raise it if you want to test limits.
 */
export const setup: ImperativeSetup = (host, { width, height, backend, options }) => {
  const world = loadWorld();
  const projection = geoEquirectangular().fitSize([width, height], { type: "Sphere" });
  const map = geoMap(host, { width, height, projection, backend });
  map.layer("ocean", [world.sphere], { fill: OCEAN });
  map.layer("land", [world.land], { fill: LAND, stroke: "#9aa3ad", lineWidth: 0.4 });
  map.enableZoom([1, 40]);

  const retained: StreamPolygon[] = [];
  let currentColor = `hsla(8, 80%, 53%, ${RANGE_ALPHA})`; // translucent red; new ranges get this
  const cellOpts = {
    fill: (f: StreamPolygon) => f.properties.color,
    // pass-through layers are not pickable (no hit index); no id/clipTo needed
  };
  // passThrough: true — engine re-invokes `() => retained` each repaint (pan/zoom)
  let cells: LayerHandle<StreamPolygon> = map.layer("cells", () => retained, {
    passThrough: true,
    ...cellOpts,
  });
  map.render();

  const stats = createStatsOverlay(host);
  let count = 0;
  let appendMs = 0;

  let seed = 1;
  let total = DATA_SIZE_TOTALS[String(options.size)] ?? 100_000;
  const ctrl = new StreamController<StreamPolygon>({
    source: (o) => makeStreamingPolygons({ total, ...o }),
    onBatch: (batch) => {
      for (const f of batch) {
        f.properties.color = currentColor; // new polygons get the current color
        retained.push(f); // retain for repaint via the callback — loop (not spread) for large batches
      }
      const t0 = performance.now();
      cells.append(batch); // incremental draw — only the new batch projects/tessellates immediately
      appendMs += performance.now() - t0;
      count += batch.length;
      stats.update(count, total, count / (appendMs / 1000), ctrl.batchSize);
    },
    onReset: () => {
      retained.length = 0;
      count = 0;
      appendMs = 0;
      // Re-register the layer (clears the pass-through buffer); callback still points at retained
      cells = map.layer("cells", () => retained, { passThrough: true, ...cellOpts });
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
        currentColor = randomHsl(RANGE_ALPHA); // keep ranges translucent
        for (const f of retained) f.properties.color = currentColor;
        cells.recolor(); // re-render from the retained, updated properties
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
