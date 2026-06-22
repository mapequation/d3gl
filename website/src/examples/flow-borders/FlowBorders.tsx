import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** The flow-border + bent half-arrow glyph style on a two-node network (no LOD). Switch backend
 *  (WebGL / Canvas / SVG) — the render is equivalent — export, go fullscreen, zoom, and drag Bend. */
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
          display: ["0", "0.10", "0.18", "0.28", "0.40"],
        },
      ]}
      width={720}
      height={440}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
