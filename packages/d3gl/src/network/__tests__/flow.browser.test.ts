import { it, expect } from "vitest";
import { Infomap } from "@mapequation/infomap";
import { randomWalkFlow } from "../flow.js";

/**
 * Cross-check: our JS {@link randomWalkFlow} must reproduce `@mapequation/infomap`'s node visit rate
 * (the C++/WASM reference) for a directed network under the default flow model (unrecorded
 * teleportation, out-strength personalization, dangling spread). Infomap only runs in a browser env,
 * so this lives in the browser suite. If our convention drifts from Infomap, this fails.
 */

// A directed network with reciprocal asymmetry, a hub, and a dangling node (5 has no out-links).
const EDGES: [number, number][] = [
  [1, 2], [2, 1], [2, 3], [3, 1], [1, 4], [4, 1], [3, 4], [4, 2], [2, 5], [3, 5], [1, 3],
];
const N = 5; // node 5 is dangling (only incoming)

async function infomapNodeFlow(): Promise<Map<number, number>> {
  const network = { links: EDGES.map(([source, target]) => ({ source, target, weight: 1 })) };
  const res = await new Infomap().runAsync({ network, args: { directed: true, twoLevel: true, output: "json", silent: true, seed: 1 } });
  const flow = new Map<number, number>();
  for (const node of res.json!.nodes) flow.set(node.id, node.flow ?? 0);
  return flow;
}

it("randomWalkFlow defaults match Infomap's directed node flow to ~1e-5", async () => {
  const im = await infomapNodeFlow();
  const source = EDGES.map((e) => e[0] - 1);
  const target = EDGES.map((e) => e[1] - 1);
  const ref = [1, 2, 3, 4, 5].map((id) => im.get(id) ?? 0);
  const { nodeFlow } = randomWalkFlow({ nodeCount: N, source, target }, { tau: 0.15 });

  let maxDiff = 0;
  for (let i = 0; i < N; i++) maxDiff = Math.max(maxDiff, Math.abs(nodeFlow[i]! - ref[i]!));
  const mine = Array.from(nodeFlow, (x) => x.toFixed(6)).join(",");
  const refStr = ref.map((x) => x.toFixed(6)).join(",");
  expect(maxDiff, `mine=[${mine}] infomap=[${refStr}] maxDiff=${maxDiff.toExponential(3)}`).toBeLessThan(1e-5);
  // Flow is a distribution.
  expect(Array.from(nodeFlow).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
}, 30000);
