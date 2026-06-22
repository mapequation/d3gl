/**
 * Offline generator for the modular-map fixture (run with `node generate.ts` — Node strips the types).
 *
 * Builds a deterministic LFR planted-partition network, makes it **directed** by splitting every edge
 * into a reciprocal a→b / b→a pair (so a half-arrow pair has genuinely different flow each way),
 * computes the random-walk **flow** with {@link randomWalkFlow} (cross-checked against Infomap), and
 * derives per-link flow + per-node enter/exit (boundary) flow. The planted communities become a
 * one-level module hierarchy. The result is written to `modular-map.json`, which the example imports —
 * so the browser ships static data, no Infomap/WASM at runtime.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateLFR } from "../network/data.ts";
import { randomWalkFlow } from "../../../../packages/d3gl/src/network/flow.ts";

const N = 500;
const lfr = generateLFR(N, { mu: 0.1, avgDegree: 10, minCommunity: 18, seed: 42 });

// Directed: each undirected edge → a reciprocal pair (weight 1 each).
const src: number[] = [];
const tgt: number[] = [];
for (let e = 0; e < lfr.source.length; e++) {
  const a = lfr.source[e]!;
  const b = lfr.target[e]!;
  src.push(a, b);
  tgt.push(b, a);
}
const source = Uint32Array.from(src);
const target = Uint32Array.from(tgt);

// Authoritative random-walk flow (Infomap convention), then per-link + per-node boundary flow.
const { nodeFlow, linkFlow } = randomWalkFlow({ nodeCount: N, source, target }, { tau: 0.15 });
const enterExit = new Float64Array(N);
for (let e = 0; e < source.length; e++) {
  const a = source[e]!;
  const b = target[e]!;
  if (lfr.community[a] !== lfr.community[b]) {
    enterExit[a] += linkFlow[e]!; // exit flow from a
    enterExit[b] += linkFlow[e]!; // enter flow to b
  }
}

const communities = new Set(Array.from(lfr.community)).size;
const round = (x: number) => Number(x.toPrecision(7));
const fixture = {
  nodeCount: N,
  communities,
  source: Array.from(source),
  target: Array.from(target),
  linkFlow: Array.from(linkFlow, round), // per-directed-edge flow → half-arrow width + colour
  nodeFlow: Array.from(nodeFlow, round), // per-node visit rate → radius + fill
  enterExit: Array.from(enterExit, round), // per-node boundary flow → ring
  community: Array.from(lfr.community), // planted partition → one-level module path
};

const out = join(dirname(fileURLToPath(import.meta.url)), "modular-map.json");
writeFileSync(out, JSON.stringify(fixture));
console.log(`wrote ${out}: ${N} nodes, ${source.length} directed links, ${communities} communities`);
