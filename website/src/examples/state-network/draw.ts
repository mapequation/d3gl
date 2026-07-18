import { network, physicalPieWedges, type PhysicalPieWedges } from "@mapequation/d3gl/network";
import { scaleSqrt } from "d3-scale";
import type { ImperativeSetup } from "../types.js";
import { generateStateNetwork, type SyntheticStateNetwork } from "../shared/state-network-data.js";

const NODES = [10, 100, 1_000, 10_000]; // physical node count (see the large-scale example; capped at 10k)
const LABEL_CAPS = [6, 12, 20, 30, 50, 100, Infinity];
const VIEW = { Physical: "physical", State: "state", Both: "both" } as const;

/**
 * **State (higher-order / memory) networks — physical / state / both views with overlapping-module pies.**
 *
 * `net.stateNetwork(graph, { modules })` ingests a state network (built by `buildStateGraph`, which also
 * derives the physical network) + a per-state-node module assignment; `net.view(…)` toggles three
 * renderings of the *same* data:
 *
 * - **Physical** — the derived physical network (flow-sized nodes, bent links). A physical node whose
 *   state nodes span several modules is a **pie chart** (a wedge per module, sized by flow); a
 *   single-module node is a solid disc.
 * - **State** — every state node on a golden-angle **rosette** around its physical node, coloured by
 *   module. `net.lod({ modules })` (the **LOD** control) aggregates the state nodes into their modules.
 * - **Both** — state nodes confined **inside** each physical node's container disc, with state-level
 *   links: the memory structure in its physical context.
 *
 * The data is synthetic (`state-network-data.ts`): an LFR physical network + node2vec trigrams, node
 * labels `1,2,…` (physical) and `(i,j)` (state). `layout({ backend })` lays out the physical graph — **Force**
 * (main-thread, synchronous), **Worker** (off-thread, progressive), or **GPU** (WebGL2 Barnes-Hut,
 * falling back to Worker when unavailable) — and derives the rosette from it each streamed frame (#182);
 * it also **scales the layout to fill the view** once settled, so it opens framed — no fit-transform.
 * Scroll to zoom, drag to pan.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  net.enableZoom([0.05, 60]);

  const labelStyle = document.createElement("style");
  labelStyle.textContent = ".sn-label{font:600 11px/1 system-ui,sans-serif;color:#111827;text-shadow:0 0 3px #fff,0 0 3px #fff}";
  host.appendChild(labelStyle);

  let data: SyntheticStateNetwork | null = null;
  let wedges: PhysicalPieWedges | null = null; // per-physical module wedges, for the physical-view tooltip
  let builtN = -1;
  let builtBackend = ""; // re-run layout() when the Backend control changes, even without new data

  // Same interactive options as the directed map of modules: multi-select, node-drag, hover rings — plus
  // a tooltip. In the physical view it shows a node's flow + its module share(s); elsewhere the node label.
  net.interactive({
    selectable: { multi: true },
    draggable: true,
    hover: true,
    tooltip: (_datum, id) => {
      if (!data) return null;
      const p = id as number;
      if (net.stateView === "physical" && wedges) {
        const flow = data.graph.physical.flow?.[p] ?? 0;
        const rows: string[] = [];
        let prev = 0;
        for (let k = wedges.offset[p]!; k < wedges.offset[p + 1]!; k++) {
          rows.push(`<span style="color:${wedges.color[k]}">■</span> module ${wedges.moduleKey[k]} — ${((wedges.end[k]! - prev) * 100).toFixed(0)}%`);
          prev = wedges.end[k]!;
        }
        const el = document.createElement("div");
        el.innerHTML = `<b>Node ${data.physicalNames[p]}</b> · flow ${flow.toFixed(3)}<br>${rows.join("<br>")}`;
        return el;
      }
      return net.stateView === "physical" ? data.physicalNames[p] ?? null : data.stateNames[p] ?? null;
    },
  });

  return {
    engine: net,
    dispose: () => labelStyle.remove(),
    render: (options) => {
      const n = NODES[(options.nodes as number) ?? 1] ?? 100;
      const view = VIEW[(options.view as keyof typeof VIEW) ?? "Physical"] ?? "physical";
      const physical = view === "physical";
      const halfArrow = options.links !== "Line"; // default: half-arrows (the map-of-modules glyph)
      const backend = options.backend === "GPU" ? "gpu" : options.backend === "Worker" ? "worker" : "force";
      const dataChanged = !data || builtN !== n;
      const layoutChanged = dataChanged || builtBackend !== backend; // Backend control also re-lays out
      if (dataChanged) {
        data = generateStateNetwork({ nodeCount: n, communityCount: 6, mu: 0.18, avgDegree: 8, seed: 3 });
        wedges = physicalPieWedges(data.graph, data.stateModules); // for the physical-view tooltip
        builtN = n;
      }
      const g = data!;

      let hiFlow = 0;
      for (const f of g.graph.physical.flow!) if (f > hiFlow) hiFlow = f;
      // The engine owns nodeFill (module colours) and, in the "both" view, nodeRadius (dots sized to the
      // containers) — so this only sets the shared appearance + the physical/state node size.
      net.style({
        directed: true,
        sizeMode: view === "both" || options.sizing === "World" ? "world" : "screen",
        linkStyle: halfArrow ? "half-arrow" : "line",
        linkBend: halfArrow ? 14 : 0.15, // half-arrow: world-unit bow; line: fraction of chord — both bent
        linkStroke: physical ? "rgba(90,110,150,0.5)" : "rgba(120,132,156,0.32)",
        linkWidth: physical ? { by: "weight", scale: scaleSqrt().domain([0, 8]).range([1, 6]).clamp(true) } : 1,
        nodeBorder: view === "both" ? undefined : { width: 1, color: "#000000" },
        ...(view === "both" ? {} : { nodeRadius: physical ? { by: "flow" as const, scale: scaleSqrt().domain([0, hiFlow]).range([4, 22]) } : 5 }),
      });

      if (layoutChanged) {
        // fit: true (#238) frames the streaming physical layout as it converges (worker/gpu); the
        // synchronous `force` backend ignores it and frames itself. Opens framed, no top-left flash.
        net.stateNetwork(g.graph, { modules: g.stateModules, view }).layout({ backend, fit: true });
        builtBackend = backend;
      } else net.view(view);

      // LOD applies only to the state view (its nodes carry the module tree); default Off. "Modules" cuts
      // on the provided partition; "Standard" coarsens the state graph structurally.
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

      // Labels: physical (1,2,…) in the physical + both views, state ((i,j)) in the state + both views.
      // In the both view physical labels sit just outside each container (≈1:30); state labels on the dots.
      const physOn = options.physLabels === "On";
      const stateOn = options.stateLabels === "On";
      const cap = LABEL_CAPS[(options.maxLabels as number) ?? 1] ?? 12;
      const showState = (view === "state" || view === "both") && stateOn;
      const showPhysical = (physical && physOn) || (view === "both" && physOn);
      net.labels(
        showState || showPhysical
          ? {
              className: "sn-label",
              max: Number.isFinite(cap) ? cap : undefined,
              labelOf: (id) => (physical ? (physOn ? g.physicalNames[id] ?? null : null) : stateOn ? g.stateNames[id] ?? null : null),
              physical: view === "both" && physOn ? { labelOf: (p) => g.physicalNames[p] ?? null } : undefined,
            }
          : false,
      );
    },
  };
};
