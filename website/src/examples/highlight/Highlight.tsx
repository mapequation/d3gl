import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness wrapper: hover-highlight + click-selection on a land-clipped value grid,
 *  with a cell-size slider. */
export default function Highlight() {
  return (
    <Example
      controls={[
        {
          type: "range",
          key: "cells",
          label: "Cell size",
          min: 0,
          max: 3,
          step: 1,
          value: 2,
          display: ["1°", "2°", "4°", "8°"],
        },
      ]}
      width={900}
      height={450}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
