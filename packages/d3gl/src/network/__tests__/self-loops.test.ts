import { describe, it, expect } from "vitest";
import { buildGraph } from "../graph.js";
import { networkLayersFromCache, noLodStyleCache, type ResolvedNetworkStyle } from "../glyphs.js";
import { bezierControl, halfLinkGeometry, chordBend } from "../../core/half-link.js";
import {
  buildSelfLoopIndex,
  selfLoopOfEdge,
  selfLoopAngles,
  teardropEnds,
  halfArrowLoopBend,
  selfLoopCache,
  updateSelfLoops,
  selfLoopStats,
  selfLoopSelected,
  FALLBACK_ANGLE,
  LOOP_REACH,
  TEARDROP_BEND,
  SELF_LOOP_LAYER,
  SELF_LOOP_ARROW_LAYER,
} from "../self-loops.js";

/** Self-link loops (#505): one teardrop per node with a self-link, its duplicates summed. */

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

  it("puts both ends on the rim and the apex at r·(1 + reach) along θ", () => {
    const loops = buildSelfLoopIndex([0], [0], [1], 1);
    if (!loops) throw new Error("expected loops");
    const r = 7;
    for (const theta of [0, 1, -2, Math.PI]) {
      const so = new Float32Array(2);
      const to = new Float32Array(2);
      teardropEnds(loops, [theta], [r], so, to);
      expect(Math.hypot(so[0] ?? 0, so[1] ?? 0)).toBeCloseTo(r, 5);
      expect(Math.hypot(to[0] ?? 0, to[1] ?? 0)).toBeCloseTo(r, 5);
      // The quadratic's apex (t = ½) = (S + 2C + T) / 4.
      const [cx, cy] = bezierControl(so[0] ?? 0, so[1] ?? 0, to[0] ?? 0, to[1] ?? 0, TEARDROP_BEND);
      const ax = ((so[0] ?? 0) + 2 * cx + (to[0] ?? 0)) / 4;
      const ay = ((so[1] ?? 0) + 2 * cy + (to[1] ?? 0)) / 4;
      expect(Math.hypot(ax, ay)).toBeCloseTo(r * (1 + LOOP_REACH), 4);
      expect(Math.atan2(ay, ax)).toBeCloseTo(Math.atan2(Math.sin(theta), Math.cos(theta)), 4);
    }
  });

  it("bows the half-arrow loop outward at every angle (the half-arrow's direction-fixed side)", () => {
    const loops = buildSelfLoopIndex([0], [0], [1], 1);
    if (!loops) throw new Error("expected loops");
    const r = 10;
    for (let k = 0; k < 16; k++) {
      const theta = -Math.PI + (k * 2 * Math.PI) / 16;
      const so = new Float32Array(2);
      const to = new Float32Array(2);
      teardropEnds(loops, [theta], [r], so, to);
      const x0 = so[0] ?? 0, y0 = so[1] ?? 0, x1 = to[0] ?? 0, y1 = to[1] ?? 0;
      const geom = halfLinkGeometry({ x0, y0, r0: 0, x1, y1, r1: 0, width: 1, oppositeWidth: 0, bend: chordBend(x0, y0, x1, y1, halfArrowLoopBend(x1 - x0, y1 - y0)) });
      if (!geom) throw new Error("expected a half-arrow");
      // The centre curve's control lies beyond the rim, along θ.
      expect(geom.cp1x * Math.cos(theta) + geom.cp1y * Math.sin(theta)).toBeGreaterThan(r);
    }
  });
});

describe("half-arrow loop side", () => {
  // The WebGL lane's rule, in float32: the side from the centres' delta (0 for a loop) plus the offsets' delta.
  const laneOutward = (so: Float32Array, to: Float32Array, bend: number, theta: number): boolean => {
    const sx = Math.fround(Math.fround(0) + Math.fround((to[0] ?? 0) - (so[0] ?? 0)));
    const sy = Math.fround((to[1] ?? 0) - (so[1] ?? 0));
    const curvature = sx > 0 || (sx === 0 && sy < 0) ? 1 : -1;
    const dx = (to[0] ?? 0) - (so[0] ?? 0);
    const dy = (to[1] ?? 0) - (so[1] ?? 0);
    const len = Math.hypot(dx, dy);
    // The bow goes along curvature · sign(bend) · right, right = (−dy, dx) / len; outward is along θ.
    const along = (curvature * Math.sign(bend) * (-dy * Math.cos(theta) + dx * Math.sin(theta))) / len;
    return along > 0;
  };

  it("bows outward on a vertical chord (θ ≈ 0, π), where the chord's x is rounding, at its exact angle", () => {
    const loops = buildSelfLoopIndex([0], [0], [1], 1);
    if (!loops) throw new Error("expected loops");
    for (const theta of [0, Math.PI, -Math.PI, 1e-9, -1e-9, Math.PI - 1e-9, -Math.PI + 1e-9, 1e-30]) {
      for (const r of [0.001, 3, 10, 12345]) {
        const so = new Float32Array(2);
        const to = new Float32Array(2);
        teardropEnds(loops, [theta], [r], so, to);
        const bend = halfArrowLoopBend((to[0] ?? 0) - (so[0] ?? 0), (to[1] ?? 0) - (so[1] ?? 0));
        expect(laneOutward(so, to, bend, theta)).toBe(true);
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
