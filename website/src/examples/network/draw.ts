import { network, buildGraph, sharedMemoryAvailable, type NodeRadiusSpec, type NetworkGraph, type NetworkHit } from "@mapequation/d3gl/network";
import { scaleSqrt } from "d3-scale";
import type { ImperativeSetup } from "../types.js";
import { generateLFR } from "./data.js";

const SIZES = [10, 100, 1_000, 10_000, 100_000, 1_000_000];

/**
 * Degree-weighted node radius: a d3 `scaleSqrt` (area-proportional) over the graph's degree range,
 * handed to `nodeRadius` as `{ by: "degree", scale }`. Resolved once per style() — varying per-node
 * radius is a per-instance GPU attribute, so this costs nothing at draw time, even at 1M nodes.
 */
function degreeRadius(graph: NetworkGraph): NodeRadiusSpec {
  let lo = Infinity;
  let hi = 0;
  for (const d of graph.csr.degree) {
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  if (hi <= lo) return 6; // uniform degree (e.g. a single clique) — nothing to scale
  return { by: "degree", scale: scaleSqrt().domain([lo, hi]).range([3, 13]) };
}

/**
 * An **LFR benchmark network** (power-law degrees + power-law communities with a mixing parameter —
 * the standard community-detection benchmark) rendered with the `network()` engine: nodes as
 * GPU-instanced points, links as instanced lines, triangle arrowheads for directed edges. Node
 * positions come from d3gl's in-library **force layout** (Barnes-Hut), seeded by **multilevel
 * coarsening** — no coordinates are supplied. `layout({ backend: "worker" })` runs the whole solve in
 * a Web Worker and streams positions back, so the layout **converges progressively on screen** while
 * the UI stays responsive. The Nodes slider scales 10 → 1,000,000; **Node size** switches a uniform
 * vs **degree-weighted** radius; **Edge size** switches uniform vs **weight-scaled** links (LOD
 * super-edges thicken + darken with their accumulated weight); **Sizing** switches world vs **screen**
 * (constant-pixel) glyphs. The
 * **LOD** toggle enables the adaptive hierarchy cut — dense communities collapse to aggregate glyphs
 * and expand into their members as you zoom in — with **Declutter** (thin overlaps). Pair LOD with
 * screen sizing. **Edges** "Off" renders the network as **nodes only** via `style({ linkStyle: "none" })`
 * — with LOD on or off — and the link, arrowhead and super-edge geometry is then never built or
 * uploaded (not merely hidden), so switching it off on a million-edge graph *saves* work rather than
 * costing it. The edges keep driving the layout, so toggling back is instant. Drag empty space to pan,
 * scroll to zoom.
 * **Hover or click** a glyph to resolve the node — or the module it collapsed into — shown top-left.
 * **Selecting** a node dims the rest of the graph (the `selection.others` focus, consistent with GeoMap
 * + Plot) while keeping the selected node *and its outgoing links* at full strength; **hovering** a node
 * recolours its outgoing links red (and, via `hover: { others }`, fades the rest). The highlight is applied
 * in the GPU shader, so it stays instant even with LOD off on a million-node layout.
 * **Drag a node or a collapsed module** to move it: it tracks the cursor with no lag while the off-thread
 * worker layout reheats around it and re-cools on release (grab a module to drag its whole subtree).
 * **Backend** switches the force solve between `"worker"` (CPU Barnes-Hut in a Web Worker) and `"gpu"`
 * (WebGL2 Barnes-Hut grid-pyramid, with automatic fallback to `"worker"` when float render targets are unavailable).
 */
export const setup: ImperativeSetup = (host, { width, height, backend }) => {
  const net = network(host, { width, height, backend });
  net.enableZoom([0.002, 200]); // wide range: zoom right out to the aggregate map, in to single nodes
  // Node-drag (#140): grab a node or a collapsed module and drag it — it tracks the cursor with no lag
  // while the off-thread worker layout **reheats** around it and re-cools on release. Grab a selected
  // node to drag the whole selection; grab a module aggregate to drag its whole subtree. Plain drag on
  // empty space still pans. Hover/click also light a ring via the same interactive() opt-in.
  // #162: the selection/hover highlight is applied in the GPU shader from per-instance flags + uniforms,
  // so hovering across a million-node LOD-off layout is a uniform change — no per-hover geometry rebuild.
  // `selection.others` (set explicitly here, though 0.3 is the default) dims the rest of the graph on
  // selection while the selected node + its outgoing links stay full; `hover: { others }` opts into the
  // same fade on hover. Highlight colour is red (rings + link recolour); the recolour preserves link weight.
  net.interactive({
    selectable: { multi: true },
    draggable: true,
    selection: { others: { opacity: 0.3 } },
    hover: { others: { opacity: 0.5 } }, // enable hover + fade the rest on hover (mirrors selection.others)
  });

  // Picking (#105 N7a): hover/click resolve the node or aggregate under the cursor via the engine's
  // CPU hit-test over the LOD cut frontier — bounded by the visible set, so it stays cheap at 1M. The
  // same on("hover"/"click") API the GeoMap/Plot examples use; network just teaches pick() to see the
  // instanced glyphs. Shown in a small overlay so the resolution is visible (no GPU readback needed).
  const readout = document.createElement("div");
  readout.className = "absolute top-2 left-2 pointer-events-none rounded bg-white/85 px-2 py-1 font-mono text-[12px] leading-tight text-[#333]";
  const describe = (hit: { id: string | number; datum: unknown } | null): string => {
    if (!hit) return "hover a node or module";
    const d = hit.datum as NetworkHit;
    return d.aggregate ? `module · ${d.count.toLocaleString()} nodes` : `node ${hit.id}`;
  };
  readout.textContent = describe(null);
  host.appendChild(readout);
  net.on("hover", (hit) => { readout.textContent = describe(hit); });
  net.on("click", (hit) => { if (hit) readout.textContent = `clicked ${describe(hit)}`; });

  // Transport readout (#163 + N8): three signals — layout transport (gpu / shared / copy / none),
  // the environment's SAB *capability* (`sharedMemoryAvailable()`), and whether SAB is *in use*.
  // For a `backend:"gpu"` layout the transport resolves asynchronously (it is "copy" until the
  // device promise settles), so we also refresh it after the layout settles.
  const sab = document.createElement("div");
  sab.className =
    "absolute top-2 right-2 pointer-events-none rounded bg-white/85 px-2 py-1 font-mono text-[11px] leading-tight [font-variant-numeric:tabular-nums]";
  host.appendChild(sab);
  const yesNo = (b: boolean): string => (b ? "yes" : "no");
  const updateSab = (): void => {
    const transport = net.layoutTransport;
    const supported = sharedMemoryAvailable();
    const inUse = transport === "shared";
    const isGpu = transport === "gpu";
    sab.style.color = isGpu ? "#7c3aed" : inUse ? "#1a7f37" : supported ? "#9a6700" : "#8a8a8a";
    sab.innerHTML =
      `<span title="Active layout transport: gpu = WebGL GPU path; shared = CPU worker, zero-copy SharedArrayBuffer; copy = CPU worker, per-frame postMessage snapshots; none = no layout running.">layout: <b>${transport}</b></span><br>` +
      `<span title="Environment capability: SharedArrayBuffer needs a cross-origin-isolated page (COOP: same-origin + COEP: require-corp). Set on the dev/preview server; GitHub Pages can't send these headers — see issue #163.">SAB supported: <b>${yesNo(supported)}</b></span><br>` +
      `<span title="Actual SAB transport of the running worker layout: yes = positions stream zero-copy through a SharedArrayBuffer; no = posted as per-frame snapshots (also when the worker fell back to a synchronous solve).">SAB in use: <b>${yesNo(inUse)}</b></span>`;
  };
  updateSab();

  // Regenerate + re-lay-out only when a graph/layout input changes (nodes / links / seeding / backend);
  // the cosmetic controls below just re-style, so toggling e.g. Declutter keeps your pan/zoom. `fit: true`
  // frames each fresh layout as it converges — otherwise the GPU backend opens at the origin (top-left).
  let layoutKey = "";
  let graph: NetworkGraph | null = null;

  return {
    engine: net,
    render: (options) => {
      const count = SIZES[(options.nodes as number) ?? 1] ?? 100;
      const directed = options.mode !== "Undirected";
      // "Cold" disables multilevel seeding so you can watch the difference: multilevel snaps to a
      // good global arrangement then settles; cold starts from a disc and untangles slowly.
      const multilevel = options.seeding !== "Cold";
      const layoutBackend = options.backend === "GPU" ? "gpu" : "worker";
      const key = `${count}|${directed}|${multilevel}|${layoutBackend}`;
      if (key !== layoutKey) {
        layoutKey = key;
        // Scale per-tick work down as the graph grows so the off-thread solve stays responsive; the
        // worker keeps the main thread free regardless, streaming frames as it converges.
        const iterations = Math.min(250, Math.max(10, Math.round(2.5e6 / count)));
        // LFR benchmark with clear community structure (low mixing) for the layout + LOD to resolve.
        // Weighted so links vary and LOD super-edges thicken/darken with their accumulated weight.
        const { nodeCount, source, target, weight } = generateLFR(count, { mu: 0.1, seed: 1, weighted: true });
        graph = buildGraph({ nodeCount, source, target, weight, directed });
        // fit: true (#238) keeps the camera framed on the streaming layout as it converges, released on
        // settle/interaction — so it opens framed rather than piling at the origin on the GPU backend.
        net.data(graph).layout({ backend: layoutBackend, iterations, multilevel, fit: true });
        updateSab(); // immediate snapshot (gpu transport resolves async; whenSettled() refreshes it)
        void net.whenSettled().then(updateSab); // refresh once the resolved transport is known
      }
      if (!graph) return;

      // The raw graph is unweighted (every edge weight 1); the per-edge "weight" that varies is the
      // **accumulated flow of an LOD super-edge**. Encode it in both width and colour so a heavier
      // super-edge reads as thicker AND darker (the same scale applies to each edge's weight, so a
      // super-edge uses its summed weight). Width follows the Edge-size toggle; colour always encodes it.
      const edgeWidth =
        options.edge === "Uniform"
          ? 0.8
          : { by: "weight" as const, scale: scaleSqrt().domain([1, 25]).range([0.5, 5]).clamp(true) };
      // Colour by weight via a d3 colour scale: light/translucent at weight 1 → darker/opaque with
      // accumulated super-edge weight (scaleSqrt interpolates the RGBA range, alpha included).
      const linkStroke = {
        by: "weight" as const,
        scale: scaleSqrt<string>().domain([1, 25]).range(["rgba(150,165,205,0.3)", "rgba(65,95,150,0.85)"]).clamp(true),
      };

      net
        .style({
          directed,
          nodeRadius: options.size === "Uniform" ? 5 : degreeRadius(graph),
          nodeFill: "#4878d0",
          // Edges "Off" → a nodes-only network: `linkStyle: "none"` skips *building and uploading* the
          // link/arrowhead/super-edge geometry (with LOD on or off), rather than drawing it invisibly.
          linkStyle: options.edges === "Off" ? "none" : "line",
          linkWidth: edgeWidth, // Edge size: Uniform (0.8) or ∝ √weight in [0.5, 5]
          linkStroke, // darker + more opaque with accumulated weight (arrowhead shares it)
          // arrowSize left unset → defaults to a function of link width (≈ the half-arrow tip).
          // "Screen" keeps glyphs a constant pixel size while you zoom (they don't vanish when
          // zoomed out) — the natural register for navigating a large layout, and what LOD wants.
          sizeMode: options.coords === "Screen" ? "screen" : "world",
        })
        // Enable the adaptive cut: aggregates draw a touch lighter than leaves, capped at 26px so
        // big collapsed clusters stay readable in screen mode. Frontier declutter thins overlapping
        // glyphs by importance. The cut tracks the layout as it converges and re-cuts on zoom.
        // Configured *before* layout() so the worker builds + streams the LOD tree itself (#103) —
        // the main thread then never coarsens or runs the O(N) geometry pass, only the O(visible) cut.
        .lod(
          options.lod === "On"
            ? {
                expandPx: 48,
                aggregateFill: "#7f97c8",
                maxAggregateRadius: 26,
                declutter: options.declutter !== "Off",
                // superEdges stays on: the Edges toggle now removes *all* links via linkStyle above,
                // so it works with LOD off too (`superEdges` only ever governed aggregate↔aggregate links).
                // Opt-in #139: also link a visible leaf to a still-collapsed module across a mixed frontier.
                crossLevelEdges: options.crossLevel === "On",
                // Opt-in #133: ease aggregates ↔ children across the expand threshold (slider × 0.1 = band).
                crossFade: ((options.crossFade as number) ?? 0) * 0.1,
              }
            : false,
        );
    },
  };
};
