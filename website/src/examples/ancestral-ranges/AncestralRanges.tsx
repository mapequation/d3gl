import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

const MIN_TIPS_EXPONENT = 5;
const MAX_TIPS_EXPONENT = 16;
const TIPS_LABELS = Array.from(
  { length: MAX_TIPS_EXPONENT - MIN_TIPS_EXPONENT + 1 },
  // Locale thousands grouping (built-in) so e.g. 65536 reads as "65,536".
  (_, i) => (2 ** (i + MIN_TIPS_EXPONENT)).toLocaleString(),
);

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
          min: MIN_TIPS_EXPONENT,
          max: MAX_TIPS_EXPONENT,
          step: 1,
          value: 8,
          display: TIPS_LABELS,
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
