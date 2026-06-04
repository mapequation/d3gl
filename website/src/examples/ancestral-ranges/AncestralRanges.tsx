import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness wrapper: a mammal phylogeny with Fitch-parsimony ancestral-range pies. */
export default function AncestralRanges() {
  return (
    <Example
      controls={[
        { key: "layout", label: "Layout", options: ["rectangular", "radial"] },
        { key: "curve", label: "Links", options: ["linear", "step", "bump"] },
        { key: "coords", label: "Coords", options: ["screen", "world"] },
      ]}
      width={900}
      height={620}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
