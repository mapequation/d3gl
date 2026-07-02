import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness for the state-network example: a **Nodes** slider (physical node count, up to 10k), a **View**
 *  toggle (Physical pies / State rosette / Both — state nodes inside their physical container), and the
 *  "directed map of modules" option set. LOD defaults **Off** and applies only to the State view (its nodes
 *  carry the module tree); the LOD sub-controls (Expand, Max radius, Declutter, Labels, Cross-*) take effect
 *  there. */
export default function StateNetwork() {
  return (
    <Example
      controls={[
        {
          type: "range",
          key: "nodes",
          label: "Nodes",
          min: 0,
          max: 3,
          step: 1,
          value: 1, // 100 physical nodes
          display: ["10", "100", "1,000", "10,000"],
        },
        { type: "segmented", key: "view", label: "View", options: ["Physical", "State", "Both"] },
        { type: "segmented", key: "lod", label: "LOD", options: ["Off", "Standard", "Modules"] }, // default Off
        { type: "segmented", key: "sizing", label: "Sizing", options: ["Screen", "World"] },
        { type: "segmented", key: "declutter", label: "Declutter", options: ["On", "Off"] },
        { type: "range", key: "expand", label: "Expand", min: 24, max: 500, step: 8, value: 240 },
        { type: "range", key: "maxRadius", label: "Max radius", min: 12, max: 40, step: 1, value: 18 },
        {
          type: "range",
          key: "maxLabels",
          label: "Labels",
          min: 0,
          max: 6,
          step: 1,
          value: 1, // index into LABEL_CAPS in draw.ts → 12; last position = "All"
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
          value: 2, // 0.2
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
