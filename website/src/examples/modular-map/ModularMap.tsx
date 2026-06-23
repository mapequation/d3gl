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
        { type: "segmented", key: "lod", label: "LOD", options: ["Off", "Standard", "Modules"], value: "Modules" },
        { type: "segmented", key: "sizing", label: "Sizing", options: ["Screen", "World"] },
        { type: "segmented", key: "declutter", label: "Declutter", options: ["On", "Off"] },
        { type: "range", key: "expand", label: "Expand", min: 24, max: 400, step: 8, value: 240 },
        { type: "range", key: "maxAgg", label: "Max module", min: 12, max: 48, step: 2, value: 28 },
      ]}
      width={820}
      height={560}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
