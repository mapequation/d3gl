import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

const MIN_NODES_EXPONENT = 4;
const MAX_NODES_EXPONENT = 20; // up to 1,048,576 nodes — stress-tests the per-zoom collision pass
const NODES_LABELS = Array.from(
  { length: MAX_NODES_EXPONENT - MIN_NODES_EXPONENT + 1 },
  (_, i) => (2 ** (i + MIN_NODES_EXPONENT)).toLocaleString(),
);

const DECLUTTER_MAX = 60;
const DECLUTTER_STEP = 2;
const DECLUTTER_LABELS = Array.from(
  { length: DECLUTTER_MAX / DECLUTTER_STEP + 1 },
  (_, i) => (i === 0 ? "off" : `${i * DECLUTTER_STEP} px`),
);

/** Harness wrapper for the declutter scatter: a nodes slider (16…1,048,576, to stress the
 *  per-zoom collision pass), a declutter-radius slider whose value is the literal `declutter`
 *  option in pixels (0 = off), and a Labels toggle. Screen-space sizing only, so the collision
 *  story is the whole point — scroll to zoom, drag to pan.
 *
 *  The Labels toggle exists for the high end of the nodes range: d3gl's glyph declutter is an
 *  O(n) spatial-grid pass that scales to ~1M, but the HTML `LabelLayer` reprojects every anchor
 *  on each zoom/pan and is meant for a few hundred labels. Turn Labels OFF to stress-test the
 *  d3gl declutter + GPU path alone at huge node counts; leave it ON to watch both collision
 *  systems together at saner counts. */
export default function Declutter() {
  return (
    <Example
      controls={[
        {
          type: "range",
          key: "nodes",
          label: "Nodes",
          min: MIN_NODES_EXPONENT,
          max: MAX_NODES_EXPONENT,
          step: 1,
          value: 6,
          display: NODES_LABELS,
        },
        {
          type: "range",
          key: "declutter",
          label: "Declutter",
          min: 0,
          max: DECLUTTER_MAX,
          step: DECLUTTER_STEP,
          value: 30,
          display: DECLUTTER_LABELS,
        },
        {
          type: "segmented",
          key: "labels",
          label: "Labels",
          options: ["on", "off"],
        },
      ]}
      width={900}
      height={450}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
