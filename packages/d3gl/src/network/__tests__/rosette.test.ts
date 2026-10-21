import { describe, it, expect } from "vitest";
import { buildStateGraph } from "../state-graph.js";
import { rosetteOffsets, rosettePositions } from "../rosette.js";

// Physical A(0): state nodes 0,1,2; Physical B(1): a lone state node 3.
const graph = buildStateGraph({
  stateCount: 4,
  stateToPhysical: [0, 0, 0, 1],
  source: [0, 3],
  target: [3, 0],
  directed: true,
});

describe("rosettePositions", () => {
  it("places a lone state node exactly on its physical centre", () => {
    graph.physical.positions.set([10, 20, 100, 200]); // A at (10,20), B at (100,200)
    const out = rosettePositions(graph, { radius: 8 });
    expect(out[2 * 3]).toBeCloseTo(100); // state 3 (only one at B) sits on B
    expect(out[2 * 3 + 1]).toBeCloseTo(200);
  });

  it("fans a physical node's state nodes onto a disc within the radius (containment)", () => {
    graph.physical.positions.set([10, 20, 100, 200]);
    const R = 8;
    const out = rosettePositions(graph, { radius: R });
    for (const s of [0, 1, 2]) {
      const dx = out[2 * s]! - 10;
      const dy = out[2 * s + 1]! - 20;
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(R + 1e-4); // inside physical A's disc
    }
    // The three state nodes are distinct points (a rosette, not coincident).
    const keys = new Set([0, 1, 2].map((s) => `${out[2 * s]!.toFixed(4)},${out[2 * s + 1]!.toFixed(4)}`));
    expect(keys.size).toBe(3);
  });

  it("is deterministic (identical inputs → identical output)", () => {
    graph.physical.positions.set([10, 20, 100, 200]);
    const a = rosettePositions(graph, { radius: 8, rotate: 0.3 });
    const b = rosettePositions(graph, { radius: 8, rotate: 0.3 });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("returns a state-length interleaved array", () => {
    const out = rosettePositions(graph);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(4 * 2);
  });
});

describe("rosetteOffsets (#495)", () => {
  it("is the rosette of a constant radius relative to each physical node: positions minus their centre", () => {
    graph.physical.positions.set([10, 20, -5, 7]);
    const pos = rosettePositions(graph, { radius: 0.72 });
    const off = rosetteOffsets(graph, 0.72);
    for (let s = 0; s < graph.state.nodeCount; s++) {
      const p = graph.stateToPhysical[s]!;
      expect(off[2 * s]).toBeCloseTo(pos[2 * s]! - graph.physical.positions[2 * p]!, 5);
      expect(off[2 * s + 1]).toBeCloseTo(pos[2 * s + 1]! - graph.physical.positions[2 * p + 1]!, 5);
      expect(Math.hypot(off[2 * s]!, off[2 * s + 1]!)).toBeLessThanOrEqual(0.72 + 1e-6); // inside the unit container's rosette
    }
    expect(off[6]).toBe(0); // the lone state node sits on its physical node
    expect(off[7]).toBe(0);
  });
});
