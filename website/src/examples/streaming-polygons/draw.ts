import { geoEquirectangular } from "d3-geo";
import { geoMap, type LayerHandle } from "@mapequation/d3gl/map";
import { loadWorld, makeStreamingPolygons, type StreamPolygon } from "../shared/geo-data.js";
import { StreamController, randomHsl, DATA_SIZE_TOTALS } from "../shared/streaming.js";
import { createStatsOverlay } from "../shared/stats-overlay.js";
import type { ImperativeSetup } from "../types.js";

const OCEAN = "#dbe7f3";
const LAND = "#e9e7df";
const RANGE_ALPHA = 0.12; // very transparent so overlapping ranges build up richness
const DEFAULT_RANGE_COLOR = `hsla(8, 80%, 53%, ${RANGE_ALPHA})`; // translucent red

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
  let currentColor = DEFAULT_RANGE_COLOR; // translucent; new ranges get this color
  const cellOpts = {
    fill: (f: StreamPolygon) => f.properties.color,
    id: (f: StreamPolygon) => f.properties.id,
    clipTo: "land", // only show ranges over land
  };
  let cells: LayerHandle<StreamPolygon> = map.layer("cells", [], cellOpts);
  map.render();

  const stats = createStatsOverlay(host);
  let count = 0;
  let appendMs = 0;

  let seed = 1;
  let total = DATA_SIZE_TOTALS[String(options.size)] ?? 1_000_000;
  const ctrl = new StreamController<StreamPolygon>({
    source: (o) => makeStreamingPolygons({ total, ...o }), // large ranges (default size)
    onBatch: (batch) => {
      for (const f of batch) {
        f.properties.color = currentColor;
        retained.push(f); // loop, not push(...spread): batch can be up to 1M
      }
      const t0 = performance.now();
      cells.append(batch);
      appendMs += performance.now() - t0;
      count += batch.length;
      stats.update(count, total, count / (appendMs / 1000));
    },
    onReset: () => {
      retained.length = 0;
      count = 0;
      appendMs = 0;
      cells = map.layer("cells", [], cellOpts);
      stats.update(0, total, 0, true);
    },
  });
  // Stream runs only when the user wants it AND the canvas is on-screen (the harness
  // calls setVisible). A manual pause persists across scroll-out/in.
  let visible = true;
  let userRunning = options.stream === "run";
  ctrl.batchSize = Number(options.batch);
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
