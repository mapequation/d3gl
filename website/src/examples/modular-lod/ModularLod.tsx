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
        {
          type: "range",
          key: "crossFade",
          label: "Cross-fade",
          min: 0,
          max: 6,
          step: 1,
          value: 0, // off; raise to fade a module ↔ its sub-modules across the expand threshold (#133).
          // The gasket is self-similar (the whole frontier transitions at one level), so there's no
          // mixed-level case — `crossLevelEdges` (#139) has nothing to project across and is omitted here.
          display: ["Off", "0.1", "0.2", "0.3", "0.4", "0.5", "0.6"],
        },
      ]}
      width={760}
      height={520}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
