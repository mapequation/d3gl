import { network } from "@mapequation/d3gl/network";
import { scaleSqrt } from "d3-scale";
import type { ImperativeSetup } from "../types.js";
import { generateStateNetwork, type SyntheticStateNetwork } from "../shared/state-network-data.js";

const NODES = [10, 100, 1_000, 10_000]; // physical node count (see the large-scale example; capped at 10k)
const LABEL_CAPS = [6, 12, 20, 30, 50, 100, Infinity];
const VIEW = { Physical: "physical", State: "state", Both: "both" } as const;

/**
 * **State (higher-order / memory) networks — physical / state / both views with overlapping-module pies.**
 *
 * A state network's links run between **state nodes**, each belonging to a **physical node** (the same
 * location in different memory / context). `net.stateNetwork(graph, { modules })` ingests it (built by
 * `buildStateGraph`, which also derives the physical network) + a per-state-node module assignment, and
 * `net.view(…)` toggles three renderings of the *same* data:
 *
 * - **Physical** — the derived physical network (flow-sized nodes, half-arrow links). A physical node
 *   whose state nodes span several modules is a **pie chart** (wedge per module, sized by flow); a
 *   single-module node is a solid disc.
 * - **State** — every state node on a golden-angle **rosette** around its physical node, coloured by
 *   module. `net.lod({ modules })` (the **LOD** control) aggregates the state nodes into their modules.
 * - **Both** — state nodes confined **inside** each physical node's container disc, with state-level
 *   links — the memory structure in its physical context.
 *
 * Data is synthetic (`state-network-data.ts`): an LFR physical network + node2vec trigrams, each state
 * node's module set to its *previous* node's community — so bridge physical nodes overlap modules → pies.
 * Positions are the CPU stopgap (in-library force layout of the physical graph + rosette) until the
 * module-aware GPU layout lands. Scroll to zoom, drag to pan.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  net.enableZoom([0.02, 80]);

  // Module-aggregate labels for the state view under LOD (their state-node count).
  const labelStyle = document.createElement("style");
  labelStyle.textContent = ".sn-label{font:600 11px/1 system-ui,sans-serif;color:#1f2937;text-shadow:0 0 3px #fff,0 0 3px #fff}";
  host.appendChild(labelStyle);

  let data: SyntheticStateNetwork | null = null;
  let builtN = -1;

  const fit = (): void => {
    const pos = net.stateView === "physical" ? data!.graph.physical.positions : data!.graph.state.positions;
    const n = net.stateView === "physical" ? data!.graph.physicalCount : data!.graph.state.nodeCount;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[2 * i]!, y = pos[2 * i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const k = Math.min(width / (maxX - minX || 1), height / (maxY - minY || 1)) * 0.8;
    net.setTransform({ k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k });
  };

  return {
    engine: net,
    dispose: () => labelStyle.remove(),
    render: (options) => {
      const n = NODES[(options.nodes as number) ?? 1] ?? 100;
      const view = VIEW[(options.view as keyof typeof VIEW) ?? "Physical"] ?? "physical";
      const physical = view === "physical";
      const world = view === "both" || options.sizing === "World"; // "both" needs world units for containment
      const dataChanged = !data || builtN !== n;
      if (dataChanged) {
        data = generateStateNetwork({ nodeCount: n, communityCount: 6, mu: 0.18, avgDegree: 8, seed: 3 });
        builtN = n;
      }
      const g = data!;

      // Flow-sized nodes + flow-scaled links for the physical "map" view; small uniform glyphs elsewhere.
      const flow = g.graph.physical.flow!;
      let hi = 0;
      for (const f of flow) if (f > hi) hi = f;
      net.style({
        directed: true,
        sizeMode: world ? "world" : "screen",
        linkStyle: physical ? "half-arrow" : "line",
        linkBend: physical ? 0.2 : 0.12,
        nodeRadius: physical ? { by: "flow", scale: scaleSqrt().domain([0, hi]).range([4, 22]) } : view === "both" ? 2.5 : 5,
        nodeBorder: view === "both" ? undefined : { width: 1, color: "#ffffff" },
        linkStroke: physical ? "rgba(90,110,150,0.5)" : "rgba(120,132,156,0.3)",
        linkWidth: physical ? { by: "weight", scale: scaleSqrt().domain([0, 8]).range([1, 6]).clamp(true) } : 1,
      });

      if (dataChanged) {
        net.stateNetwork(g.graph, { modules: g.stateModules, view }).layout({ backend: "force" });
        fit();
      } else {
        net.view(view);
      }

      // LOD is meaningful only in the state view (its nodes carry the module tree); default Off.
      // "Modules" cuts on the provided partition; "Standard" coarsens the state graph structurally.
      const lodOn = view === "state" && options.lod !== "Off";
      net.lod(
        lodOn
          ? {
              modules: options.lod === "Modules" ? g.stateModules : undefined,
              expandPx: options.expand as number,
              maxAggregateRadius: options.maxRadius as number,
              declutter: options.declutter !== "Off",
              crossLevelEdges: options.crossLevel === "On",
              crossFade: ((options.crossFade as number) ?? 0) * 0.1,
            }
          : false,
      );

      // Module-count labels on the state-view LOD frontier (aggregates only), capped by the Labels control.
      const cap = LABEL_CAPS[(options.maxLabels as number) ?? 1] ?? 12;
      net.labels(
        lodOn
          ? { className: "sn-label", max: Number.isFinite(cap) ? cap : undefined, labelOf: (_id, info) => (info.aggregate ? `${info.count}` : null) }
          : false,
      );
    },
  };
};
