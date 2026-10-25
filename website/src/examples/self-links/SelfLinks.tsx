import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Self-links drawn as loops on a modular weighted network. Toggle directed / undirected, switch the link style and
 *  the sizing mode, bend the links, and tune the loop's spread and length. */
export default function SelfLinks() {
  return (
    <Example
      controls={[
        { type: "segmented", key: "links", label: "Links", options: ["Directed", "Undirected"] },
        { type: "segmented", key: "style", label: "Style", options: ["Half-arrow", "Arrow"], disabled: (o) => o.links === "Undirected" },
        { type: "segmented", key: "sizing", label: "Sizing", options: ["World", "Screen"] },
        { type: "segmented", key: "bend", label: "Bend", options: ["Straight", "Bent"] },
        { type: "range", key: "bendStrength", label: "Bend strength", min: 0.05, max: 0.5, step: 0.05, value: 0.2, disabled: (o) => o.bend === "Straight" },
        { type: "range", key: "loopSpread", label: "Loop spread (°)", min: 10, max: 90, step: 5, value: 25 },
        { type: "range", key: "loopLength", label: "Loop length (radii)", min: 0.5, max: 5, step: 0.25, value: 1 },
      ]}
      width={720}
      height={440}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
