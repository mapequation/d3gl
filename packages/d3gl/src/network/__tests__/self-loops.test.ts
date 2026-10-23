import { describe, it, expect } from "vitest";
import { buildGraph } from "../graph.js";
import { networkLayersFromCache, noLodStyleCache, type ResolvedNetworkStyle } from "../glyphs.js";
import { DROP_HALF_SPREAD, DROP_LENGTH, DROP_REACH, dropControls, dropEndTangent, traceDropHalfArrow } from "../../core/loop-drop.js";
import { StableColumns } from "../../core/stable-columns.js";
import {
  keptLeafLoops,
  keptLoopStats,
  makeKeptLoopsScratch,
  selfLoopSubset,
  buildSelfLoopIndex,
  selfLoopOfEdge,
  selfLoopAngles,
  loopEnds,
  loopArrowFrom,
  selfLoopCache,
  updateSelfLoops,
  selfLoopStats,
  selfLoopSelected,
  FALLBACK_ANGLE,
  SELF_LOOP_LAYER,
  SELF_LOOP_ARROW_LAYER,
} from "../self-loops.js";

/** Self-link loops (#505): one drop per node with a self-link, its duplicates summed. */

const style = (n: number, over: Partial<ResolvedNetworkStyle> = {}): ResolvedNetworkStyle => ({
  nodeRadii: new Float32Array(n).fill(4),
  nodeRadiusAggregate: null,
  importance: new Float32Array(n).fill(1),
  nodeFill: "#000000",
  linkWidth: 1,
  linkWidthOf: (w) => w,
  linkStroke: "#999999",
  linkColorOf: () => [153, 153, 153, 255],
  linkStrokeOf: () => "#999999",
  linkStyle: "line",
  arrowSize: 3,
  directed: false,
  sizeMode: "world",
  flowBorder: null,
  constBorder: null,
  linkBend: 0,
  ...over,
});

describe("self-loop index", () => {
  it("is null without self-links", () => {
    expect(buildSelfLoopIndex([0, 1], [1, 2], [1, 1], 2)).toBeNull();
  });

  it("draws ONE loop per node: duplicates sum their weight and report the first self-link", () => {
    // edges: 0: 0→1, 1: 2→2 (w 1), 2: 1→1 (w 4), 3: 2→2 (w 2), 4: 2→2 (w 0.5)
    const loops = buildSelfLoopIndex([0, 2, 1, 2, 2], [1, 2, 1, 2, 2], [1, 1, 4, 2, 0.5], 5);
    expect(loops).not.toBeNull();
    if (!loops) return;
    expect(loops.count).toBe(2);
    expect([...loops.nodes]).toEqual([2, 1]);
    expect([...loops.edges]).toEqual([1, 2]); // ascending: the first self-link of each node
    expect([...loops.weights]).toEqual([3.5, 4]);
    expect(selfLoopOfEdge(loops, 1)).toBe(0);
    expect(selfLoopOfEdge(loops, 2)).toBe(1);
    expect(selfLoopOfEdge(loops, 3)).toBe(-1); // a summed duplicate draws no loop of its own
    expect(selfLoopOfEdge(loops, 0)).toBe(-1);
  });

  it("selects a loop with its edge", () => {
    const loops = buildSelfLoopIndex([0, 1, 1], [1, 1, 1], [1, 1, 1], 3);
    if (!loops) throw new Error("expected loops");
    expect([...selfLoopSelected(loops, Uint8Array.of(0, 1, 0))]).toEqual([1]);
    expect([...selfLoopSelected(loops, Uint8Array.of(1, 0, 1))]).toEqual([0]);
  });
});

describe("self-loop geometry", () => {
  it("points away from the neighbours (weighted), or at the fallback angle without any", () => {
    // node 0 at the origin with a self-link; neighbour 1 to its right; node 2 alone with a self-link.
    const g = buildGraph({ nodeCount: 3, source: [0, 0, 2], target: [0, 1, 2], directed: false });
    g.positions.set([0, 0, 10, 0, 50, 50]);
    const loops = buildSelfLoopIndex(g.source, g.target, g.weight, g.edgeCount);
    if (!loops) throw new Error("expected loops");
    const angles = selfLoopAngles(g.positions, g.csr, loops, new Float32Array(loops.count));
    expect(Math.abs(angles[0] ?? 0)).toBeCloseTo(Math.PI, 5); // away from +x = towards −x
    expect(angles[1]).toBeCloseTo(FALLBACK_ANGLE, 6);
  });

  it("puts both ends on the rim, both end tangents through the centre, and the round far end along θ", () => {
    const loops = buildSelfLoopIndex([0], [0], [1], 1);
    if (!loops) throw new Error("expected loops");
    const r = 7;
    // A node offset (the both view) moves the whole drop: the centre is then `o`, not the origin.
    for (const [ox, oy] of [[0, 0], [30, -12]]) {
      for (const theta of [0, 1, -2, Math.PI, 2.5]) {
        const so = new Float32Array(2);
        const to = new Float32Array(2);
        loopEnds(loops, [theta], [r], so, to);
        const sx = (so[0] ?? 0) + ox, sy = (so[1] ?? 0) + oy, tx = (to[0] ?? 0) + ox, ty = (to[1] ?? 0) + oy;
        expect(Math.hypot(sx - ox, sy - oy)).toBeCloseTo(r, 4);
        expect(Math.hypot(tx - ox, ty - oy)).toBeCloseTo(r, 4);
        const [c1x, c1y, c2x, c2y] = dropControls(sx, sy, tx, ty, DROP_REACH);
        // End tangents (P1 − P0, P3 − P2) parallel to the radius (P − c): their cross product is 0.
        const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;
        expect(cross(c1x - sx, c1y - sy, sx - ox, sy - oy) / r ** 2).toBeCloseTo(0, 5);
        expect(cross(tx - c2x, ty - c2y, tx - ox, ty - oy) / r ** 2).toBeCloseTo(0, 5);
        // Out along the first leg, back IN along the second: P1 beyond P0, P2 beyond P3, at DROP_LENGTH radii.
        expect(Math.hypot(c1x - ox, c1y - oy)).toBeCloseTo(DROP_LENGTH * r, 4);
        expect(Math.hypot(c2x - ox, c2y - oy)).toBeCloseTo(DROP_LENGTH * r, 4);
        const [ex, ey] = dropEndTangent(sx, sy, tx, ty);
        expect(ex * (tx - ox) + ey * (ty - oy)).toBeCloseTo(-r, 4); // the arrowhead points into the node
        // The far end, B(½) = (P0 + 3P1 + 3P2 + P3) / 8, lies on θ beyond the rim.
        const ax = (sx + 3 * c1x + 3 * c2x + tx) / 8 - ox;
        const ay = (sy + 3 * c1y + 3 * c2y + ty) / 8 - oy;
        expect(Math.hypot(ax, ay)).toBeCloseTo((r * Math.cos(DROP_HALF_SPREAD) * (2 + 6 * DROP_LENGTH)) / 8, 4);
        expect(Math.atan2(ay, ax)).toBeCloseTo(Math.atan2(Math.sin(theta), Math.cos(theta)), 4);
        // The arrowhead's foot is the drop's last control point.
        const foot = new Float32Array(2);
        loopArrowFrom(Float32Array.of(sx, sy), Float32Array.of(tx, ty), foot, 1);
        expect(foot[0]).toBeCloseTo(c2x, 3);
        expect(foot[1]).toBeCloseTo(c2y, 3);
      }
    }
  });

  it("fills the half-arrow drop outside the loop, its tip on the rim at the target end", () => {
    const loops = buildSelfLoopIndex([0], [0], [1], 1);
    if (!loops) throw new Error("expected loops");
    const r = 10;
    for (let k = 0; k < 16; k++) {
      const theta = -Math.PI + (k * 2 * Math.PI) / 16;
      const so = new Float32Array(2);
      const to = new Float32Array(2);
      loopEnds(loops, [theta], [r], so, to);
      const pts: [number, number][] = [];
      const rec = {
        moveTo: (x: number, y: number) => pts.push([x, y]),
        lineTo: (x: number, y: number) => pts.push([x, y]),
        bezierCurveTo: (_a: number, _b: number, _c: number, _d: number, x: number, y: number) => pts.push([x, y]),
        closePath: () => undefined,
      };
      traceDropHalfArrow(rec, so[0] ?? 0, so[1] ?? 0, to[0] ?? 0, to[1] ?? 0, 2, DROP_REACH);
      // moveTo P0, inner → head base, tip, barb, outer start, outer → foot.
      expect(pts).toHaveLength(6);
      const [tipX, tipY] = pts[2] ?? [0, 0];
      expect(tipX).toBeCloseTo(to[0] ?? 0, 5);
      expect(tipY).toBeCloseTo(to[1] ?? 0, 5);
      // The outer foot sits on the far side of the source leg from θ: outside the drop.
      const [fx, fy] = pts[5] ?? [0, 0];
      const across = (x: number, y: number): number => -x * Math.sin(theta) + y * Math.cos(theta);
      expect(Math.abs(across(fx, fy))).toBeGreaterThan(Math.abs(across(so[0] ?? 0, so[1] ?? 0)));
    }
  });

  it("keeps the half-arrow drop's band one width wide round the whole curve, its edges never crossing", () => {
    const loops = buildSelfLoopIndex([0], [0], [1], 1);
    if (!loops) throw new Error("expected loops");
    const r = 10;
    type Pt = [number, number];
    const cubic = (a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt => {
      const u = 1 - t;
      const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
      return [w0 * a[0] + w1 * b[0] + w2 * c[0] + w3 * d[0], w0 * a[1] + w1 * b[1] + w2 * c[1] + w3 * d[1]];
    };
    for (const theta of [-2.5, 0, 1.2]) {
      for (const width of [0.5, 2, 10, 50]) {
        const so = new Float32Array(2);
        const to = new Float32Array(2);
        loopEnds(loops, [theta], [r], so, to);
        // The two cubics in trace order: [start, c1, c2, end] for the inner edge, then the outer.
        const curves: Pt[][] = [];
        let at: Pt = [0, 0];
        const lines: Pt[] = [];
        const rec = {
          moveTo: (x: number, y: number) => void (at = [x, y]),
          lineTo: (x: number, y: number) => {
            at = [x, y];
            lines.push(at);
          },
          bezierCurveTo: (a: number, b: number, c: number, d: number, x: number, y: number) => {
            curves.push([at, [a, b], [c, d], [x, y]]);
            at = [x, y];
          },
          closePath: () => undefined,
        };
        traceDropHalfArrow(rec, so[0] ?? 0, so[1] ?? 0, to[0] ?? 0, to[1] ?? 0, width, DROP_REACH);
        const [inner, outer] = curves;
        if (!inner || !outer) throw new Error("expected two edge cubics");
        const [i0, i1, i2, i3] = inner;
        const [o0, o1, o2, o3] = outer;
        if (!i0 || !i1 || !i2 || !i3 || !o0 || !o1 || !o2 || !o3) throw new Error("expected cubic control points");
        const dense: Pt[] = [];
        for (let k = 0; k <= 2000; k++) dense.push(cubic(i0, i1, i2, i3, k / 2000));
        for (let k = 0; k <= 40; k++) {
          const q = cubic(o0, o1, o2, o3, k / 40);
          let best = Infinity;
          let near: Pt = [0, 0];
          for (const p of dense) {
            const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (d < best) [best, near] = [d, p];
          }
          expect(Math.abs(best / width - 1)).toBeLessThan(0.1);
          // Outside the loop: the outer sample is farther from the node centre than its nearest inner point.
          expect(Math.hypot(q[0], q[1])).toBeGreaterThan(Math.hypot(near[0], near[1]));
        }
        // The barb tip (the lineTo after the inner edge) lands on the rim.
        const [tip] = lines;
        if (!tip) throw new Error("expected the head's tip");
        expect(Math.hypot(tip[0], tip[1])).toBeCloseTo(r, 4);
      }
    }
  });
});

describe("self-loop cache and layers (per-frame cost)", () => {
  it("builds no loop cache or layer for a graph without self-links, and does no loop work per frame", () => {
    const g = buildGraph({ nodeCount: 3, source: [0, 1], target: [1, 2], directed: true });
    const s = style(3, { directed: true });
    expect(selfLoopCache(g, s)).toBeNull();
    const cache = noLodStyleCache(g, s);
    expect(cache.loops).toBeUndefined();
    const before = selfLoopStats.updates;
    for (let f = 0; f < 5; f++) {
      const names = networkLayersFromCache(g, s, cache).map((l) => l.name);
      expect(names).not.toContain(SELF_LOOP_LAYER);
      expect(names).not.toContain(SELF_LOOP_ARROW_LAYER);
    }
    expect(selfLoopStats.updates).toBe(before);
  });

  it("a position frame with loops does O(S) work in place: the same arrays every frame", () => {
    // 4 nodes, 3 of them looped (node 3 twice: one loop), plus a chain.
    const g = buildGraph({ nodeCount: 4, source: [0, 1, 2, 0, 3, 3], target: [1, 2, 3, 0, 3, 3], weight: [1, 1, 1, 2, 1, 1], directed: true });
    g.positions.set([0, 0, 10, 0, 20, 0, 30, 0]);
    const s = style(4, { directed: true });
    const cache = noLodStyleCache(g, s);
    const loops = cache.loops;
    if (!loops) throw new Error("expected a loop cache");
    expect(loops.loops.count).toBe(2);
    expect([...loops.widths]).toEqual([2, 2]); // node 3's two self-links summed
    const frame = (): { lines: Float32Array[]; arrows: Float32Array[] } => {
      const layers = networkLayersFromCache(g, s, cache);
      const out = { lines: [] as Float32Array[], arrows: [] as Float32Array[] };
      for (const l of layers) {
        if (l.name === SELF_LOOP_LAYER && l.primitive === "lines") out.lines = [l.lines.sources, l.lines.widths, l.lines.bends ?? new Float32Array(), l.lines.sourceOffsets ?? new Float32Array()];
        if (l.name === SELF_LOOP_ARROW_LAYER && l.primitive === "arrows") out.arrows = [l.arrows.sources, l.arrows.sizes, l.arrows.sourceOffsets ?? new Float32Array()];
      }
      return out;
    };
    const a = frame();
    expect(a.lines.length).toBe(4);
    expect(a.arrows.length).toBe(3);
    const u0 = selfLoopStats.updates;
    const i0 = selfLoopStats.instances;
    g.positions.set([0, 5, 10, 5, 20, 5, 30, 5]); // the layout moved every node
    const b = frame();
    expect(selfLoopStats.updates - u0).toBe(1);
    expect(selfLoopStats.instances - i0).toBe(2); // S, not E or N
    a.lines.forEach((arr, k) => expect(b.lines[k]).toBe(arr));
    a.arrows.forEach((arr, k) => expect(b.arrows[k]).toBe(arr));
    expect(b.lines[0]?.[1]).toBe(5); // the centre moved, in place
  });

  it("the half-arrow style draws one half-arrows loop layer and no separate arrowhead", () => {
    const g = buildGraph({ nodeCount: 2, source: [0, 1], target: [1, 1], directed: true });
    g.positions.set([0, 0, 10, 0]);
    const s = style(2, { directed: true, linkStyle: "half-arrow" });
    const layers = networkLayersFromCache(g, s, noLodStyleCache(g, s));
    const loopLayers = layers.filter((l) => l.name === SELF_LOOP_LAYER || l.name === SELF_LOOP_ARROW_LAYER);
    expect(loopLayers.map((l) => l.primitive)).toEqual(["half-arrows"]);
  });
});

describe("an LOD frame's loops on kept leaves", () => {
  // Nodes 0..9 on a line; self-links on 2, 5 and 7 (5 twice: one loop, summed weight).
  const g = buildGraph({
    nodeCount: 10,
    source: [0, 1, 2, 3, 4, 5, 6, 7, 8, 2, 5, 5, 7],
    target: [1, 2, 3, 4, 5, 6, 7, 8, 9, 2, 5, 5, 7],
    weight: [1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 3, 1],
    directed: false,
  });
  g.positions.set(Array.from({ length: 20 }, (_, i) => (i % 2 ? 0 : 10 * (i / 2))));
  const style = { nodeRadii: new Float32Array(10).fill(2), linkWidthOf: () => 1, linkColorOf: (): [number, number, number, number] => [255, 0, 0, 255], directed: false, arrowSize: 3, linkStyle: "line", sizeMode: "world" as const };

  it("lists the loops of kept leaves in min(S, frontier) reads, by either pass", () => {
    const c = selfLoopCache(g, style);
    if (!c) throw new Error("expected loops");
    const sc = makeKeptLoopsScratch();
    const kept = new Set([5, 6, 7, 8, 12]); // 12: an aggregate (≥ nodeCount), never a leaf
    const frontier = Uint32Array.from(kept);
    const r0 = keptLoopStats.reads;
    // S = 3 ≤ 5 glyphs, with the gather's stamp: one pass over the loops.
    const m1 = keptLeafLoops(c.loops, 10, frontier, (v) => kept.has(v), sc);
    expect(Array.from(sc.list.subarray(0, m1)).map((j) => c.loops.nodes[j])).toEqual([5, 7]);
    expect(keptLoopStats.reads - r0).toBe(3);
    // No stamp (or more loops than glyphs): one pass over the frontier against the per-node slots.
    const r1 = keptLoopStats.reads;
    const m2 = keptLeafLoops(c.loops, 10, Uint32Array.of(2, 12), null, sc);
    expect(Array.from(sc.list.subarray(0, m2)).map((j) => c.loops.nodes[j])).toEqual([2]);
    expect(keptLoopStats.reads - r1).toBe(2);
  });

  it("solves the subset's loops away from their neighbours and hands back unchanged columns", () => {
    const c = selfLoopCache(g, style);
    if (!c) throw new Error("expected loops");
    const sc = makeKeptLoopsScratch();
    const memo = new StableColumns();
    const frame = { cx: Float32Array.from({ length: 10 }, (_, i) => 10 * i), cy: new Float32Array(10) };
    const m = keptLeafLoops(c.loops, 10, Uint32Array.of(9, 5), null, sc);
    const a = selfLoopSubset(c, g, m, frame, memo, sc);
    expect(Array.from(a.loops.nodes)).toEqual([5]);
    expect(a.loops.weights[0]).toBeCloseTo(4); // 1 + 3: the summed self-links
    expect(a.centres[0]).toBe(50);
    // Node 5's neighbours sit at ±x: the mean cancels and the loop takes the fallback angle; both ends on its rim.
    expect(Math.hypot(a.sourceOffsets[0] ?? 0, a.sourceOffsets[1] ?? 0)).toBeCloseTo(2, 5);
    const m2 = keptLeafLoops(c.loops, 10, Uint32Array.of(9, 5), null, sc);
    const b = selfLoopSubset(c, g, m2, frame, memo, sc);
    for (const k of ["centres", "sourceOffsets", "targetOffsets", "widths", "colors", "groups", "bends"] as const) expect(b[k], k).toBe(a[k]);
  });
});

