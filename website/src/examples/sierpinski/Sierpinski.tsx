import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness for the directed map-of-networks example: a Depth slider (gasket size) and an LOD toggle.
 *  Rendering is WebGL-instanced — flow-border modules + bent half-arrow super-edges; scroll to zoom,
 *  drag to pan, and watch modules expand → sub-modules → leaf triangles. */
export default function Sierpinski() {
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
