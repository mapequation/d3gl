import { network, physicalPieWedges, type NetworkHit, type PhysicalPieWedges } from "@mapequation/d3gl/network";
import { scaleSqrt } from "d3-scale";
import { schemeTableau10 } from "d3-scale-chromatic";
import type { ImperativeSetup } from "../types.js";
import { generateStateNetwork, type SyntheticStateNetwork } from "../shared/state-network-data.js";

const NODES = [10, 100, 1_000, 10_000]; // physical node count (see the large-scale example; capped at 10k)
const LABEL_CAPS = [6, 12, 20, 30, 50, 100, Infinity];
const VIEW = { Physical: "physical", State: "state", Both: "both" } as const;
/** An app's own module palette: a colour per module path (here by top module, a shade per sub-module). */
const palette = (path: readonly number[]): string | undefined =>
  path.length ? schemeTableau10[((path[0] ?? 1) - 1) % schemeTableau10.length] : undefined;

/**
 * **State (higher-order / memory) networks — physical / state / both views with overlapping-module pies.**
 *
 * `net.stateNetwork(graph, { modules })` ingests a state network (built by `buildStateGraph`, which also
 * derives the physical network) + a per-state-node module assignment; `net.view(…)` toggles three
 * renderings of the *same* data:
 *
 * - **Physical** — the derived physical network (flow-sized nodes, bent links). A physical node whose
 *   state nodes span several modules is a **pie chart** (a wedge per module, sized by flow); a
 *   single-module node is a plain circle.
 * - **State** — the state graph as an ordinary network with its modules, exactly what
 *   `net.data(stateGraph, { modules })` gives: laid out on its own (**State layout: Nested** lays it out by
 *   module), and `net.lod()` (the **LOD** control) cuts its module tree, with a ring around each open module.
 * - **Both** — state nodes packed **inside** each physical node, at the state view's size (`nodeRadius` and
 *   `sizeMode`), with state-level links: the memory structure in its physical context. Each physical node
 *   encloses its state nodes. Hover, click or drag a physical node: it acts as its state nodes.
 *
 * **Colours** — with no palette, the engine colours modules itself; `style({ moduleColor })` takes your own
 * (a colour per module path) for state nodes, pie wedges and physical nodes in every view, and the
 * pie wedges keep it when `nodeFill` colours the nodes by a metric. **Modules: Off** loads the raw state
 * network (no Infomap yet): the views still switch, without pies. **Lump: On** (`stateNetwork(…, { lump })`,
 * `net.lump(on)`) draws each physical node's state nodes in one leaf module as one node in the State and Both
 * views, as the map equation codes them (with **Modules: Off** every state node is in the root module: a node per
 * physical node); `net.lumped` maps a lump to its physical node and state nodes.
 * A view switch carries the selection over (a physical node ↔ its state nodes), and every hit, selection
 * and label names its `level` ("physical" or "state"), so the tooltip and labels below need no id mapping.
 *
 * The data is synthetic (`state-network-data.ts`): an LFR physical network + node2vec trigrams, node
 * labels `1,2,…` (physical) and `(i,j)` (state). **Each view keeps its own layout** (#495): `layout({ backend })`
 * lays out the view on screen — the physical graph in the Physical and Both views, which share it, the state
 * graph in the State view — with **Force** (main-thread, synchronous), **Worker** (off-thread, progressive) or
 * **GPU** (WebGL2 Barnes-Hut, falling back to Worker when unavailable). A view shown for the first time is laid
 * out with the last options, from where its nodes are (the state nodes start around their physical node), and
 * every view keeps its positions across switches. `fit: true` has the camera **frame the layout** on every
 * backend. Scroll to zoom, drag to pan; dragging a node reheats the layout of the view it is in, and
 * ⌘/Ctrl-drag pans even over a node (#178).
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  // A state-level id names a state node, or while lumped a lump: its physical node's name.
  const stateName = (g: SyntheticStateNetwork, id: number): string | null => {
    const lumped = net.lumped;
    return lumped ? (g.physicalNames[lumped.graph.stateToPhysical[id] ?? -1] ?? null) : (g.stateNames[id] ?? null);
  };
  net.enableZoom([0.05, 60]);

  let data: SyntheticStateNetwork | null = null;
  let wedges: PhysicalPieWedges | null = null; // per-physical module wedges, for the physical-view tooltip
  let builtN = -1;
  let builtBackend = ""; // re-run layout() when the Backend control changes, even without new data
  let builtModules: boolean | null = null;
  let builtNested = false; // the state view's layout: by module (nested) or flat

  // Same interactive options as the directed map of modules: multi-select, node-drag, hover rings — plus
  // a tooltip. In the physical view it shows a node's flow + its module share(s); elsewhere the node label.
  net.interactive({
    selectable: { multi: true },
    draggable: true,
    hover: true,
    tooltip: (datum, id) => {
      if (!data) return null;
      const hit = datum as NetworkHit;
      if (hit.level === "state") return stateName(data, id as number);
      const p = hit.physical ?? (id as number); // a physical node, in the physical or the both view
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
      return data.physicalNames[p] ?? null;
    },
  });

  return {
    engine: net,
    render: (options) => {
      const n = NODES[(options.nodes as number) ?? 1] ?? 100;
      const view = VIEW[(options.view as keyof typeof VIEW) ?? "Physical"] ?? "physical";
      const physical = view === "physical";
      const halfArrow = options.links !== "Line"; // default: half-arrows (the map-of-modules glyph)
      const backend = options.backend === "GPU" ? "gpu" : options.backend === "Worker" ? "worker" : "force";
      const withModules = options.modules !== "Off";
      const nested = withModules && options.stateLayout === "Nested";
      const lump = options.lump === "On";
      const dataChanged = !data || builtN !== n;
      // Backend and Modules also re-load the network and re-lay it out.
      const layoutChanged = dataChanged || builtBackend !== backend || builtModules !== withModules;
      if (dataChanged) {
        data = generateStateNetwork({ nodeCount: n, communityCount: 6, mu: 0.18, avgDegree: 8, seed: 3 });
        wedges = physicalPieWedges(data.graph, data.stateModules); // for the physical-view tooltip
        builtN = n;
      }
      const g = data!;

      let hiFlow = 0;
      for (const f of g.graph.physical.flow!) if (f > hiFlow) hiFlow = f;
      // Without a palette the engine colours modules itself; `moduleColor` gives the app's palette to every view's
      // state nodes, physical nodes and pie wedges (and keeps the pies and physical nodes in it when `nodeFill` colours nodes
      // by a metric).
      // The "both" view draws its state nodes at this nodeRadius and sizeMode, packed in physical nodes that enclose them.
      net.style({
        moduleColor: options.colors === "Palette" ? palette : undefined,
        sizeMode: options.sizing === "World" ? "world" : "screen",
        linkStyle: halfArrow ? "half-arrow" : "line",
        linkBend: 0.15, // fraction of the link's length, for half-arrows and lines alike
        linkStroke: physical ? "rgba(90,110,150,0.5)" : "rgba(120,132,156,0.32)",
        linkWidth: physical ? { by: "weight", scale: scaleSqrt().domain([0, 8]).range([1, 6]).clamp(true) } : 1,
        nodeBorder: view === "both" ? undefined : { width: 1, color: "#000000" },
        nodeRadius: physical ? { by: "flow", scale: scaleSqrt().domain([0, hiFlow]).range([4, 22]) } : 5,
      });

      if (layoutChanged) {
        // fit: true (#238, #427) frames the layout with the camera: as it converges on worker/gpu, once as
        // it lands on force. Opens framed, no top-left flash.
        net.stateNetwork(g.graph, { modules: withModules ? g.stateModules : undefined, view, lump }).layout({ backend, fit: true, nested });
        builtBackend = backend;
        builtModules = withModules;
        builtNested = nested;
      } else {
        net.lump(lump).view(view); // a toggle keeps each view's picture; a view never shown is laid out now
        // The state layout changed: lay out the state view again (the physical graph has no modules to nest).
        if (nested !== builtNested && view === "state") net.layout({ backend, fit: true, nested });
        if (view === "state") builtNested = nested;
      }

      // LOD applies to the state view (its nodes carry the module tree): the engine keeps the request across view
      // switches and draws the physical (every pie) and both views in full. Default Off. "Modules" cuts the state
      // view's module tree — its default, as for any network with modules — with a ring around each open module;
      // "Standard" coarsens the state graph structurally.
      const lodOn = options.lod !== "Off" && (withModules || options.lod !== "Modules");
      net.lod(
        lodOn
          ? {
              source: options.lod === "Modules" ? "modules" : "structure",
              moduleBoundary: options.lod === "Modules" ? {} : undefined,
              // "Auto" (0) ⇒ omitted, i.e. the cut's tree-adaptive default.
              expandPx: (options.expand as number) || undefined,
              maxAggregateRadius: options.maxRadius as number,
              declutter: options.declutter !== "Off",
              crossLevelEdges: options.crossLevel === "On",
              crossFade: ((options.crossFade as number) ?? 0) * 0.1,
            }
          : false,
      );

      // Labels: physical (1,2,…) in the physical + both views, state ((i,j)) in the state + both views.
      // In the both view physical labels sit just outside each physical node (≈1:30); state labels on the state nodes.
      // The built-in label style covers font/colour; `style` thins the default halo a touch.
      const physOn = options.physLabels === "On";
      const stateOn = options.stateLabels === "On";
      const cap = LABEL_CAPS[(options.maxLabels as number) ?? 1] ?? 12;
      const showState = (view === "state" || view === "both") && stateOn;
      const showPhysical = (physical && physOn) || (view === "both" && physOn);
      net.labels(
        showState || showPhysical
          ? {
              style: { textShadow: "0 0 3px #fff, 0 0 3px #fff" },
              max: Number.isFinite(cap) ? cap : undefined,
              // `info.level` names the id's graph: no per-view id mapping in the app.
              labelOf: (id, info) => (info.level === "physical" ? (physOn ? g.physicalNames[id] ?? null : null) : stateOn ? stateName(g, id) : null),
              physical: view === "both" && physOn ? { labelOf: (p) => g.physicalNames[p] ?? null } : undefined,
            }
          : false,
      );
    },
  };
};
