import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness wrapper: a mammal phylogeny with Fitch-parsimony ancestral-range pies. */
export default function AncestralRanges() {
  return (
    <Example
      controls={[
        { key: "layout", label: "Layout", options: ["radial", "rectangular"] },
        { key: "curve", label: "Links", options: ["linear", "step", "bump"] },
        { key: "coords", label: "Coords", options: ["screen", "world"] },
        {
          type: "range",
          key: "tips",
          label: "Tips",
          min: 5,
          max: 14,
          step: 1,
          value: 8,
          display: ["32", "64", "128", "256", "512", "1024", "2048", "4096", "8192", "16384"],
        },
      ]}
      defaults={{ curve: "bump", coords: "world" }}
      width={900}
      height={620}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
