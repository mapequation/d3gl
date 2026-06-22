import { describe, it, expect } from "vitest";
import { halfLinkGeometry, halfLinkPathString, traceHalfLink, type PathSink } from "../half-link.js";

/**
 * Golden test: the half-arrow geometry is a clean-room port of mapequation's `network-rendering`
 * `halfLink()`. These two path strings are `example.svg` from that repo, produced by its `example/`
 * config — nodeRadius scale domain[0.4,0.6]→[20,30], linkWidth scale domain[0.3,0.5]→[7,13], default
 * bend 30. If our port drifts from the reference, this fails to the bit.
 *
 *   node 0: (100,100) flow 0.6 → r 30 ;  node 1: (300,180) flow 0.4 → r 20
 *   link 0→1: flow 0.5 → width 13 (opposite 7) ;  link 1→0: flow 0.3 → width 7 (opposite 13)
 */
const REF_0_TO_1 =
  "M 139.24197641757587 129.55937359803397 L 100 100 L 92.17835865232708 110.38373375180495 L 131.42033506990293 139.94310734983893 Q 186.06100621617148 182.4082086619766, 255.38959516802078 188.5043010990391 L 254.65574554281218 195.67796576415842 L 280.10383401302164 177.96466734448492 L 256.7125613941056 175.5717932075032 Q 191.46542598606837 168.89715923723435, 139.24197641757587 129.55937359803397 Z";
const REF_1_TO_0 =
  "M 256.7125613941056 175.5717932075032 L 300 180 L 300.7123664294303 173.0363419045576 L 257.4249278235359 168.60813511206078 Q 194.64150169784065 160.95696995780366, 143.45362945093822 123.96813234706208 L 146.63733988944324 119.74155124127999 L 123.96246250416526 118.0499415715529 L 139.24197641757587 129.55937359803397 Q 191.46542598606837 168.89715923723435, 256.7125613941056 175.5717932075032 Z";

describe("halfLinkPathString — golden vs network-rendering example.svg", () => {
  it("reproduces the 0→1 link path exactly", () => {
    const path = halfLinkPathString({ x0: 100, y0: 100, r0: 30, x1: 300, y1: 180, r1: 20, width: 13, oppositeWidth: 7, bend: 30 });
    expect(path).toBe(REF_0_TO_1);
  });

  it("reproduces the reciprocal 1→0 link path exactly", () => {
    const path = halfLinkPathString({ x0: 300, y0: 180, r0: 20, x1: 100, y1: 100, r1: 30, width: 7, oppositeWidth: 13, bend: 30 });
    expect(path).toBe(REF_1_TO_0);
  });
});

describe("halfLinkGeometry", () => {
  it("pinches the strip to the source centre and lands the tip on the target boundary", () => {
    const g = halfLinkGeometry({ x0: 100, y0: 100, r0: 30, x1: 300, y1: 180, r1: 20, width: 13, oppositeWidth: 7, bend: 30 })!;
    // The strip visits the exact source centre (the foot).
    expect([g.x0, g.y0]).toEqual([100, 100]);
    // The arrow tip sits on the target node's circle: distance from (300,180) == r1 (20).
    expect(Math.hypot(g.x11 - 300, g.y11 - 180)).toBeCloseTo(20, 6);
  });

  it("bows a reciprocal pair to the same world side (shared centre curve)", () => {
    const f = halfLinkGeometry({ x0: 100, y0: 100, r0: 30, x1: 300, y1: 180, r1: 20, width: 13, oppositeWidth: 7, bend: 30 })!;
    const b = halfLinkGeometry({ x0: 300, y0: 180, r0: 20, x1: 100, y1: 100, r1: 30, width: 7, oppositeWidth: 13, bend: 30 })!;
    // The 0→1 inner control bows downward (＋y in screen space) rather than splaying outward; the
    // reciprocal link's control is near the same side, so the two nest around one shared curve.
    expect(f.cp1y).toBeGreaterThan(140); // below the chord midpoint (~140)
    expect(Math.sign(f.cp1y - 140)).toBe(Math.sign(b.cp1y - 140));
  });

  it("returns null when nodes overlap and the bend is too small to route around them", () => {
    expect(halfLinkGeometry({ x0: 0, y0: 0, r0: 30, x1: 10, y1: 0, r1: 30, width: 5, bend: 10 })).toBeNull();
  });
});

describe("traceHalfLink", () => {
  it("emits the same command sequence the reference path uses", () => {
    const g = halfLinkGeometry({ x0: 100, y0: 100, r0: 30, x1: 300, y1: 180, r1: 20, width: 13, oppositeWidth: 7, bend: 30 })!;
    const cmds: string[] = [];
    const sink: PathSink = {
      moveTo: () => cmds.push("M"),
      lineTo: () => cmds.push("L"),
      quadraticCurveTo: () => cmds.push("Q"),
      closePath: () => cmds.push("Z"),
    };
    traceHalfLink(g, sink);
    expect(cmds.join("")).toBe("MLLLQLLLQZ");
  });
});
