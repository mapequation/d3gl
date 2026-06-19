import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";

describe("Scene geometry", () => {
  it("packs fill geometry with a per-vertex drawableId", () => {
    const scene = new Scene();
    scene.group("cells", (g) => {
      g.drawable("a", (ctx) => {
        ctx.rect(0, 0, 10, 10);
      });
      g.drawable("b", (ctx) => {
        ctx.rect(20, 0, 10, 10);
      });
    });
    const buf = scene.buffers("cells");
    expect(buf.drawableCount).toBe(2);
    // each rect => 4 fill verts; stride 3 (x,y,drawableId)
    expect(buf.fillVertices.length).toBe(2 * 4 * 3);
    // first 4 verts carry drawableId 0, next 4 carry 1
    expect(buf.fillVertices[2]).toBe(0); // first vertex's id
    expect(buf.fillVertices[4 * 3 + 2]).toBe(1); // 5th vertex's id
    // 2 triangles per rect => 6 indices each
    expect(buf.fillIndices.length).toBe(2 * 6);
  });

  it("produces stroke geometry only when lineWidth is given", () => {
    const scene = new Scene();
    scene.group("cells", (g) => {
      g.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10)); // no stroke
      g.drawable("b", (ctx) => ctx.rect(20, 0, 10, 10), { lineWidth: 1 });
    });
    const buf = scene.buffers("cells");
    // only drawable "b" contributes stroke geometry
    expect(buf.strokeIndices.length).toBeGreaterThan(0);
    // every stroke vertex belongs to drawableId 1
    for (let i = 0; i < buf.strokeVertices.length; i += 3) {
      expect(buf.strokeVertices[i + 2]).toBe(1);
    }
  });

  it("records contiguous per-drawable buffer ranges", () => {
    const scene = new Scene();
    scene.group("cells", (g) => {
      g.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10));
      g.drawable("b", (ctx) => ctx.rect(20, 0, 10, 10));
    });
    const r0 = scene.range("cells", "a");
    const r1 = scene.range("cells", "b");
    expect(r0.fill.vertexOffset).toBe(0);
    expect(r0.fill.vertexCount).toBe(4);
    expect(r1.fill.vertexOffset).toBe(4);
    expect(r1.fill.indexOffset).toBe(6);
  });

  it("throws for an unknown group", () => {
    const scene = new Scene();
    expect(() => scene.buffers("nope")).toThrow(/unknown group/i);
  });

  it("rebases stroke vertices and indices contiguously across two stroked drawables", () => {
    const scene = new Scene();
    scene.group("cells", (g) => {
      g.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10), { lineWidth: 1 });
      g.drawable("b", (ctx) => ctx.rect(20, 0, 10, 10), { lineWidth: 1 });
    });
    const r0 = scene.range("cells", "a");
    const r1 = scene.range("cells", "b");
    // second drawable's stroke starts exactly where the first's ended
    expect(r1.stroke.vertexOffset).toBe(r0.stroke.vertexCount);
    expect(r1.stroke.indexOffset).toBe(r0.stroke.indexCount);
    // every stroke index in the packed buffer references a real vertex (rebasing held)
    const buf = scene.buffers("cells");
    const vertexCount = buf.strokeVertices.length / 3;
    for (const i of buf.strokeIndices) expect(i).toBeLessThan(vertexCount);
    // b's indices must reach into b's vertex range (proves the offset was applied)
    expect(Math.max(...buf.strokeIndices)).toBeGreaterThanOrEqual(r0.stroke.vertexCount);
  });

  it("keeps range counts coherent for a drawable with no fill (open subpath only)", () => {
    const scene = new Scene();
    scene.group("lines", (g) => {
      g.drawable(
        "L",
        (ctx) => {
          ctx.moveTo(0, 0);
          ctx.lineTo(10, 0);
          ctx.lineTo(10, 10);
        },
        { lineWidth: 1 },
      );
    });
    const r = scene.range("lines", "L");
    expect(r.fill.vertexCount).toBe(0);
    expect(r.fill.indexCount).toBe(0);
    expect(r.stroke.indexCount).toBeGreaterThan(0);
    expect(scene.buffers("lines").fillIndices.length).toBe(0);
  });

  it("defaults colors to transparent and flag to visible, one entry per drawable", () => {
    const scene = new Scene();
    scene.group("cells", (g) => {
      g.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10));
      g.drawable("b", (ctx) => ctx.rect(20, 0, 10, 10));
    });
    const buf = scene.buffers("cells");
    expect(buf.fillColors.length).toBe(2 * 4);
    expect(Array.from(buf.fillColors)).toEqual(new Array(8).fill(0));
    expect(Array.from(buf.strokeColors)).toEqual(new Array(8).fill(0));
    expect(Array.from(buf.flags)).toEqual([1, 1]);
  });

  it("range() throws for an unknown drawable", () => {
    const scene = new Scene();
    scene.group("cells", (g) => g.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10)));
    expect(() => scene.range("cells", "zzz")).toThrow(/unknown drawable/i);
  });
});

describe("Scene color & flag tables", () => {
  function twoCells() {
    const scene = new Scene();
    scene.group("cells", (g) => {
      g.drawable("a", (ctx) => ctx.rect(0, 0, 10, 10), { lineWidth: 1 });
      g.drawable("b", (ctx) => ctx.rect(20, 0, 10, 10), { lineWidth: 1 });
    });
    return scene;
  }

  it("setFill writes RGBA into the fill color table by domain id", () => {
    const scene = twoCells();
    scene.setFill("cells", "b", "#ff0000");
    const buf = scene.buffers("cells");
    // drawable "b" is drawableId 1 => bytes at offset 4
    expect(Array.from(buf.fillColors.slice(4, 8))).toEqual([255, 0, 0, 255]);
    // drawable "a" remains the default transparent
    expect(Array.from(buf.fillColors.slice(0, 4))).toEqual([0, 0, 0, 0]);
  });

  it("parses rgb()/named colors and opacity into bytes", () => {
    const scene = twoCells();
    scene.setFill("cells", "a", "rgba(0, 128, 255, 0.5)");
    const buf = scene.buffers("cells");
    const [r, g, b, a] = Array.from(buf.fillColors.slice(0, 4));
    expect([r, g, b]).toEqual([0, 128, 255]);
    expect(a).toBeGreaterThan(120); // ~0.5*255
    expect(a).toBeLessThan(135);
  });

  it("setStroke writes the stroke color table without touching geometry", () => {
    const scene = twoCells();
    const before = scene.buffers("cells");
    const fillBefore = Array.from(before.fillVertices);
    const strokeBefore = Array.from(before.strokeVertices);
    scene.setStroke("cells", "a", "#00ff00");
    const after = scene.buffers("cells");
    expect(Array.from(after.strokeColors.slice(0, 4))).toEqual([0, 255, 0, 255]);
    // geometry buffers are byte-for-byte unchanged by recolor
    expect(Array.from(after.fillVertices)).toEqual(fillBefore);
    expect(Array.from(after.strokeVertices)).toEqual(strokeBefore);
  });

  it("setFlag toggles the per-drawable flag byte", () => {
    const scene = twoCells();
    scene.setFlag("cells", "a", 0); // hide
    const buf = scene.buffers("cells");
    expect(buf.flags[0]).toBe(0);
    expect(buf.flags[1]).toBe(1);
  });

  it("throws when styling an unknown drawable", () => {
    const scene = twoCells();
    expect(() => scene.setFill("cells", "zzz", "#fff")).toThrow(/unknown drawable/i);
  });

  it("throws on an unparseable color rather than silently rendering black", () => {
    const scene = twoCells();
    expect(() => scene.setFill("cells", "a", "not-a-color")).toThrow(/invalid color/i);
  });

  it("clamps out-of-range numeric channels to 0..255 (no Uint8 wrap)", () => {
    const scene = twoCells();
    scene.setFill("cells", "a", "rgb(300, -5, 128)");
    const buf = scene.buffers("cells");
    expect(Array.from(buf.fillColors.slice(0, 4))).toEqual([255, 0, 128, 255]);
  });
});

describe("Scene declutter index", () => {
  // Three glyphs at distinct anchors, two wedges sharing one anchor (a "pie"), one anchorless.
  function mixed() {
    const scene = new Scene();
    scene.group("g", (b) => {
      b.drawable("a", (ctx) => ctx.rect(0, 0, 1, 1), { anchor: [10, 20] });
      b.drawable("pie0", (ctx) => ctx.rect(0, 0, 1, 1), { anchor: [50, 60] });
      b.drawable("pie1", (ctx) => ctx.rect(0, 0, 1, 1), { anchor: [50, 60] }); // same anchor as pie0
      b.drawable("c", (ctx) => ctx.rect(0, 0, 1, 1), { anchor: [10, 20] }); // same anchor as a
      b.drawable("free", (ctx) => ctx.rect(0, 0, 1, 1)); // no anchor
    });
    return scene;
  }

  it("collapses shared anchors to one group in first-seen order; anchorless ⇒ -1", () => {
    const { ax, ay, groupOf } = mixed().declutterIndex("g");
    // unique anchors, first-seen: [10,20] then [50,60]
    expect(Array.from(ax)).toEqual([10, 50]);
    expect(Array.from(ay)).toEqual([20, 60]);
    // a→0, pie0→1, pie1→1, c→0, free→-1
    expect(Array.from(groupOf)).toEqual([0, 1, 1, 0, -1]);
  });

  it("returns the cached instance until the group changes", () => {
    const scene = mixed();
    const first = scene.declutterIndex("g");
    expect(scene.declutterIndex("g")).toBe(first); // same object, not rebuilt
    scene.appendToGroup("g", (b) => b.drawable("d", (ctx) => ctx.rect(0, 0, 1, 1), { anchor: [99, 99] }));
    const after = scene.declutterIndex("g");
    expect(after).not.toBe(first); // append invalidated the cache
    expect(Array.from(after.ax)).toEqual([10, 50, 99]);
  });

  it("writeDeclutterFlags maps a per-group verdict onto drawables; anchorless stays visible", () => {
    const scene = mixed();
    scene.declutterIndex("g");
    // keep group 0 ([10,20] → a, c), hide group 1 ([50,60] → pie0, pie1)
    scene.writeDeclutterFlags("g", new Uint8Array([1, 0]));
    expect(Array.from(scene.buffers("g").flags)).toEqual([1, 0, 0, 1, 1]); // a, pie0, pie1, c, free
  });
});
