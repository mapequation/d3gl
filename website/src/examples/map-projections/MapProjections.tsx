import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup, PROJECTION_NAMES } from "./draw.js";
import type { ControlSpec } from "../types.js";

const controls: ControlSpec[] = [
  { type: "select", key: "projection", label: "Projection", options: PROJECTION_NAMES, value: "Orthographic" },
  { key: "features", label: "Features on zoom/rotate", options: ["show", "hide"] },
];

/** Harness wrapper: projection picker + rotatable globe driven by <Example>. */
export default function MapProjections() {
  return (
    <Example width={720} height={480} controls={controls}>
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
