import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

const MIN_POINTS_EXPONENT = 5;
const MAX_POINTS_EXPONENT = 20;
const POINTS_LABELS = Array.from(
  { length: MAX_POINTS_EXPONENT - MIN_POINTS_EXPONENT + 1 },
  // Locale thousands grouping (built-in) so e.g. 1048576 reads as "1,048,576".
  (_, i) => (2 ** (i + MIN_POINTS_EXPONENT)).toLocaleString(),
);

/** Harness wrapper: a hover/selection stress test on a `plot` scatter — a points slider
 *  (32…~1M) plus the same world/screen coords toggle as the ancestral-ranges example. */
export default function ScatterStress() {
  return (
    <Example
      controls={[
        {
          type: "range",
          key: "points",
          label: "Points",
          min: MIN_POINTS_EXPONENT,
          max: MAX_POINTS_EXPONENT,
          step: 1,
          value: 10,
          display: POINTS_LABELS,
        },
        { key: "coords", label: "Coords", options: ["screen", "world"] },
      ]}
      defaults={{ coords: "world" }}
      width={900}
      height={450}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
