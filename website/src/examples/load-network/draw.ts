import { network, buildGraph, parseNetwork } from "@mapequation/d3gl/network";
import { scaleSqrt } from "d3-scale";
import type { ImperativeSetup } from "../types.js";
import { makeControls } from "./controls.js";
import { SAMPLE_PAJEK } from "./data.js";

// Remember the last document module-side so the harness's resize-driven setup() re-run reloads it.
let loaded = { text: SAMPLE_PAJEK, name: "sample.net" };

/**
 * Load a network from a file and render it with the `network()` engine. `parseNetwork` dispatches
 * on the filename — `.net` → Pajek (vertex labels, `*Arcs`/`*Edges`), anything else → the plain
 * edge-list parser (`source target [weight]`, `#` comments). The off-thread worker lays it out with
 * `layout({ fit: true })`, so it opens **framed** and converges live; nodes are **sized by degree** (a
 * d3 `scaleSqrt`) so hubs stand out. Vertex names are drawn with engine-managed **frontier labels**
 * (`net.labels({ labelOf })`) — they track pan/zoom (and the fit reframe) with no overlay bookkeeping.
 * Pick a file, or load a built-in sample.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  net.enableZoom([0.1, 8]); // scroll to zoom, drag to pan; engine labels follow the transform

  let disposed = false;
  const load = (text: string, filename: string): void => {
    if (disposed) return;
    loaded = { text, name: filename };
    const { nodeCount, source, target, weight, labels: names, directed } = parseNetwork(text, filename);
    const graph = buildGraph({ nodeCount, source, target, weight, directed });
    // Size nodes by degree so hubs stand out: a d3 `scaleSqrt` (area-proportional) over the degree
    // range, handed straight to `nodeRadius` via { by: "degree", scale }. Resolved once, no draw cost.
    let maxDegree = 1;
    for (const d of graph.csr.degree) if (d > maxDegree) maxDegree = d;
    const radius = scaleSqrt().domain([1, maxDegree]).range([4, 16]);
    net
      .data(graph)
      .style({ directed, nodeRadius: { by: "degree", scale: radius }, nodeFill: "#4878d0", linkWidth: 1, linkStroke: "#cbd5e6" })
      // Vertex names as engine-managed frontier labels: `labelOf` maps a node id → its parsed label, and
      // the engine re-places them on every pan/zoom + layout frame — no manual overlay/transform tracking.
      // The built-in label style (dark 11px sans-serif + white halo) covers every backend, export included.
      .labels({ labelOf: (id) => names?.[id] ?? null, offset: [7, -4] })
      // The worker seeds a viewport-centred disc, so this opens framed at k=1 as it converges — no fit
      // needed here (fit is for the solvers that centre elsewhere, e.g. the GPU origin — see network/state).
      .layout({ backend: "worker", iterations: 300 });
  };

  host.appendChild(makeControls(load));
  load(loaded.text, loaded.name);

  return {
    engine: net,
    dispose: () => {
      disposed = true;
    },
  };
};
