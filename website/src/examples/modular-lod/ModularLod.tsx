import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness for the modular-LOD example: a Depth slider (gasket size) and an LOD toggle. Nodes are
 *  coloured by top-level module; with LOD on they aggregate into their parent module as you zoom out.
 *  Scroll to zoom, drag to pan. */
export default function ModularLod() {
  return (
    <Example
      controls={[
        {
          type: "range",
          key: "depth",
          label: "Depth",
          min: 0,
          max: 4,
          step: 1,
          value: 2, // depth 4 — 243 nodes
          display: ["27", "81", "243", "729", "2187"],
        },
        { type: "segmented", key: "lod", label: "LOD", options: ["On", "Off"] },
      ]}
      width={760}
      height={520}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
