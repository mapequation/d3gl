import { schemeCategory10 } from "d3-scale-chromatic";
import { link as d3link, curveStepBefore } from "d3-shape";
import type { HierarchyPointNode, HierarchyPointLink } from "d3-hierarchy";
import { Plot, Layer, Points } from "@mapequation/d3gl/react";
import Example from "../../components/Example.js";
import { makeTree, type TreeNode } from "../shared/tree.js";
import { layoutRectangular, nodeXY } from "../shared/layout.js";

type PNode = HierarchyPointNode<TreeNode>;
type PLink = HierarchyPointLink<TreeNode>;

// Rectangular step links: a d3-shape link generator drawing straight into the d3gl context.
const gen = d3link<PLink, PNode>(curveStepBefore).x((d) => d.y).y((d) => d.x);

/**
 * The 64-tip rectangular phylogram, written declaratively in React with the
 * `<Plot>` / `<Layer>` / `<Points>` components from `@mapequation/d3gl/react`.
 * The layout is recomputed for the harness-measured `width`/`height`; everything
 * else is pure JSX — no `useEffect`, no DOM, no engine plumbing. `onReady` hands
 * the engine to the harness so it can drive export and backend switching.
 */
export default function PhyloTreeReact() {
  return (
    <Example width={720} height={460}>
      {({ backend, width, height, registerEngine }) => {
        const root = layoutRectangular(makeTree(64), width, height, "linear");
        return (
          <Plot
            width={width}
            height={height}
            backend={backend}
            zoom={[0.5, 40]}
            onReady={registerEngine}
          >
            <Layer
              name="links"
              data={root.links()}
              draw={(ctx, l) => {
                gen.context(ctx);
                gen(l);
              }}
              stroke="#555"
              lineWidth={0.8}
            />
            <Points
              name="nodes"
              data={root.leaves()}
              x={(n) => nodeXY(n, "rectangular")[0]}
              y={(n) => nodeXY(n, "rectangular")[1]}
              radius={2.6}
              fill={(n) => schemeCategory10[n.data.group % 10] ?? "#888"}
            />
          </Plot>
        );
      }}
    </Example>
  );
}
