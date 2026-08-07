import { describe, it, expect } from "vitest";
import { cullLabels, labelCullScratch, labelGeometry, labelTransform, labelTextY, type LabelBox } from "../cull.js";

const viewport = { width: 100, height: 100 };

/** Reference implementation of the greedy cull: priority-desc, tie by input order, quadratic scan.
 *  The grid-backed {@link cullLabels} must agree with it label-for-label on any input (#204). */
function referenceCull(candidates: readonly LabelBox[], vp: { width: number; height: number }): LabelBox[] {
  const inView = candidates.filter((c) => c.x >= 0 && c.x <= vp.width && c.y >= 0 && c.y <= vp.height);
  const ordered = inView
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.priority ?? 0) - (a.c.priority ?? 0) || a.i - b.i)
    .map((e) => e.c);
  const placed: ReturnType<typeof labelGeometry>[] = [];
  const out: LabelBox[] = [];
  for (const cand of ordered) {
    const g = labelGeometry(cand);
    const hits = placed.some((p) => !(g.maxX <= p.minX || p.maxX <= g.minX || g.maxY <= p.minY || p.maxY <= g.minY));
    if (!hits) { placed.push(g); out.push(cand); }
  }
  return out;
}

describe("cullLabels", () => {
  it("keeps non-overlapping in-viewport labels", () => {
    const out = cullLabels(
      [
        { id: "a", x: 10, y: 10, width: 20, height: 10 },
        { id: "b", x: 60, y: 60, width: 20, height: 10 },
      ],
      { viewport },
    );
    expect(out.map((l) => l.id).sort()).toEqual(["a", "b"]);
  });

  it("drops labels whose anchor is outside the viewport (+padding)", () => {
    const out = cullLabels(
      [
        { id: "in", x: 50, y: 50, width: 10, height: 10 },
        { id: "out", x: 200, y: 50, width: 10, height: 10 },
      ],
      { viewport },
    );
    expect(out.map((l) => l.id)).toEqual(["in"]);
  });

  it("resolves overlap by keeping the higher-priority label", () => {
    const out = cullLabels(
      [
        { id: "low", x: 10, y: 10, width: 40, height: 20, priority: 1 },
        { id: "high", x: 15, y: 12, width: 40, height: 20, priority: 5 },
      ],
      { viewport },
    );
    expect(out.map((l) => l.id)).toEqual(["high"]);
  });

  it("places both when priority ties but they do not overlap", () => {
    const out = cullLabels(
      [
        { id: "a", x: 5, y: 5, width: 10, height: 10, priority: 1 },
        { id: "b", x: 80, y: 80, width: 10, height: 10, priority: 1 },
      ],
      { viewport },
    );
    expect(out).toHaveLength(2);
  });

  it("packs rotated labels by their true footprint, not the un-rotated box", () => {
    // Two long labels stacked vertically, each rotated to read straight up (-90°). As
    // un-rotated 60×12 boxes they would overlap (wide horizontal strips); as vertical
    // boxes (12 wide, 60 tall) sitting 16px apart they do not.
    const rotation = -Math.PI / 2;
    const labels = [
      { id: "a", x: 50, y: 50, width: 60, height: 12, rotation, priority: 1 },
      { id: "b", x: 66, y: 50, width: 60, height: 12, rotation, priority: 1 },
    ];
    expect(cullLabels(labels, { viewport }).map((l) => l.id).sort()).toEqual(["a", "b"]);
    // Same anchors WITHOUT rotation collide → only the first survives.
    const flat = labels.map(({ rotation: _r, ...rest }) => rest);
    expect(cullLabels(flat, { viewport })).toHaveLength(1);
  });

  it("still resolves genuine overlap between rotated labels", () => {
    const rotation = -Math.PI / 2;
    const out = cullLabels(
      [
        { id: "low", x: 50, y: 50, width: 60, height: 12, rotation, priority: 1 },
        { id: "high", x: 53, y: 55, width: 60, height: 12, rotation, priority: 5 },
      ],
      { viewport },
    );
    expect(out.map((l) => l.id)).toEqual(["high"]);
  });
});

// #204: the greedy scan is grid-backed, and plain labels can declare where the anchor sits inside
// the box (so a centred label collides on the box it actually renders in).
describe("cullLabels — grid-backed placement (#204)", () => {
  it("agrees label-for-label with the quadratic reference on a dense random field", () => {
    // 1200 boxes of mixed sizes and priorities in a 100×100 viewport: a heavy-collision field where
    // an inexact neighbourhood (too-small cells, missed 3×3 wrap) would drop or keep the wrong ones.
    let seed = 12345;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const candidates: LabelBox[] = [];
    for (let i = 0; i < 1200; i++) {
      candidates.push({
        id: i,
        x: rnd() * 110 - 5, // some out of the viewport, to exercise the anchor filter
        y: rnd() * 110 - 5,
        width: 4 + rnd() * 40,
        height: 6 + rnd() * 10,
        priority: Math.floor(rnd() * 7),
        textAnchor: rnd() < 0.5 ? "middle" : "start",
        baseline: rnd() < 0.5 ? "middle" : "top",
      });
    }
    const got = cullLabels(candidates, { viewport });
    const want = referenceCull(candidates, viewport);
    expect(got.map((l) => l.id)).toEqual(want.map((l) => l.id));
    expect(got.length).toBeGreaterThan(5); // non-vacuous: the field really does place labels
    expect(got.length).toBeLessThan(candidates.length / 2); // …and really does reject most of them
  });

  it("keeps a centred label's box centred on the anchor, so a stack of them culls to one", () => {
    // Five labels on the SAME anchor: as centred boxes they all overlap → exactly one survives.
    const stack: LabelBox[] = [0, 1, 2, 3, 4].map((i) => ({
      id: i, x: 50, y: 50, width: 40, height: 12, priority: i, textAnchor: "middle", baseline: "middle",
    }));
    expect(cullLabels(stack, { viewport }).map((l) => l.id)).toEqual([4]); // the highest priority
  });

  it("reuses a caller-owned scratch across calls without changing the result", () => {
    const scratch = labelCullScratch();
    const boxes: LabelBox[] = [
      { id: "a", x: 10, y: 10, width: 20, height: 10 },
      { id: "b", x: 12, y: 12, width: 20, height: 10 },
      { id: "c", x: 70, y: 70, width: 20, height: 10 },
    ];
    const first = cullLabels(boxes, { viewport, scratch }).map((l) => l.id);
    const second = cullLabels(boxes, { viewport, scratch }).map((l) => l.id);
    expect(first).toEqual(["a", "c"]);
    expect(second).toEqual(first); // retained buffers are reset per call, not carried over
    // The overlap-test counter is the per-frame signature: linear in candidates, not quadratic.
    expect(scratch.lastTests).toBeLessThanOrEqual(boxes.length * 8);
  });
});

describe("labelGeometry", () => {
  it("returns the axis-aligned top-left box for a plain label", () => {
    const g = labelGeometry({ id: "a", x: 10, y: 20, width: 30, height: 12 });
    expect(g.axisAligned).toBe(true);
    expect([g.minX, g.minY, g.maxX, g.maxY]).toEqual([10, 20, 40, 32]);
    expect(g.transform).toBe("");
  });

  it("derives a transform and oriented box for a rotated upright label", () => {
    // 90° outward radius at the top of a radial fan: text reads bottom-to-top, vertically
    // centred on the anchor. The CSS matches the classic radial-tree rotate/translate idiom.
    const g = labelGeometry({
      id: "a", x: 0, y: 0, width: 40, height: 12, rotation: -Math.PI / 2, keepUpright: true,
    });
    expect(g.axisAligned).toBe(false);
    expect(g.transform).toBe("rotate(-90deg) translate(0%, -50%)");
    // Box: ~12 wide (height), ~40 tall (width), extending upward (negative y) from the anchor.
    expect(g.maxX - g.minX).toBeCloseTo(12);
    expect(g.maxY - g.minY).toBeCloseTo(40);
    expect(g.minY).toBeCloseTo(-40);
    expect(g.maxY).toBeCloseTo(0);
  });

  it("places a plain label's box by textAnchor/baseline and derives the matching CSS (#204)", () => {
    const centred: LabelBox = { id: "a", x: 100, y: 50, width: 40, height: 12, textAnchor: "middle", baseline: "middle" };
    const g = labelGeometry(centred);
    expect(g.axisAligned).toBe(true);
    expect([g.minX, g.minY, g.maxX, g.maxY]).toEqual([80, 44, 120, 56]);
    // One description: the CSS transform the overlay renders with comes from the same alignment.
    expect(g.transform).toBe("translate(-50%, -50%)");
    expect(labelTransform(centred)).toBe(g.transform);
    // …and so does the y a "middle"-baseline backend draws native text at.
    expect(labelTextY(centred)).toBeCloseTo((g.minY + g.maxY) / 2);

    const endTop: LabelBox = { id: "b", x: 100, y: 50, width: 40, height: 12, textAnchor: "end" };
    expect(labelGeometry(endTop).minX).toBe(60);
    expect(labelTransform(endTop)).toBe("translate(-100%, 0%)");
    expect(labelTextY(endTop)).toBeCloseTo(56); // top-left box → vertical centre is y + height/2
  });

  it("leaves the historical top-left box (and an empty transform) when no alignment is declared", () => {
    const plain: LabelBox = { id: "a", x: 10, y: 20, width: 30, height: 12 };
    expect(labelTransform(plain)).toBe(""); // "" ⇒ the caller's own `transform` still wins
    expect(labelGeometry(plain).minX).toBe(10);
  });

  it("flips to stay upright on the far side and swaps the text side", () => {
    // Reading direction points left (cos < 0) → +180° and start→end so text still radiates out.
    // rotation = -π is the west pole of a radial fan (tree-angle -π/2).
    const g = labelGeometry({
      id: "a", x: 0, y: 0, width: 40, height: 12, rotation: -Math.PI, keepUpright: true,
    });
    expect(g.transform).toBe("rotate(0deg) translate(-100%, -50%)");
  });
});
