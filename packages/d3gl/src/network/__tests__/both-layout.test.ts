import { describe, it, expect } from "vitest";
import { packStateNodes } from "../both-layout.js";
import { buildStateGraph } from "../state-graph.js";
import { csrOf, enclosureExcess, flowRadii, overlaps, paretoSizes, seeded } from "./_both-pack.js";
import type { PhysicalToState } from "../state-graph.js";

/** Pack, then assert the two invariants: no overlapping pair and every state node within its physical node. */
function packChecked(radii: Float32Array, csr: PhysicalToState, padding = 0) {
  const packed = packStateNodes(radii, csr, { padding });
  const report = overlaps(packed.offsets, radii, csr);
  expect(report, `overlapping pairs (worst ${report.worst})`).toEqual({ pairs: 0, worst: 0 });
  expect(enclosureExcess(packed.offsets, radii, packed.radii, csr, padding)).toBeLessThanOrEqual(0);
  return packed;
}

describe("packStateNodes (#509, the both view's area spiral)", () => {
  it("encloses equal state nodes without overlap", () => {
    const sizes = [3, 7, 16, 17, 50, 1000];
    const csr = csrOf(sizes);
    packChecked(new Float32Array(csr.states.length).fill(5), csr, 1.5);
  });

  it("encloses random and flow-like radii without overlap, in physical nodes of every size", () => {
    const rng = seeded(7);
    const sizes = Uint32Array.from({ length: 400 }, () => 1 + Math.floor(rng() * 60));
    const csr = csrOf(sizes);
    const uniform = Float32Array.from({ length: csr.states.length }, () => 0.5 + rng() * 30);
    packChecked(uniform, csr, 2);
    packChecked(flowRadii(csr.states.length, rng), csr, 0);
  });

  it("encloses Pareto-sized physical nodes without overlap", () => {
    const rng = seeded(11);
    const csr = csrOf(paretoSizes(60_000, 1.18, 5_000, rng));
    packChecked(flowRadii(csr.states.length, rng), csr, 1);
  });

  it("clears the step from a few large radii to many small ones (ratios up to 1000)", () => {
    const rng = seeded(3);
    const csr = csrOf([20, 300, 3000]);
    const radii = Float32Array.from({ length: csr.states.length }, () => (rng() < 0.03 ? 100 + rng() * 900 : 1 + rng()));
    packChecked(radii, csr, 0);
  });

  it("packs 100k state nodes in one physical node without overlap", () => {
    const rng = seeded(5);
    const csr = csrOf([100_000]);
    const radii = flowRadii(100_000, rng);
    const packed = packChecked(radii, csr, 0);
    let area = 0;
    for (const r of radii) area += r * r;
    // The spiral holds the area at a fill of 0.62: the physical node is near sqrt(Σr² / 0.62), pushes included.
    expect(packed.radii[0]).toBeLessThan(1.1 * Math.sqrt(area / 0.62) + 20);
  });

  it("puts a lone state node at offset 0 and sizes its physical node to its radius plus the padding", () => {
    const csr = csrOf([1]);
    const { offsets, radii } = packChecked(Float32Array.of(4), csr, 2);
    expect(Array.from(offsets)).toEqual([0, 0]);
    expect(radii[0]).toBe(6);
  });

  it("centres two state nodes on their enclosing circle: the radius is the sum of theirs, plus the padding", () => {
    const csr = csrOf([2, 2]);
    const { offsets, radii } = packChecked(Float32Array.of(3, 5, 4, 4), csr, 2);
    expect(radii[0]).toBeCloseTo(3 + 5 + 2, 4);
    expect(radii[1]).toBeCloseTo(4 + 4 + 2, 4); // equal radii: 2r, not 3r with the larger at the centre
    // Each touches the enclosing circle: |offset| + r = the radius minus the padding.
    expect(Math.hypot(offsets[0] ?? 0, offsets[1] ?? 0) + 3).toBeCloseTo(8, 4);
    expect(Math.hypot(offsets[2] ?? 0, offsets[3] ?? 0) + 5).toBeCloseTo(8, 4);
    expect(Math.hypot(offsets[4] ?? 0, offsets[5] ?? 0)).toBeCloseTo(4, 4);
    // Just clear of each other.
    const d = Math.hypot((offsets[0] ?? 0) - (offsets[2] ?? 0), (offsets[1] ?? 0) - (offsets[3] ?? 0));
    expect(d).toBeGreaterThanOrEqual(8);
    expect(d).toBeLessThan(8.001);
  });

  it("centres each physical node on its smallest enclosing circle: at least two state nodes touch it", () => {
    const rng = seeded(13);
    const csr = csrOf(Uint32Array.from({ length: 300 }, () => 2 + Math.floor(rng() * 63))); // 2–64: the exact circle
    const radii = flowRadii(csr.states.length, rng);
    const { offsets, radii: physical } = packChecked(radii, csr, 0);
    for (let p = 0; p < 300; p++) {
      const start = csr.offsets[p] ?? 0;
      const end = csr.offsets[p + 1] ?? 0;
      const R = physical[p] ?? 0;
      let touching = 0;
      let largest = start;
      for (let k = start; k < end; k++) {
        const s = csr.states[k] ?? 0;
        if ((radii[s] ?? 0) > (radii[csr.states[largest] ?? 0] ?? 0)) largest = k;
        if (Math.hypot(offsets[2 * s] ?? 0, offsets[2 * s + 1] ?? 0) + (radii[s] ?? 0) > R * (1 - 1e-5)) touching++;
      }
      expect(touching, `physical node ${p}`).toBeGreaterThanOrEqual(2);
      // Never larger than with the largest state node at the centre, as before the centring.
      const l = csr.states[largest] ?? 0;
      let lopsided = 0;
      for (let k = start; k < end; k++) {
        const s = csr.states[k] ?? 0;
        const dx = (offsets[2 * s] ?? 0) - (offsets[2 * l] ?? 0);
        const dy = (offsets[2 * s + 1] ?? 0) - (offsets[2 * l + 1] ?? 0);
        lopsided = Math.max(lopsided, Math.hypot(dx, dy) + (radii[s] ?? 0));
      }
      expect(R).toBeLessThanOrEqual(lopsided * (1 + 1e-6));
    }
  });

  it("gives a physical node with no state nodes the padding alone as its radius", () => {
    const csr = csrOf([2, 0, 1]);
    const { radii } = packChecked(Float32Array.of(1, 1, 1), csr, 3);
    expect(radii[1]).toBe(3);
  });

  it("places radius-0 state nodes clear of the others, and all at offset 0 when every radius is 0", () => {
    const csr = csrOf([30, 5]);
    const radii = new Float32Array(35);
    for (let s = 0; s < 20; s++) radii[s] = 2 + (s % 3);
    radii[25] = Number.NaN; // taken as 0
    radii[26] = -1;
    const { offsets, radii: physical } = packChecked(radii, csr, 1);
    for (let s = 20; s < 30; s++) {
      for (let o = 0; o < 20; o++) {
        const d = Math.hypot((offsets[2 * s] ?? 0) - (offsets[2 * o] ?? 0), (offsets[2 * s + 1] ?? 0) - (offsets[2 * o + 1] ?? 0));
        expect(d).toBeGreaterThanOrEqual(radii[o] ?? 0);
      }
    }
    expect(Array.from(offsets.subarray(60, 70))).toEqual(new Array(10).fill(0));
    expect(physical[1]).toBe(1);
  });

  it("is deterministic: the same input, a reused output or a reordered CSR give the same output", () => {
    const rng = seeded(9);
    const csr = csrOf([1, 2, 40, 500]);
    const radii = flowRadii(csr.states.length, rng);
    for (let s = 0; s < radii.length; s += 7) radii[s] = 4; // ties, broken by state id
    const a = packStateNodes(radii, csr, { padding: 1 });
    const b = packStateNodes(radii, csr, { padding: 1 });
    expect(b.offsets).toEqual(a.offsets);
    expect(b.radii).toEqual(a.radii);

    const reused = packStateNodes(radii, csr, { padding: 1, offsets: new Float32Array(a.offsets.length).fill(9), radii: new Float32Array(4) });
    expect(reused.offsets).toEqual(a.offsets);
    expect(reused.radii).toEqual(a.radii);

    const reversed: PhysicalToState = { offsets: csr.offsets, states: csr.states.slice() };
    for (let p = 0; p < 4; p++) reversed.states.subarray(csr.offsets[p], csr.offsets[p + 1]).reverse();
    const c = packStateNodes(radii, reversed, { padding: 1 });
    expect(c.offsets).toEqual(a.offsets);
    expect(c.radii).toEqual(a.radii);
  });

  it("takes the state graph's CSR as built", () => {
    const graph = buildStateGraph({ stateCount: 5, stateToPhysical: [1, 0, 1, 1, 0], source: [0], target: [1] });
    const radii = Float32Array.of(2, 3, 2, 1, 3);
    const { offsets, radii: physical } = packChecked(radii, graph.physicalToState, 0);
    expect(offsets.length).toBe(10);
    expect(physical.length).toBe(2);
  });

  it("refuses arrays of the wrong length", () => {
    const csr = csrOf([2]);
    expect(() => packStateNodes(Float32Array.of(1), csr)).toThrow(/nodeRadii length/);
    expect(() => packStateNodes(Float32Array.of(1, 1), csr, { offsets: new Float32Array(3) })).toThrow(/offsets length/);
    expect(() => packStateNodes(Float32Array.of(1, 1), csr, { radii: new Float32Array(2) })).toThrow(/radii length/);
  });
});
