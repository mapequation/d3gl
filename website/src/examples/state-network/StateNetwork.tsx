import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** True unless the State view is active — the LOD cut (and its sub-controls) only apply there. */
const notState = (o: Record<string, unknown>) => o.view !== "State";

/** Harness for the state-network example: **Nodes** (physical count, up to 10k), a **Backend** toggle
 *  (Force / Worker / GPU — #182) for the physical layout, a **View** toggle (Physical pies / State
 *  rosette / Both), a **Links** toggle (half-arrow / line, both bent), **Physical** / **State** label
 *  toggles, and the "directed map of modules" option set. The LOD cut only applies to the State view, so
 *  LOD + its sub-controls are **disabled** (greyed, no reflow) in the other views. */
export default function StateNetwork() {
  return (
    <Example
      controls={[
        { type: "range", key: "nodes", label: "Nodes", min: 0, max: 3, step: 1, value: 1, display: ["10", "100", "1,000", "10,000"] },
        { type: "segmented", key: "backend", label: "Backend", options: ["Force", "Worker", "GPU"] },
        { type: "segmented", key: "view", label: "View", options: ["Physical", "State", "Both"] },
        { type: "segmented", key: "links", label: "Links", options: ["Half-arrow", "Line"] },
        { type: "segmented", key: "physLabels", label: "Physical labels", options: ["Off", "On"] },
        { type: "segmented", key: "stateLabels", label: "State labels", options: ["Off", "On"] },
        { type: "segmented", key: "sizing", label: "Sizing", options: ["Screen", "World"], disabled: (o) => o.view === "Both" },
        { type: "segmented", key: "lod", label: "LOD", options: ["Off", "Standard", "Modules"], disabled: notState },
        { type: "segmented", key: "declutter", label: "Declutter", options: ["On", "Off"], disabled: notState },
        { type: "range", key: "expand", label: "Expand", min: 24, max: 500, step: 8, value: 240, disabled: notState },
        { type: "range", key: "maxRadius", label: "Max radius", min: 12, max: 40, step: 1, value: 18, disabled: notState },
        {
          type: "range",
          key: "maxLabels",
          label: "Labels",
          min: 0,
          max: 6,
          step: 1,
          value: 1, // index into LABEL_CAPS in draw.ts → 12; last = "All"
          display: ["6", "12", "20", "30", "50", "100", "All"],
        },
        { type: "segmented", key: "crossLevel", label: "Cross-level edges", options: ["Off", "On"], value: "On", disabled: notState },
        { type: "range", key: "crossFade", label: "Cross-fade", min: 0, max: 6, step: 1, value: 2, display: ["Off", "0.1", "0.2", "0.3", "0.4", "0.5", "0.6"], disabled: notState },
      ]}
      width={820}
      height={560}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
