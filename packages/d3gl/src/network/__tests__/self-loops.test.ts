import { describe, it, expect } from "vitest";
import { buildGraph } from "../graph.js";
import { networkLayersFromCache, noLodStyleCache, type ResolvedNetworkStyle } from "../glyphs.js";
import { DROP_COT, DROP_HALF_SPREAD, LOOP_LEG, loopArrowOutline, loopHalfArrowOutline, loopsSpreadCot, spreadCot, loopHalfHeadLength, traceLoop } from "../../core/loop-drop.js";
import { headHalfWidth, headLength } from "../../core/arrowhead.js";
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
  selfLoopCache,
  updateSelfLoops,
  selfLoopStats,
  selfLoopSelected,
  FALLBACK_ANGLE,
  SELF_LOOP_LAYER,
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
  selfLinkSpread: 40,
  selfLinkLength: 3,
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

  type Pt = [number, number];
  const cubicAt = (a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt => {
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    return [w0 * a[0] + w1 * b[0] + w2 * c[0] + w3 * d[0], w0 * a[1] + w1 * b[1] + w2 * c[1] + w3 * d[1]];
  };
  /** The loop's rim ends at angle `theta` round a node of radius `r` at `(ox, oy)`, as `loopEnds` writes them. */
  const endsAt = (theta: number, r: number, ox = 0, oy = 0): [number, number, number, number] => {
    const loops = buildSelfLoopIndex([0], [0], [1], 1);
    if (!loops) throw new Error("expected loops");
    const so = new Float32Array(2);
    const to = new Float32Array(2);
    loopEnds(loops, [theta], [r], so, to);
    return [(so[0] ?? 0) + ox, (so[1] ?? 0) + oy, (to[0] ?? 0) + ox, (to[1] ?? 0) + oy];
  };
  /** The loop's centre path from {@link traceLoop}: `[c, E0, P1, P2, E1, c]`. */
  const centrePath = (sx: number, sy: number, tx: number, ty: number, h: number): Pt[] => {
    const seg: Pt[] = [];
    traceLoop({ moveTo: (x, y) => void seg.push([x, y]), lineTo: (x, y) => void seg.push([x, y]), bezierCurveTo: (a, b, c, d, x, y) => void seg.push([a, b], [c, d], [x, y]) }, sx, sy, tx, ty, h);
    return seg;
  };
  const pt = (b: ArrayLike<number>, i: number): Pt => [b[2 * i] ?? 0, b[2 * i + 1] ?? 0];
  /** Mirror `p` across the axis through `(ox, oy)` along `theta`. */
  const mirror = (p: Pt, theta: number, ox: number, oy: number): Pt => {
    const ax = Math.cos(theta), ay = Math.sin(theta);
    const dx = p[0] - ox, dy = p[1] - oy;
    const along = dx * ax + dy * ay;
    return [ox + 2 * along * ax - dx, oy + 2 * along * ay - dy];
  };
  const expectPt = (a: Pt, b: Pt, digits = 4): void => {
    expect(a[0]).toBeCloseTo(b[0], digits);
    expect(a[1]).toBeCloseTo(b[1], digits);
  };

  it("traces the teardrop: centre → E0, legCubic(c, u0, r + h, c, u1, r + h, L·r), E1 → centre, symmetric about θ", () => {
    const r = 7;
    const h = 6;
    const a = DROP_HALF_SPREAD;
    // A node offset (the both view) moves the whole loop: the centre is then `o`, not the origin.
    for (const [ox, oy] of [[0, 0], [30, -12]] as const) {
      for (const theta of [0, 1, -2, Math.PI, 2.5]) {
        const [sx, sy, tx, ty] = endsAt(theta, r, ox, oy);
        const path = centrePath(sx, sy, tx, ty, h);
        expect(path).toHaveLength(6);
        const [c0 = [0, 0], e0 = [0, 0], p1 = [0, 0], p2 = [0, 0], e1 = [0, 0], c1 = [0, 0]] = path;
        // Centre to centre, like an ordinary link.
        expectPt(c0, [ox, oy]);
        expectPt(c1, [ox, oy]);
        // The legs: E_k = c + (r + h)·u_k, controls ℓ = L·r further out along the same leg.
        const u0: Pt = [Math.cos(theta + a), Math.sin(theta + a)];
        const u1: Pt = [Math.cos(theta - a), Math.sin(theta - a)];
        expectPt(e0, [ox + (r + h) * u0[0], oy + (r + h) * u0[1]]);
        expectPt(e1, [ox + (r + h) * u1[0], oy + (r + h) * u1[1]]);
        expectPt(p1, [e0[0] + LOOP_LEG * r * u0[0], e0[1] + LOOP_LEG * r * u0[1]]);
        expectPt(p2, [e1[0] + LOOP_LEG * r * u1[0], e1[1] + LOOP_LEG * r * u1[1]]);
        // Mirror-symmetric about θ: the reflection swaps the two ends and the two controls.
        expectPt(mirror(e0, theta, ox, oy), e1);
        expectPt(mirror(p1, theta, ox, oy), p2);
        // The far end B(½) = c + (4ρ + 3ℓ)·cos α/4 · u(θ).
        const far = cubicAt(e0, p1, p2, e1, 0.5);
        const reach = ((4 * (r + h) + 3 * LOOP_LEG * r) * Math.cos(a)) / 4;
        expectPt(far, [ox + reach * Math.cos(theta), oy + reach * Math.sin(theta)]);
      }
    }
  });

  it("draws the arrow loop as one outline: the undirected path plus a head, its tip on the rim, the shaft's corners on the head's base", () => {
    const r = 10;
    const size = 4;
    const h = headLength(size);
    const m = 12;
    for (const [ox, oy] of [[0, 0], [-5, 9]] as const) {
      for (const theta of [-2.5, 0, 1.2, Math.PI]) {
        for (const width of [0.5, 3, 8]) {
          const [sx, sy, tx, ty] = endsAt(theta, r, ox, oy);
          const buf = new Float64Array(2 * (2 * m + 5));
          const n = loopArrowOutline(buf, 0, sx, sy, tx, ty, width, h, m);
          expect(n).toBe(2 * m + 5);
          const last = 2 * m + 4;
          // The shaft's mid-line is the undirected loop's path: c, E0, then the cubic at t = (k − 1)/(m − 1).
          const [c = [0, 0], e0 = [0, 0], p1 = [0, 0], p2 = [0, 0], e1 = [0, 0]] = centrePath(sx, sy, tx, ty, h);
          for (let k = 0; k <= m; k++) {
            const l = pt(buf, k);
            const rr = pt(buf, last - k);
            const want = k === 0 ? c : cubicAt(e0, p1, p2, e1, (k - 1) / (m - 1));
            expectPt([(l[0] + rr[0]) / 2, (l[1] + rr[1]) / 2], want);
            expect(Math.hypot(l[0] - rr[0], l[1] - rr[1])).toBeCloseTo(width, 4);
            // Mirror-symmetric about θ apart from the head: each edge maps onto itself, reversed.
            if (k >= 1) {
              expectPt(mirror(l, theta, ox, oy), pt(buf, m + 1 - k));
              expectPt(mirror(rr, theta, ox, oy), pt(buf, last - (m + 1 - k)));
            }
          }
          // The head: left barb, tip, right barb. The tip is the rim end; the base is centred on E1, headHalfWidth wide.
          const lb = pt(buf, m + 1), tip = pt(buf, m + 2), rb = pt(buf, m + 3);
          expectPt(tip, [tx, ty]);
          expect(Math.hypot(tip[0] - ox, tip[1] - oy)).toBeCloseTo(r, 4);
          expectPt([(lb[0] + rb[0]) / 2, (lb[1] + rb[1]) / 2], e1);
          expect(Math.hypot(lb[0] - rb[0], lb[1] - rb[1]) / 2).toBeCloseTo(headHalfWidth(width), 4);
          expect(Math.hypot(e1[0] - tip[0], e1[1] - tip[1])).toBeCloseTo(h, 4);
          // The shaft's end corners lie on the base, inside the barbs.
          const cross = (p: Pt): number => (rb[0] - lb[0]) * (p[1] - lb[1]) - (rb[1] - lb[1]) * (p[0] - lb[0]);
          for (const corner of [pt(buf, m), pt(buf, last - m)]) {
            expect(cross(corner) / headHalfWidth(width)).toBeCloseTo(0, 4);
            expect(Math.hypot(corner[0] - e1[0], corner[1] - e1[1])).toBeLessThan(headHalfWidth(width));
          }
          // The left edge is the loop's outside: farther from the centre than the right at the far end.
          const mid = Math.round((m + 1) / 2);
          expect(Math.hypot(pt(buf, mid)[0] - ox, pt(buf, mid)[1] - oy)).toBeGreaterThan(Math.hypot(pt(buf, last - mid)[0] - ox, pt(buf, last - mid)[1] - oy));
        }
      }
    }
  });

  it("keeps the half-arrow loop's band one width wide along its length, outside the loop, its tip on the rim", () => {
    const r = 10;
    const m = 24;
    for (const theta of [-2.5, 0, 1.2]) {
      for (const width of [0.5, 2, 10, 50]) {
        const [sx, sy, tx, ty] = endsAt(theta, r);
        const buf = new Float64Array(2 * (2 * m + 4));
        const n = loopHalfArrowOutline(buf, 0, sx, sy, tx, ty, width, m);
        expect(n).toBe(2 * m + 4);
        const last = 2 * m + 3;
        // The inner edge is the centre path for the half-arrow's head length.
        const h = loopHalfHeadLength(width);
        const [c = [0, 0], e0 = [0, 0], p1 = [0, 0], p2 = [0, 0], e1 = [0, 0]] = centrePath(sx, sy, tx, ty, h);
        expectPt(pt(buf, 0), c);
        expectPt(pt(buf, 1), e0);
        expectPt(pt(buf, m), e1);
        // The head: the tip on the rim, then the barb `width + 2√width` out from E1, then the outer edge at `width`.
        const tip = pt(buf, m + 1);
        expectPt(tip, [tx, ty]);
        expect(Math.hypot(tip[0], tip[1])).toBeCloseTo(r, 4);
        const barb = pt(buf, m + 2);
        expect(Math.hypot(barb[0] - e1[0], barb[1] - e1[1])).toBeCloseTo(width + 2 * Math.sqrt(width), 4);
        expect(Math.hypot(pt(buf, m + 3)[0] - e1[0], pt(buf, m + 3)[1] - e1[1])).toBeCloseTo(width, 4);
        const dense: Pt[] = [];
        for (let k = 0; k <= 2000; k++) dense.push(cubicAt(e0, p1, p2, e1, k / 2000));
        for (let k = 1; k <= m; k++) {
          const q = pt(buf, last - k);
          let best = Infinity;
          let near: Pt = [0, 0];
          for (const p of dense) {
            const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (d < best) [best, near] = [d, p];
          }
          expect(Math.abs(best / width - 1)).toBeLessThan(0.01);
          // Outside the loop: the outer sample is farther from the node centre than its nearest inner point.
          expect(Math.hypot(q[0], q[1])).toBeGreaterThan(Math.hypot(near[0], near[1]));
          // Mirror-symmetric about θ apart from the head: the outer edge maps onto itself, reversed.
          expectPt(mirror(q, theta, 0, 0), pt(buf, last - (m + 1 - k)));
          expectPt(mirror(pt(buf, k), theta, 0, 0), pt(buf, m + 1 - k));
        }
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
    const frame = (): { lines: Float32Array[]; layers: number } => {
      const layers = networkLayersFromCache(g, s, cache).filter((l) => l.name === SELF_LOOP_LAYER);
      const out = { lines: [] as Float32Array[], layers: layers.length };
      for (const l of layers)
        if (l.primitive === "loops") out.lines = [l.loops.centers, l.loops.widths, l.loops.startOffsets, l.loops.endOffsets];
      return out;
    };
    const a = frame();
    expect(a.layers).toBe(1); // the directed loop is ONE loops layer, its head part of each instance (#542)
    expect(a.lines.length).toBe(4);
    const u0 = selfLoopStats.updates;
    const i0 = selfLoopStats.instances;
    g.positions.set([0, 5, 10, 5, 20, 5, 30, 5]); // the layout moved every node
    const b = frame();
    expect(selfLoopStats.updates - u0).toBe(1);
    expect(selfLoopStats.instances - i0).toBe(2); // S, not E or N
    a.lines.forEach((arr, k) => expect(b.lines[k]).toBe(arr));
    expect(b.lines[0]?.[1]).toBe(5); // the centre moved, in place
  });

  it("every style draws ONE loops layer, its head the variant (#542)", () => {
    const g = buildGraph({ nodeCount: 2, source: [0, 1], target: [1, 1], directed: true });
    g.positions.set([0, 0, 10, 0]);
    const heads = (opts: Parameters<typeof style>[1]): (string | undefined)[] => {
      const s = style(2, opts);
      const layers = networkLayersFromCache(g, s, noLodStyleCache(g, s)).filter((l) => l.name === SELF_LOOP_LAYER);
      return layers.map((l) => (l.primitive === "loops" ? `loops:${l.loops.head}` : l.primitive));
    };
    expect(heads({ directed: true, linkStyle: "half-arrow" })).toEqual(["loops:half"]);
    expect(heads({ directed: true })).toEqual(["loops:arrow"]);
    expect(heads({ directed: false })).toEqual(["loops:none"]);
  });

  it("the head carries only its own size: the undirected loop's stub is the line style's head length (#542)", () => {
    const g = buildGraph({ nodeCount: 2, source: [0, 1], target: [1, 1], directed: true });
    g.positions.set([0, 0, 10, 0]);
    const head = (opts: Parameters<typeof style>[1]) => {
      const s = style(2, opts);
      const l = networkLayersFromCache(g, s, noLodStyleCache(g, s)).find((x) => x.name === SELF_LOOP_LAYER);
      if (!l || l.primitive !== "loops") throw new Error("expected the loops layer");
      return l.loops.head === "none" ? { head: "none", stubLength: l.loops.stubLength } : l.loops.head === "arrow" ? { head: "arrow", arrowSize: l.loops.arrowSize } : { head: "half" };
    };
    expect(head({ directed: false })).toEqual({ head: "none", stubLength: 6 }); // 2 · arrowSize 3
    expect(head({ directed: true })).toEqual({ head: "arrow", arrowSize: 3 });
    expect(head({ directed: true, linkStyle: "half-arrow" })).toEqual({ head: "half" });
  });
});

describe("selfLinkSpread and selfLinkLength (#542)", () => {
  // Node 1 loops; its one neighbour sits at −x, so the loop points along +x (θ = 0).
  const g = buildGraph({ nodeCount: 2, source: [0, 1], target: [1, 1], directed: false });
  g.positions.set([0, 0, 10, 0]);
  const loopLayer = (s: ResolvedNetworkStyle) => {
    const layer = networkLayersFromCache(g, s, noLodStyleCache(g, s)).find((l) => l.name === SELF_LOOP_LAYER);
    if (!layer || layer.primitive !== "loops") throw new Error("expected the loops layer");
    return layer.loops;
  };
  const ends = (l: ReturnType<typeof loopLayer>): [number, number] => [
    Math.atan2(l.startOffsets[1] ?? 0, l.startOffsets[0] ?? 0),
    Math.atan2(l.endOffsets[1] ?? 0, l.endOffsets[0] ?? 0),
  ];

  it("the defaults reproduce α = 20°, cot α and L = 3", () => {
    const c = selfLoopCache(g, style(2));
    if (!c) throw new Error("expected loops");
    expect(c.halfSpread).toBe(DROP_HALF_SPREAD);
    expect(c.spreadCot).toBe(DROP_COT);
    expect(c.legLength).toBe(LOOP_LEG);
    const l = loopLayer(style(2));
    expect(loopsSpreadCot(l.spread)).toBe(DROP_COT);
    const [a0, a1] = ends(l);
    expect(a0).toBeCloseTo(DROP_HALF_SPREAD, 6);
    expect(a1).toBeCloseTo(-DROP_HALF_SPREAD, 6);
  });

  it("the spread moves the rim ends to θ ± spread/2 and the centre solve follows it", () => {
    const l = loopLayer(style(2, { selfLinkSpread: 90 }));
    const [a0, a1] = ends(l);
    expect(a0).toBeCloseTo(Math.PI / 4, 6);
    expect(a1).toBeCloseTo(-Math.PI / 4, 6);
    expect(Math.hypot(l.startOffsets[0] ?? 0, l.startOffsets[1] ?? 0)).toBeCloseTo(4, 5); // on the rim
    expect(l.spread).toBeCloseTo(Math.PI / 2, 12);
    expect(loopsSpreadCot(l.spread)).toBeCloseTo(1, 12); // cot 45°
    expect(loopsSpreadCot(l.spread)).toBe(spreadCot(Math.PI / 4));
    // The writers recover the node centre from those ends with that cot: the path starts and ends there.
    const seg: [number, number][] = [];
    const so = l.startOffsets, to = l.endOffsets;
    traceLoop({ moveTo: (x, y) => void seg.push([x, y]), lineTo: (x, y) => void seg.push([x, y]), bezierCurveTo: (_a, _b, _c, _d, x, y) => void seg.push([x, y]) }, 10 + (so[0] ?? 0), so[1] ?? 0, 10 + (to[0] ?? 0), to[1] ?? 0, 0, LOOP_LEG, loopsSpreadCot(l.spread));
    expect(seg[0]?.[0]).toBeCloseTo(10, 5);
    expect(seg[0]?.[1]).toBeCloseTo(0, 5);
    // E0 = c + r·u0 at h = 0: the ends themselves.
    expect(seg[1]?.[0]).toBeCloseTo(10 + (so[0] ?? 0), 5);
  });

  it("the length sets the layer's leg length and leaves the ends alone", () => {
    const l = loopLayer(style(2, { selfLinkLength: 4.5 }));
    expect(l.legLength).toBe(4.5);
    const [a0, a1] = ends(l);
    expect(a0).toBeCloseTo(DROP_HALF_SPREAD, 6);
    expect(a1).toBeCloseTo(-DROP_HALF_SPREAD, 6);
    expect(loopsSpreadCot(l.spread)).toBe(DROP_COT);
  });

  it("an LOD frame's subset keeps the spread and the length", () => {
    const c = selfLoopCache(g, style(2, { selfLinkSpread: 60, selfLinkLength: 2 }));
    if (!c) throw new Error("expected loops");
    const sc = makeKeptLoopsScratch();
    const m = keptLeafLoops(c.loops, 2, Uint32Array.of(1), null, sc);
    const sub = selfLoopSubset(c, g, m, { cx: Float32Array.of(0, 10), cy: new Float32Array(2), positionsVersion: 1 }, new StableColumns(), sc);
    expect(sub.spreadCot).toBe(c.spreadCot);
    expect(sub.head).toBe(c.head);
    expect(sub.legLength).toBe(2);
    expect(Math.atan2(sub.sourceOffsets[1] ?? 0, sub.sourceOffsets[0] ?? 0)).toBeCloseTo(Math.PI / 6, 6);
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
  const style = { nodeRadii: new Float32Array(10).fill(2), linkWidthOf: () => 1, linkColorOf: (): [number, number, number, number] => [255, 0, 0, 255], directed: false, arrowSize: 3, linkStyle: "line", sizeMode: "world" as const, selfLinkSpread: 40, selfLinkLength: 3 };

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
    const frame = { cx: Float32Array.from({ length: 10 }, (_, i) => 10 * i), cy: new Float32Array(10), positionsVersion: 1 };
    const m = keptLeafLoops(c.loops, 10, Uint32Array.of(9, 5), null, sc);
    const a = selfLoopSubset(c, g, m, frame, memo, sc);
    expect(Array.from(a.loops.nodes)).toEqual([5]);
    expect(a.loops.weights[0]).toBeCloseTo(4); // 1 + 3: the summed self-links
    expect(a.centres[0]).toBe(50);
    // Node 5's neighbours sit at ±x: the mean cancels and the loop takes the fallback angle; both ends on its rim.
    expect(Math.hypot(a.sourceOffsets[0] ?? 0, a.sourceOffsets[1] ?? 0)).toBeCloseTo(2, 5);
    const m2 = keptLeafLoops(c.loops, 10, Uint32Array.of(9, 5), null, sc);
    const n0 = selfLoopStats.neighbours;
    const b = selfLoopSubset(c, g, m2, frame, memo, sc);
    for (const k of ["centres", "sourceOffsets", "targetOffsets", "widths", "colors", "groups"] as const) expect(b[k], k).toBe(a[k]);
    // The same position version (a zoom): the angle is copied, no neighbour is read.
    expect(selfLoopStats.neighbours - n0).toBe(0);
  });

  it("solves a drawn loop's angle once per position version (a zoom reads no neighbour), again when positions move", () => {
    const c = selfLoopCache(g, style);
    if (!c) throw new Error("expected loops");
    const sc = makeKeptLoopsScratch();
    const memo = new StableColumns();
    const pos = Float32Array.from(g.positions);
    const frame = { cx: Float32Array.from({ length: 10 }, (_, i) => 10 * i), cy: new Float32Array(10), positionsVersion: 7 };
    const n0 = selfLoopStats.neighbours;
    const m = keptLeafLoops(c.loops, 10, Uint32Array.of(2, 7), null, sc);
    selfLoopSubset(c, g, m, frame, memo, sc);
    const solved = selfLoopStats.neighbours - n0;
    expect(solved).toBeGreaterThan(0);
    for (let f = 0; f < 3; f++) selfLoopSubset(c, g, keptLeafLoops(c.loops, 10, Uint32Array.of(2, 7), null, sc), frame, memo, sc);
    expect(selfLoopStats.neighbours - n0, "a frame at the same version re-read neighbours").toBe(solved);
    // Node 3 moves above node 2: a new version solves node 2's loop again, away from it.
    g.positions[7] = 10;
    const moved = selfLoopSubset(c, g, keptLeafLoops(c.loops, 10, Uint32Array.of(2), null, sc), { ...frame, positionsVersion: 8 }, memo, sc);
    expect(selfLoopStats.neighbours - n0).toBeGreaterThan(solved);
    expect(moved.angles[0]).toBeCloseTo(selfLoopAngles(g.positions, g.csr, { ...c.loops, nodes: Uint32Array.of(2), count: 1 }, new Float32Array(1))[0] ?? NaN, 6);
    // A full-detail position frame rewrites `angles`, so the LOD stamps no longer hold.
    updateSelfLoops(g, c);
    expect([...(c.angleAt ?? [])].every((v) => v === 0)).toBe(true);
    g.positions.set(pos);
  });
});

