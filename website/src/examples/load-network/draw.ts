import { network, buildGraph, parseNetwork } from "@mapequation/d3gl/network";
import { LabelLayer, type LabelAnchor } from "@mapequation/d3gl/labels";
import type { ImperativeSetup } from "../types.js";
import { makeControls } from "./controls.js";
import { SAMPLE_PAJEK } from "./data.js";

// Remember the last document module-side so the harness's resize-driven setup() re-run reloads it.
let loaded = { text: SAMPLE_PAJEK, name: "sample.net" };

/**
 * Load a network from a file and render it with the `network()` engine. `parseNetwork` dispatches
 * on the filename — `.net` → Pajek (vertex labels, `*Arcs`/`*Edges`), anything else → the plain
 * edge-list parser (`source target [weight]`, `#` comments). The off-thread worker lays it out;
 * once it settles, vertex labels are placed beside the nodes with the HTML `LabelLayer` overlay and
 * kept aligned with the GPU geometry as you pan/zoom. Pick a file, or load a built-in sample.
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });

  // HTML label overlay above the canvas (the harness positions `host` relative).
  const labelEl = document.createElement("div");
  labelEl.className = "absolute inset-0 overflow-hidden pointer-events-none text-[11px] font-medium text-[#334]";
  host.appendChild(labelEl);
  const labels = new LabelLayer(labelEl, (a) => a.text);

  let anchors: LabelAnchor[] = [];
  let view = { k: 1, x: 0, y: 0 };
  const drawLabels = (t = view): void => {
    view = t;
    labels.update(anchors, t, { width, height });
  };
  net.enableZoom([0.1, 8], drawLabels); // scroll to zoom, drag to pan; labels follow the transform

  let token = 0;
  let disposed = false;
  const load = async (text: string, filename: string): Promise<void> => {
    loaded = { text, name: filename };
    const mine = ++token;
    const { nodeCount, source, target, weight, labels: names, directed } = parseNetwork(text, filename);
    anchors = [];
    const graph = buildGraph({ nodeCount, source, target, weight, directed });
    net
      .data(graph)
      .style({ directed, nodeRadius: 5, nodeFill: "#4878d0", linkWidth: 1, linkStroke: "#cbd5e6", arrowFill: "#9aa7bd" })
      .layout({ backend: "worker", iterations: 300 });

    await net.whenSettled();
    if (disposed || mine !== token) return; // a newer load (or teardown) superseded this one
    anchors = names.map((label, i): LabelAnchor => ({
      id: i,
      refX: graph.positions[i * 2]!,
      refY: graph.positions[i * 2 + 1]!,
      text: label,
      offset: [7, -4],
    }));
    drawLabels();
  };

  host.appendChild(makeControls(load));
  void load(loaded.text, loaded.name);

  return {
    engine: net,
    dispose: () => {
      disposed = true;
      labels.destroy();
    },
  };
};
