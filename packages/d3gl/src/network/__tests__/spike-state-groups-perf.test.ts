/**
 * SPIKE (#497) — not for merge. A physical node as a group of its state nodes: a two-level module tree
 * (root → physical group → state leaf) built by `buildModuleLODTree`, compared with `buildStateGraph`'s
 * physical graph on the real state files, and timed per frame at ≈1M state nodes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildStateGraph, type StateNetworkGraph } from "../state-graph.js";
import { buildModuleLODTree, type ModuleNode } from "../modules.js";
import { buildLODTree, computeLODGeometry, cut, declutterFrontier, visibleWorldRect, type LODTree, type LODTransform } from "../lod.js";
import { superEdges, makeSuperEdgesScratch } from "../glyphs.js";

const DATA = "/Users/daniel/dev/projects/icelab/code/web/network-navigator/public/data/states/";
const W = 1200, H = 800;

/** Minimal reader of the `*Vertices / *States / *Links` state format (d3gl has no state parser). */
function parseStates(text: string) {
  let section = "";
  const physIndex = new Map<number, number>();
  const stateIndex = new Map<number, number>();
  const stateToPhysical: number[] = [];
  const src: number[] = [], tgt: number[] = [], w: number[] = [];
  const links: [number, number, number][] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("*")) { section = line.split(/\s+/)[0]!.toLowerCase(); continue; }
    const parts = line.split(/\s+/);
    if (section === "*vertices") physIndex.set(Number(parts[0]), physIndex.size);
    else if (section === "*states") {
      const p = Number(parts[1]);
      if (!physIndex.has(p)) physIndex.set(p, physIndex.size);
      stateIndex.set(Number(parts[0]), stateToPhysical.length);
      stateToPhysical.push(physIndex.get(p)!);
    } else if (section === "*links" || section === "*arcs" || section === "*edges") {
      links.push([Number(parts[0]), Number(parts[1]), parts[2] === undefined ? 1 : Number(parts[2])]);
    }
  }
  for (const [a, b, x] of links) { src.push(stateIndex.get(a)!); tgt.push(stateIndex.get(b)!); w.push(x); }
  return { stateCount: stateToPhysical.length, physicalCount: physIndex.size, stateToPhysical, src, tgt, w };
}

/** Two-level paths: state s in physical p → [p + 1, rank + 1]. */
function groupRecords(sg: StateNetworkGraph): ModuleNode[] {
  const rec: ModuleNode[] = new Array(sg.state.nodeCount);
  const { offsets, states } = sg.physicalToState;
  for (let p = 0; p < sg.physicalCount; p++) {
    for (let i = offsets[p]!; i < offsets[p + 1]!; i++) rec[states[i]!] = { id: states[i]!, path: [p + 1, i - offsets[p]! + 1] };
  }
  return rec;
}

function groupTree(sg: StateNetworkGraph): LODTree {
  return buildModuleLODTree(sg.state.nodeCount, groupRecords(sg), sg.state);
}

/** p→q pair flows between depth-1 aggregates of the group tree. */
function groupPairs(tree: LODTree): Map<string, number> {
  const out = new Map<string, number>();
  const { depth, branch, superEdgeOffset, superEdgeTarget, superEdgeFlow } = tree;
  if (!depth || !branch || !superEdgeOffset || !superEdgeTarget || !superEdgeFlow) throw new Error("no super-edges");
  for (let g = 0; g < tree.size; g++) {
    if (depth[g] !== 1) continue;
    for (let e = superEdgeOffset[g]!; e < superEdgeOffset[g + 1]!; e++) {
      const t = superEdgeTarget[e]!;
      if (depth[t] !== 1) continue;
      const key = `${branch[g]! - 1}>${branch[t]! - 1}`;
      out.set(key, (out.get(key) ?? 0) + superEdgeFlow[e]!);
    }
  }
  return out;
}

function physicalPairs(sg: StateNetworkGraph): Map<string, number> {
  const out = new Map<string, number>();
  const g = sg.physical;
  for (let e = 0; e < g.edgeCount; e++) {
    const key = `${g.source[e]}>${g.target[e]}`;
    out.set(key, (out.get(key) ?? 0) + g.weight[e]!);
  }
  return out;
}

function bytesOf(obj: object): number {
  let b = 0;
  for (const v of Object.values(obj)) if (ArrayBuffer.isView(v)) b += v.byteLength;
  return b;
}

describe("spike #497: physical view as a forced cut of a physical-group level", () => {
  for (const file of ["fig3b_states.net", "overlapping_two_triangles_states.net", "air30k.net"]) {
    for (const directed of [true, false]) {
      it(`${file} directed=${directed}: group super-edges = buildStateGraph physical links`, () => {
        const d = parseStates(readFileSync(DATA + file, "utf8"));
        const sg = buildStateGraph({ stateCount: d.stateCount, stateToPhysical: d.stateToPhysical, source: d.src, target: d.tgt, weight: d.w, directed, physicalCount: d.physicalCount });
        const tree = groupTree(sg);
        const groups = Array.from(tree.depth!).filter((x) => x === 1).length;
        const a = groupPairs(tree), b = physicalPairs(sg);
        let maxRel = 0;
        for (const [k, v] of b) maxRel = Math.max(maxRel, Math.abs((a.get(k) ?? NaN) - v) / Math.abs(v));
        const missing = [...b.keys()].filter((k) => !a.has(k)).length, extra = [...a.keys()].filter((k) => !b.has(k)).length;
        // internal (p === q) link weight: in an aggregate's summed strength, not in the physical graph's
        let internal = 0;
        for (let e = 0; e < sg.state.edgeCount; e++) if (sg.stateToPhysical[sg.state.source[e]!] === sg.stateToPhysical[sg.state.target[e]!]) internal++;
        const emptyPhysical = Array.from({ length: sg.physicalCount }, (_, p) => sg.physicalToState.offsets[p + 1]! - sg.physicalToState.offsets[p]!).filter((c) => c === 0).length;
        console.log(JSON.stringify({ file, directed, states: sg.state.nodeCount, stateLinks: sg.state.edgeCount, physical: sg.physicalCount, groups, emptyPhysical, physLinks: b.size, groupLinks: a.size, missing, extra, maxRel, internalStateLinks: internal }));
        expect(missing).toBe(0);
        expect(extra).toBe(0);
        expect(maxRel).toBeLessThan(1e-5);
        expect(groups).toBe(sg.physicalCount - emptyPhysical);
      });
    }
  }
});

/** Synthetic ≈1M-state network: P physical nodes on a jittered grid, m states each, d out-links per state
 *  to a state of the same or a neighbouring physical node. Test fixture only (never rendered as data). */
function synthetic(P: number, m: number, d: number, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const side = Math.ceil(Math.sqrt(P));
  const S = P * m;
  const stateToPhysical = new Uint32Array(S);
  for (let i = 0; i < S; i++) stateToPhysical[i] = Math.floor(i / m);
  const E = S * d;
  const src = new Uint32Array(E), tgt = new Uint32Array(E);
  for (let e = 0; e < E; e++) {
    const a = Math.floor(e / d), p = stateToPhysical[a]!;
    const px = p % side, py = Math.floor(p / side);
    let q = p;
    if (rnd() > 0.2) {
      const qx = Math.min(side - 1, Math.max(0, px + Math.floor(rnd() * 3) - 1)), qy = Math.min(side - 1, Math.max(0, py + Math.floor(rnd() * 3) - 1));
      q = Math.min(P - 1, qy * side + qx);
    }
    src[e] = a; tgt[e] = q * m + Math.floor(rnd() * m);
  }
  const positions = new Float32Array(2 * S);
  const phys = new Float32Array(2 * P);
  for (let p = 0; p < P; p++) { phys[2 * p] = (p % side) * 10 + rnd() * 4; phys[2 * p + 1] = Math.floor(p / side) * 10 + rnd() * 4; }
  for (let i = 0; i < S; i++) {
    const p = stateToPhysical[i]!, a = (2 * Math.PI * (i % m)) / m;
    positions[2 * i] = phys[2 * p]! + 3 * Math.cos(a); positions[2 * i + 1] = phys[2 * p + 1]! + 3 * Math.sin(a);
  }
  return { S, P, stateToPhysical, src, tgt, positions, phys, extent: side * 10 };
}

const STYLE = { linkStyle: "line" as const, directed: false, widthOf: () => 1, colorOf: () => [100, 110, 140, 200] as [number, number, number, number], bend: 0, arrowSize: 5, maxAggregateRadius: 26 };

function median(xs: number[]): number { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]!; }

describe.skipIf(!process.env.BENCH_SPIKE)("spike #497: per-frame cost at ≈1M state nodes", () => {
  for (const [P, m] of [[100_000, 10], [14_000, 72]] as const) {
    it(`P=${P} m=${m}`, () => {
      const d = 3;
      const syn = synthetic(P, m, d);
      let t0 = performance.now();
      const sg = buildStateGraph({ stateCount: syn.S, stateToPhysical: syn.stateToPhysical, source: syn.src, target: syn.tgt, directed: true, physicalCount: P });
      const tStateGraph = performance.now() - t0;
      sg.state.positions.set(syn.positions);
      sg.physical.positions.set(syn.phys);

      // group tree (states → physical groups → root)
      t0 = performance.now();
      const gt = groupTree(sg);
      computeLODGeometry(gt, sg.state, new Float32Array(syn.S).fill(1));
      const tGroupTree = performance.now() - t0;
      // today's physical graph under LOD (what #174 would cut): a coarsening tree over the P physical nodes
      t0 = performance.now();
      const pt = buildLODTree(sg.physical);
      computeLODGeometry(pt, sg.physical, new Float32Array(P).fill(4));
      const tPhysTree = performance.now() - t0;

      const groupIds: number[] = [];
      for (let g = 0; g < gt.size; g++) if (gt.depth![g] === 1) groupIds.push(g);
      const forcedScratch = new Uint32Array(groupIds.length);
      const c = syn.extent / 2;
      const baseK = Math.min(W, H) / syn.extent;
      const views: LODTransform[] = [];
      for (let i = 0; i < 24; i++) { const k = baseK * Math.pow(2, i / 4); views.push({ k, x: W / 2 - c * k, y: H / 2 - c * k }); }

      const legs: Record<string, () => (t: LODTransform) => number> = {
        // physical view in the group model: every group closed, culled to the view, links gathered from the group rows
        forcedCut: () => { const sc = makeSuperEdgesScratch(); return (t) => {
          const v = visibleWorldRect(t, W, H); let n = 0;
          for (const g of groupIds) { const r = gt.extent[g]!; if (gt.cx[g]! + r >= v.minX && gt.cx[g]! - r <= v.maxX && gt.cy[g]! + r >= v.minY && gt.cy[g]! - r <= v.maxY) forcedScratch[n++] = g; }
          const out = superEdges(gt, forcedScratch.subarray(0, n), STYLE, v, sc); return n + out.ids.length; }; },
        // group tree with LOD on (groups open by footprint — the "both"-like view); cut + declutter + gather
        groupLOD: () => { const sc = makeSuperEdgesScratch(); return (t) => {
          const raw = cut(gt, t, W, H, { expandPx: 48, maxAggregateRadius: 26 });
          const f = declutterFrontier(gt, raw, t, W, H, { screenSized: false, k: t.k, maxAggregateRadius: 26 });
          const out = superEdges(gt, f, STYLE, visibleWorldRect(t, W, H), sc); return f.length + out.ids.length; }; },
        // today's physical graph with LOD on (coarsening tree over P physical nodes)
        physLOD: () => { const sc = makeSuperEdgesScratch(); return (t) => {
          const raw = cut(pt, t, W, H, { expandPx: 48, maxAggregateRadius: 26 });
          const f = declutterFrontier(pt, raw, t, W, H, { screenSized: false, k: t.k, maxAggregateRadius: 26 });
          const out = superEdges(pt, f, STYLE, visibleWorldRect(t, W, H), sc); return f.length + out.ids.length; }; },
      };
      const res: Record<string, unknown> = { P, m, S: syn.S, stateLinks: sg.state.edgeCount, physLinks: sg.physical.edgeCount, tStateGraph: Math.round(tStateGraph), tGroupTree: Math.round(tGroupTree), tPhysTree: Math.round(tPhysTree) };
      for (const [name, make] of Object.entries(legs)) {
        const f = make();
        for (const t of views) f(t); // warm
        const ms: number[] = []; let drawn0 = 0, drawnMax = 0;
        for (let rep = 0; rep < 3; rep++) for (const [i, t] of views.entries()) { const a = performance.now(); const n = f(t); ms.push(performance.now() - a); if (i === 0) drawn0 = n; drawnMax = Math.max(drawnMax, n); }
        res[name] = { fitMs: +ms[0]!.toFixed(2), medMs: +median(ms).toFixed(2), maxMs: +Math.max(...ms).toFixed(2), drawnAtFit: drawn0, drawnMax };
      }
      const mb = (b: number) => +(b / 2 ** 20).toFixed(1);
      res.memMB = { stateGraph: mb(bytesOf(sg.state) + bytesOf(sg.state.csr)), physicalGraph: mb(bytesOf(sg.physical) + bytesOf(sg.physical.csr) + bytesOf(sg.physicalToState) + sg.stateToPhysical.byteLength), groupTree: mb(bytesOf(gt)), physLODTree: mb(bytesOf(pt)) };
      console.log(JSON.stringify(res));
      expect(groupIds.length).toBe(P);
    });
  }
});
