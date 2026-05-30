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
