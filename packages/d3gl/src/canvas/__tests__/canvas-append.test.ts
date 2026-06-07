import { describe, it, expect, beforeAll } from "vitest";
import { Scene } from "../../core/scene.js";
import type { RenderDelta, RenderLayer } from "../../core/index.js";

// CanvasBackend builds clip silhouettes with `new Path2D()`, which doesn't exist in
// Node. A minimal stand-in lets us drive the backend with a mock 2D context and
// COUNT its calls — so we can assert the append path is O(new) and clips ONCE,
// without a real browser. (This would have caught the per-batch re-clip regression.)
class FakePath2D {
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  closePath(): void {}
}

/** A 2D context that records how many times each method is called. */
class MockCtx {
  calls: Record<string, number> = {};
  private bump(n: string): void { this.calls[n] = (this.calls[n] ?? 0) + 1; }
  setTransform(): void { this.bump("setTransform"); }
  clearRect(): void { this.bump("clearRect"); }
  save(): void { this.bump("save"); }
  restore(): void { this.bump("restore"); }
  beginPath(): void { this.bump("beginPath"); }
  moveTo(): void { this.bump("moveTo"); }
  lineTo(): void { this.bump("lineTo"); }
  closePath(): void { this.bump("closePath"); }
  arc(): void { this.bump("arc"); }
  rect(): void { this.bump("rect"); }
  clip(): void { this.bump("clip"); }
  fill(): void { this.bump("fill"); }
  stroke(): void { this.bump("stroke"); }
  set fillStyle(_v: string) {}
  set strokeStyle(_v: string) {}
  set lineWidth(_v: number) {}
}

let CanvasBackend: typeof import("../canvas-backend.js").CanvasBackend;

beforeAll(async () => {
  (globalThis as { Path2D?: unknown }).Path2D = FakePath2D;
  ({ CanvasBackend } = await import("../canvas-backend.js"));
});

function fakeCanvas(ctx: MockCtx) {
  return { getContext: () => ctx } as unknown as HTMLCanvasElement;
}
const layerOf = (s: Scene, name: string, clipTo?: string): RenderLayer => ({
  name, buffers: s.buffers(name), drawables: s.drawables(name), clipTo,
});

describe("CanvasBackend append cost (clip-once, O(new))", () => {
  it("clips ONCE across many appends and draws only the new points each batch", () => {
    const scene = new Scene();
    scene.group("land", (b) => b.drawable("L", (c) => c.rect(0, 0, 100, 100)));
    scene.group("pts", () => {});
    const ctx = new MockCtx();
    const backend = new CanvasBackend(fakeCanvas(ctx), 200, 200);
    backend.setLayers([layerOf(scene, "land"), { ...layerOf(scene, "pts"), clipTo: "land" }]);

    ctx.calls = {}; // reset after setLayers; measure only the appends
    const BATCHES = 5;
    const PER = 3;
    for (let s = 0; s < BATCHES; s++) {
      scene.group(`d${s}`, (b) => {
        for (let i = 0; i < PER; i++) b.point(`p${s}_${i}`, 10 + i, 10, 2);
      });
      backend.appendToLayer({ name: "pts", buffers: scene.buffers(`d${s}`), drawables: scene.drawables(`d${s}`) } as RenderDelta);
    }

    // The whole point: the clip is established ONCE (transform never changed), not per batch.
    expect(ctx.calls.clip).toBe(1);
    // Only the new circles are drawn — total arcs = BATCHES*PER (O(new)), not growing per batch.
    expect(ctx.calls.arc).toBe(BATCHES * PER);
    // No full clear/redraw happened on append.
    expect(ctx.calls.clearRect ?? 0).toBe(0);
  });

  it("re-clips when the transform changes (clip is per-transform, not per-batch)", () => {
    const scene = new Scene();
    scene.group("land", (b) => b.drawable("L", (c) => c.rect(0, 0, 100, 100)));
    scene.group("pts", () => {});
    const ctx = new MockCtx();
    const backend = new CanvasBackend(fakeCanvas(ctx), 200, 200);
    backend.setLayers([layerOf(scene, "land"), { ...layerOf(scene, "pts"), clipTo: "land" }]);
    ctx.calls = {};

    const append = (s: string) => {
      scene.group(s, (b) => b.point(s, 10, 10, 2));
      backend.appendToLayer({ name: "pts", buffers: scene.buffers(s), drawables: scene.drawables(s) } as RenderDelta);
    };
    append("a");            // clip #1
    append("b");            // reuse
    backend.setTransform({ k: 2, x: 0, y: 0 }); // invalidates clip
    append("c");            // clip #2
    append("d");            // reuse
    expect(ctx.calls.clip).toBe(2); // once per distinct transform, not per batch
  });
});
