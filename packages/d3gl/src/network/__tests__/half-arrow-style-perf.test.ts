import { afterEach, describe, it, expect, vi } from "vitest";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { noLodStyleCache, type ResolvedNetworkStyle } from "../glyphs.js";

/**
 * Regression guard for the half-arrow style pass at road-network scale (#449, #447). `noLodStyleCache` builds
 * the full-detail per-edge style once per (graph, style): LOD off draws from it, and since #447 so do the
 * leaf links of an LOD view, on its first frame. For half-arrows it pairs each edge with its reciprocal
 * (`oppositeWidth`). That used to be a `Map` keyed by `s · nodeCount + t`: past 2³¹ its keys are boxed, and on
 * roadNet-CA (1,965,206 nodes, 5,533,214 edges, loaded as directed) it took 4.1 s of a 4.4 s first frame in the
 * Network Navigator. `reciprocalEdges` does it with two counting sorts and a binary search per edge.
 *
 * Signature asserted deterministically: the pass makes no per-edge `Map` call (fewer than one per thousand
 * edges; the fixture's accessors use none). Wall clock: the whole half-arrow style pass at roadNet-CA scale,
 * best of 3, under 1.5 s (measured on an M-series laptop: 0.14 s with `reciprocalEdges`, 7.6 s with the Map).
 */
const NODES = 1_965_206;
const MS = Number(process.env.PERF_HALF_ARROW_STYLE_MS) || 1_500;

/**
 * A road-like grid of `n` nodes: every row neighbour linked both ways, and two in five nodes also linked both
 * ways to the node below. 2.8 directed edges per node on average, as roadNet-CA has, and every edge reciprocal;
 * the two directions weigh 1 and 2, so an edge's own width and its opposite width differ.
 */
function roads(n: number): NetworkGraph {
  const width = 1400;
  const source: number[] = [];
  const target: number[] = [];
  const weight: number[] = [];
  for (let i = 0; i < n; i++) {
    if ((i + 1) % width !== 0 && i + 1 < n) {
      source.push(i, i + 1);
      target.push(i + 1, i);
      weight.push(1, 2);
    }
    if (i % 5 < 2 && i + width < n) {
      source.push(i, i + width);
      target.push(i + width, i);
      weight.push(1, 2);
    }
  }
  return buildGraph({ nodeCount: n, source, target, weight, directed: true });
}

function halfArrowStyle(n: number): ResolvedNetworkStyle {
  const grey = [90, 100, 120, 255] as const;
  return {
    nodeRadii: new Float32Array(n).fill(4),
    nodeRadiusAggregate: null,
    importance: new Float32Array(n).fill(1),
    nodeFill: "#4878d0",
    linkWidth: 1,
    linkWidthOf: (w) => 0.4 + w,
    linkStroke: "#5a6478",
    linkColorOf: () => grey,
    linkStrokeOf: () => "#5a6478",
    linkStyle: "half-arrow",
    arrowSize: 3,
    directed: true,
    sizeMode: "screen",
    flowBorder: null,
    constBorder: null,
    linkBend: 0.15,
  };
}

describe("half-arrow style pass at roadNet-CA scale (#449, #447)", () => {
  const graph = roads(NODES);
  const style = halfArrowStyle(NODES);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the fixture is roadNet-CA's size, every edge with a reciprocal", () => {
    expect(graph.nodeCount).toBe(NODES);
    expect(graph.edgeCount).toBeGreaterThan(5_400_000);
    expect(graph.edgeCount).toBeLessThan(5_700_000);
  });

  it("pairs the reciprocals without a per-edge Map call", () => {
    const set = vi.spyOn(Map.prototype, "set");
    const get = vi.spyOn(Map.prototype, "get");
    const cache = noLodStyleCache(graph, style);
    const calls = set.mock.calls.length + get.mock.calls.length;
    vi.restoreAllMocks();
    expect(cache.kind).toBe("half-arrows");
    expect(calls).toBeLessThan(graph.edgeCount / 1000);
    // Each edge carries [its width, its reciprocal's]: 0→1 weighs 1 and 1→0 weighs 2 (widthOf = 0.4 + w).
    if (cache.kind !== "half-arrows") return;
    expect(Array.from(cache.halfArrows.widths.subarray(0, 4))).toEqual([Math.fround(1.4), Math.fround(2.4), Math.fround(2.4), Math.fround(1.4)]);
  });

  it(`builds the whole half-arrow style in under ${MS} ms`, () => {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      const cache = noLodStyleCache(graph, style);
      best = Math.min(best, performance.now() - t0);
      expect(cache.kind).toBe("half-arrows");
    }
    console.log(`[half-arrow style] ${graph.edgeCount} edges: best of 3 ${best.toFixed(0)} ms (ceiling ${MS} ms)`);
    expect(best).toBeLessThan(MS);
  });
});
