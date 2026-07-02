import { network } from "@mapequation/d3gl/network";
import type { ImperativeSetup } from "../types.js";
import { generateStateNetwork } from "../shared/state-network-data.js";

/**
 * **State (higher-order / memory) networks — physical ↔ state toggle with overlapping-module pies.**
 *
 * A state network's links are between **state nodes**, each belonging to a **physical node** (the same
 * location seen in different memory / context). `net.stateNetwork(graph, { modules })` ingests the state
 * network (built by `buildStateGraph`) plus a per-state-node module assignment, and `net.view(…)` toggles
 * two renderings of the *same* data:
 *
 * - **Physical** — the engine-derived physical network (physical nodes + flow-summed aggregated links).
 *   A physical node whose state nodes span **several modules** renders as a **pie chart** (a wedge per
 *   module, sized by that module's flow), coloured by module; a single-module node is a solid disc.
 * - **State** — every state node placed on a golden-angle **rosette** around its physical node, coloured
 *   by module — so you can see *why* a physical node is split (its memory nodes belong to different
 *   communities).
 *
 * The data is synthetic (see `state-network-data.ts`): an LFR physical network + node2vec trigrams, with
 * each state node's module set to its *previous* node's community — so **bridge** physical nodes overlap
 * modules and become pies. Positions here come from d3gl's in-library force layout of the physical graph +
 * the deterministic rosette (the CPU stopgap until the module-aware GPU `stateLayout` lands). Scroll to
 * zoom, drag to pan; the **View** control flips physical ↔ state.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  const { graph, stateModules } = generateStateNetwork({ nodeCount: 220, communityCount: 6, mu: 0.18, avgDegree: 8, seed: 3 });

  net
    .style({
      sizeMode: "screen",
      nodeRadius: 9,
      nodeBorder: { width: 1, color: "#ffffff" },
      linkStroke: "rgba(120,132,156,0.32)",
      linkWidth: 1,
    })
    .stateNetwork(graph, { modules: stateModules, view: "physical" })
    .layout({ backend: "force" }); // lays out the physical graph + derives the rosette state positions

  // Frame the laid-out network once (both views share this coordinate space), then enable pan/zoom.
  const pos = graph.physical.positions;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let p = 0; p < graph.physicalCount; p++) {
    const x = pos[2 * p]!, y = pos[2 * p + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const k = Math.min(width / (maxX - minX || 1), height / (maxY - minY || 1)) * 0.82;
  net.setTransform({ k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k });
  net.enableZoom([k * 0.3, k * 24]);

  return {
    engine: net,
    render: (options) => net.view(options.view === "State" ? "state" : "physical"),
  };
};
