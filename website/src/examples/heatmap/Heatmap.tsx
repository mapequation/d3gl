import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

/** Harness wrapper: a land-clipped value grid with a hover read-out and a cell-size slider. */
export default function Heatmap() {
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
