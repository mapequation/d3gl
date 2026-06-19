import Example from "../../components/Example.js";
import Imperative from "../../components/Imperative.js";
import { setup } from "./draw.js";

const MIN_NODES_EXPONENT = 4;
// Up to 1,048,576 points. Analytic points are ~4 verts each (vs. tens for a tessellated arc
// path), so this scales ~4-40x further than the labelled example before the WebGL buffers get
// heavy. Past ~1M the one-time build dominates and interaction drops below a few fps, so this is
// the practical ceiling for a live demo.
const MAX_NODES_EXPONENT = 20;
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

/** Harness wrapper for the analytic-points declutter scatter: a nodes slider (16…1,048,576) and a
 *  declutter-radius slider (literal `declutter` px, 0 = off). No Labels toggle — this example
 *  drops the HTML label overlay so the glyph cull is the whole story at a million points. Screen-
 *  space sizing only; scroll to zoom (deep range), drag to pan. */
export default function DeclutterPoints() {
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
          value: 14, // 16,384 — a full cloud that still loads instantly
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
      ]}
      width={900}
      height={450}
    >
      {(ctx) => <Imperative ctx={ctx} setup={setup} />}
    </Example>
  );
}
