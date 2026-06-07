import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";
import { BATCH_SIZES, RATES_MS } from "../shared/streaming.js";
import type { ControlSpec } from "../types.js";

const controls: ControlSpec[] = [
  { key: "stream", label: "Stream", options: ["run", "pause"] },
  { type: "select", key: "batch", label: "Batch size", options: BATCH_SIZES, value: "1000" },
  { type: "select", key: "rate", label: "Rate (ms)", options: RATES_MS, value: "0" },
  { type: "button", key: "restart", label: "Restart" },
  { type: "button", key: "randomize", label: "Randomize colors" },
];

/** Streaming random world points, appended live onto an equirectangular map. */
export default function StreamingPoints() {
  return (
    <Example width={720} height={420} controls={controls}>
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
