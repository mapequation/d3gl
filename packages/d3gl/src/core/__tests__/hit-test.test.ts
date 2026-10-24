import { describe, it, expect } from "vitest";
import { Scene } from "../scene.js";
import { HitIndex } from "../hit-test.js";
import type { PathRecorder } from "../path-recorder.js";

const ID = { k: 1, x: 0, y: 0 }; // identity transform: screen == world

describe("HitIndex", () => {
  it("returns the topmost filled drawable under a point, -1 on miss", () => {
    const scene = new Scene();
    scene.group("g", (b) => {
      b.drawable("base", (ctx) => ctx.rect(0, 0, 100, 100));
      b.drawable("top", (ctx) => ctx.rect(40, 40, 20, 20)); // overlaps base
    });
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(50, 50, ID)).toBe("top");   // overlap -> topmost
    expect(idx.pick(10, 10, ID)).toBe("base");  // base only
    expect(idx.pick(200, 200, ID)).toBe(null);  // miss
  });

  it("skips hidden drawables and hits strokes near the line", () => {
    const scene = new Scene();
    scene.group("g", (b) => {
      b.drawable("hidden", (ctx) => ctx.rect(0, 0, 100, 100));
      b.drawable("line", (ctx) => { ctx.moveTo(0, 50); ctx.lineTo(100, 50); }, { lineWidth: 4 });
    });
    scene.setFlag("g", "hidden", 0);
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(50, 50, ID)).toBe("line");   // on the line, hidden fill skipped
    expect(idx.pick(50, 70, ID)).toBe(null);     // far from line, fill hidden
  });

  it("padFills: a 1 px filled directed link hits ~1.5 px off its centre line, as its stroke did (#542)", () => {
    // The outline of a 1 px directed link along +x: a shaft from x=0 to the head's base at x=90, then the head.
    const arrow = (ctx: PathRecorder) => {
      ctx.moveTo(0, 49.5); ctx.lineTo(90, 49.5); ctx.lineTo(90, 47); ctx.lineTo(100, 50);
      ctx.lineTo(90, 53); ctx.lineTo(90, 50.5); ctx.lineTo(0, 50.5); ctx.closePath();
    };
    const scene = new Scene();
    scene.group("links", (b) => b.drawable("e", arrow));
    scene.group("stroke", (b) => b.drawable("e", (ctx) => { ctx.moveTo(0, 50); ctx.lineTo(90, 50); }, { lineWidth: 1 }));
    const padded = new HitIndex(scene.drawables("links"), 1, false, true);
    const stroked = new HitIndex(scene.drawables("stroke"));
    const plain = new HitIndex(scene.drawables("links"));
    // 1.4 px off the centre line (0.9 px off the edge): the stroke's band (½·1 + 1 px), and the padded fill's.
    expect(stroked.pick(40, 51.4, ID)).toBe("e");
    expect(padded.pick(40, 51.4, ID)).toBe("e");
    expect(padded.pick(40, 48.6, ID)).toBe("e");
    expect(padded.pick(40, 52, ID)).toBe(null); // 1.5 px off the edge: outside the pad
    expect(padded.pick(40, 50, ID)).toBe("e"); // inside
    // Without the opt-in a fill hits inside only (every other layer's fills keep that).
    expect(plain.pick(40, 51.4, ID)).toBe(null);
    expect(plain.pick(40, 50, ID)).toBe("e");
  });

  it("hits circle drawables within the radius", () => {
    const scene = new Scene();
    scene.group("g", (b) => b.point("dot", 50, 50, 5));
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(52, 52, ID)).toBe("dot");   // inside r=5
    expect(idx.pick(60, 60, ID)).toBe(null);    // outside
  });

  it("screen-mode picks at the rendered pixel size around the projected anchor (not scaled by zoom)", () => {
    const scene = new Scene();
    scene.group("g", (b) => b.point("dot", 50, 50, 5)); // world (50,50), 5px radius
    const idx = new HitIndex(scene.drawables("g"), 1, /* screenMode */ true);
    const t = { k: 2, x: 0, y: 0 }; // dot renders centered at screen (100,100), radius STAYS 5px

    expect(idx.pick(100, 100, t)).toBe("dot"); // projected center
    expect(idx.pick(104, 100, t)).toBe("dot"); // 4px in — inside the 5px dot
    expect(idx.pick(108, 100, t)).toBe(null);  // 8px in — outside (world mode would accept 10px)
  });

  it("append() makes new drawables pickable without disturbing existing ones", () => {
    const scene = new Scene();
    scene.group("g", (b) => b.point("a", 50, 50, 5));
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(50, 50, ID)).toBe("a");

    const before = scene.drawableCount("g");
    scene.appendToGroup("g", (b) => b.point("b", 150, 150, 5));
    idx.append(scene.drawables("g").slice(before)); // index only the newly appended drawables
    expect(idx.pick(150, 150, ID)).toBe("b"); // new one hits
    expect(idx.pick(50, 50, ID)).toBe("a");    // old one still hits
    expect(idx.pick(100, 100, ID)).toBe(null); // gap between them misses
  });

  it("picks an island inside a lake, and misses the lake (#73)", () => {
    // land ▸ lake ▸ island, each ring wound opposite to the one enclosing it — the
    // convention geoPath emits. HitIndex classifies rings with the same `groupRings`
    // the fill does, so hit-testing must agree with what the user sees.
    const square = (lo: number, hi: number, ccw: boolean): [number, number][] =>
      ccw
        ? [[lo, lo], [hi, lo], [hi, hi], [lo, hi]]
        : [[lo, lo], [lo, hi], [hi, hi], [hi, lo]];
    const scene = new Scene();
    scene.group("g", (b) => {
      b.drawable("atoll", (ctx) => {
        for (const ring of [square(0, 100, true), square(20, 80, false), square(40, 60, true)]) {
          ctx.moveTo(ring[0]?.[0] ?? 0, ring[0]?.[1] ?? 0);
          for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i]?.[0] ?? 0, ring[i]?.[1] ?? 0);
          ctx.closePath();
        }
      });
    });
    const idx = new HitIndex(scene.drawables("g"));
    expect(idx.pick(10, 10, ID)).toBe("atoll"); // land
    expect(idx.pick(30, 30, ID)).toBe(null);    // lake — a hole
    expect(idx.pick(50, 50, ID)).toBe("atoll"); // island inside the lake
  });
});
