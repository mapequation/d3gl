import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";
import { BATCH_SIZES, RATES_MS, DATA_SIZES } from "../shared/streaming.js";
import type { ControlSpec } from "../types.js";

const controls: ControlSpec[] = [
  { key: "stream", label: "Stream", options: ["run", "pause"] },
  { type: "button", key: "restart", label: "Restart" },
  { type: "select", key: "size", label: "Data size", options: DATA_SIZES, value: "1M" },
  { type: "select", key: "batch", label: "Batch size", options: BATCH_SIZES, value: "adaptive" },
  { type: "select", key: "rate", label: "Batch delay (ms)", options: RATES_MS, value: "0" },
  { type: "button", key: "randomize", label: "Randomize colors" },
];

/** Streaming points on a scatter plot (x = lon, y = −lat), reusing the map source. */
export default function StreamingScatter() {
  return (
    <Example width={720} height={420} controls={controls} defaults={{ backend: "auto" }}>
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
