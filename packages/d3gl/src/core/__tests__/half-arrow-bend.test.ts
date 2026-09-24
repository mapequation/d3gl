import { describe, it, expect } from "vitest";
import { halfArrowsToDrawables } from "../instanced-vector.js";
import type { InstancedHalfArrowsData } from "../backend.js";

// #296: a half-arrow's `bend` is a fraction of the chord, so in screen sizeMode (px sizes, baked at the
// current zoom `k`) the bow must scale with the link's on-screen length. It used to be an absolute px
// offset: zooming out shrank the chord but not the bow, so short links bulged into near-semicircles.
// The export path runs the same px-space solve the WebGL shader does, so it is the CPU probe for both.
describe("half-arrow bend is a fraction of the chord (#296)", () => {
  const data = (bend: number): InstancedHalfArrowsData => ({
    sources: Float32Array.from([0, 0]),
    targets: Float32Array.from([400, 0]),
    radii: Float32Array.from([6, 6]), // px in screen mode
    widths: Float32Array.from([2, 2]), // px in screen mode
    bends: Float32Array.from([bend]),
    colors: Uint8Array.from([0, 0, 0, 255]),
    count: 1,
  });

  /** Screen-px ⟂ offset of the inner (centre) curve at mid-chord, over the chord's screen-px length. */
  const apexPerChord = (bend: number, k: number): number => {
    const d = halfArrowsToDrawables(data(bend), k)[0];
    expect(d).toBeDefined();
    // The inner edge is the part of the outline nearest the chord at mid-span; the strip width and
    // barb sit outside it, so this reads the bow alone (quadratic apex = bend·|chord| / 2).
    let apex = Infinity;
    for (const sp of d?.subpaths ?? [])
      for (let i = 0; i + 1 < sp.points.length; i += 2)
        if (Math.abs((sp.points[i] ?? 0) - 200) < 20) apex = Math.min(apex, Math.abs(sp.points[i + 1] ?? 0));
    return (apex * k) / (400 * k);
  };

  it("keeps the bow's size relative to the link across a zoom sweep (screen-mode bake)", () => {
    // Chord 400 world units → 1600 px at k=4 down to 100 px at k=0.25. An absolute-px bend held the
    // apex at a constant px size, so its share of the chord grew 16× over this sweep. What remains is
    // the constant-px node radius + tip clearance lifting the curve's ends (they aim at the control),
    // which only dominates once the link is a few node-radii long (≈1.7× at 40 px).
    const shares = [4, 1, 0.25].map((k) => apexPerChord(0.15, k));
    for (const share of shares) expect(share).toBeGreaterThan(0.07); // a genuine bow (quadratic apex ≈ bend/2)
    expect(Math.max(...shares) / Math.min(...shares)).toBeLessThan(1.4);
  });
});
