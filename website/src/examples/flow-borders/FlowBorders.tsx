import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** The flow-border + half-arrow glyph style on a two-node network (no LOD). Switch backend
 *  (WebGL / Canvas / SVG), drag Bend, and flip Sizing (World/Screen) — in screen mode the link
 *  decorations stay a constant pixel size as you zoom while the nodes still move (WebGL lane). */
export default function FlowBorders() {
  return (
    <Example
      controls={[
        {
          type: "range",
          key: "bend",
          label: "Bend",
          min: 0,
          max: 4,
          step: 1,
          value: 2,
          display: ["0", "15", "30", "45", "60"],
        },
        { type: "segmented", key: "sizing", label: "Sizing", options: ["World", "Screen"] },
      ]}
      width={720}
      height={440}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
