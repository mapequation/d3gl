import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** A directed map of modules (LFR planted partition + Infomap-matched flow): categorical module
 *  colours, flow-sized nodes, and half-arrow links/super-edges that thicken with flow. The LOD control
 *  switches Off / Standard (structural) / Modules (the planted partition → half-arrow super-edges). */
export default function ModularMap() {
  return (
    <Example
      controls={[
        {
          type: "range",
          key: "nodes",
          label: "Nodes",
          min: 0,
          max: 5,
          step: 1,
          value: 1, // 1k — a good default; crank up to stress the module-aware GPU layout
          display: ["500", "1k", "2k", "5k", "10k", "20k"],
        },
        { type: "segmented", key: "lod", label: "LOD", options: ["Off", "Standard", "Modules"], value: "Modules" },
        { type: "segmented", key: "sizing", label: "Sizing", options: ["Screen", "World"] },
        { type: "segmented", key: "declutter", label: "Declutter", options: ["On", "Off"] },
        // 0 = "Auto": no expandPx at all, i.e. the library's tree-adaptive default (#191).
        { type: "range", key: "expand", label: "Expand", min: 0, max: 500, step: 8, value: 0, display: ["Auto"] },
        { type: "range", key: "maxRadius", label: "Max radius", min: 12, max: 40, step: 1, value: 18 },
        {
          type: "range",
          key: "maxLabels",
          label: "Labels",
          min: 0,
          max: 6,
          step: 1,
          value: 1, // index into LABEL_CAPS in draw.ts → 12; last position = "All" (no limit)
          display: ["6", "12", "20", "30", "50", "100", "All"],
        },
        { type: "segmented", key: "crossLevel", label: "Cross-level edges", options: ["Off", "On"], value: "On" },
        {
          type: "range",
          key: "crossFade",
          label: "Cross-fade",
          min: 0,
          max: 6,
          step: 1,
          value: 2, // 0.2 — fade modules ↔ sub-members across the expand threshold
          display: ["Off", "0.1", "0.2", "0.3", "0.4", "0.5", "0.6"],
        },
      ]}
      width={820}
      height={560}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
