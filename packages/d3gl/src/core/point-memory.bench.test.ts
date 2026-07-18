import { describe, it } from "vitest";
import { appendFileSync } from "node:fs";
import { Scene } from "./scene.js";

const OUT = "/tmp/point-memory.txt";

// Spike: quantify the heap cost of retaining points, to ground the pass-through
// design. Not an assertion test — it measures bytes/point and the extrapolated
// crash ceiling, writing results to /tmp/point-memory.txt.
//
// SKIPPED in the regular suite (it allocates ~100s of MB and adds wall-time).
// Run it deliberately:
//   rm -f /tmp/point-memory.txt
//   BENCH_MEM=1 NODE_OPTIONS=--expose-gc npx vitest run \
//     packages/d3gl/src/core/point-memory.bench.test.ts --no-file-parallelism
//   cat /tmp/point-memory.txt
const RUN = !!process.env.BENCH_MEM;

function gc() {
  const g = (globalThis as unknown as { gc?: () => void }).gc;
  if (g) {
    g();
    g();
  }
}

function heap(): number {
  gc();
  // heapUsed alone misses typed-array backing stores (ArrayBuffers live OUTSIDE the V8
  // heap); include them or any boxed→typed move (#207) looks free and typed copies look
  // like zero bytes.
  const mu = process.memoryUsage();
  return mu.heapUsed + mu.arrayBuffers;
}

function report(label: string, n: number, bytes: number) {
  const perPoint = bytes / n;
  const ceil = (budgetGB: number) =>
    ((budgetGB * 1024 ** 3) / perPoint / 1e6).toFixed(1) + "M";
  appendFileSync(
    OUT,
    `${label.padEnd(42)} ${(bytes / 1024 / 1024).toFixed(1).padStart(8)} MB  ` +
      `${perPoint.toFixed(0).padStart(5)} B/pt   ` +
      `ceiling@2GB=${ceil(2).padStart(7)}  @4GB=${ceil(4).padStart(7)}\n`,
  );
}

describe.skipIf(!RUN)("point memory baseline", () => {
  const N = 1_000_000;

  it("raw user data: Float32Array [x,y] (the floor)", () => {
    const before = heap();
    const xy = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      xy[i * 2] = (i % 360) - 180;
      xy[i * 2 + 1] = (i % 180) - 90;
    }
    const after = heap();
    if (xy[0] === 12345) throw new Error("unreachable");
    report("raw Float32Array [x,y]", N, after - before);
  });

  it("raw user data: array of {x,y} objects", () => {
    const before = heap();
    const arr: { x: number; y: number }[] = [];
    for (let i = 0; i < N; i++) arr.push({ x: (i % 360) - 180, y: (i % 180) - 90 });
    const after = heap();
    if (arr.length !== N) throw new Error("unreachable");
    report("raw [{x,y}] objects", N, after - before);
  });

  it("d3gl Scene: points() — many centers, ONE drawable (batched)", () => {
    const before = heap();
    const centers: [number, number][] = [];
    for (let i = 0; i < N; i++) centers.push([(i % 360) - 180, (i % 180) - 90]);
    const scene = new Scene();
    scene.group("pts", (g) => g.points("all", centers, 2));
    const after = heap();
    if (scene.drawableCount("pts") !== 1) throw new Error("unreachable");
    report("Scene points() — 1 drawable (batched)", N, after - before);
  });

  it("d3gl Scene: points() + buffers() assembled (GPU-ready)", () => {
    const before = heap();
    const centers: [number, number][] = [];
    for (let i = 0; i < N; i++) centers.push([(i % 360) - 180, (i % 180) - 90]);
    const scene = new Scene();
    scene.group("pts", (g) => g.points("all", centers, 2));
    const buf = scene.buffers("pts");
    const after = heap();
    if (buf.pointCount !== N) throw new Error("unreachable");
    report("Scene points() + buffers() (both forms)", N, after - before);
  });

  it("d3gl Scene: point() — ONE drawable per point (streaming CSV case)", () => {
    const M = 200_000; // smaller; this is the expensive path
    const before = heap();
    const scene = new Scene();
    scene.group("pts", (g) => {
      for (let i = 0; i < M; i++) g.point(i, (i % 360) - 180, (i % 180) - 90, 2);
    });
    const after = heap();
    if (scene.drawableCount("pts") !== M) throw new Error("unreachable");
    report("Scene point() — 1 drawable/point (CSV)", M, after - before);
  });

  // #207: the retained-Scene footprint of PATH drawables — per-drawable tables
  // (colors/flags/widths/joins/caps/anchors), the per-path `circles` entry, and the
  // vertex data itself. This is the full-detail GeoMap/Plot layer case.
  it("d3gl Scene: drawable() — 1M path drawables (rects)", () => {
    const before = heap();
    const scene = new Scene();
    scene.group("rects", (g) => {
      for (let i = 0; i < N; i++) {
        const x = (i % 1000) * 2, y = ((i / 1000) | 0) * 2;
        g.drawable(i, (ctx) => ctx.rect(x, y, 1, 1));
      }
    });
    const after = heap();
    if (scene.drawableCount("rects") !== N) throw new Error("unreachable");
    report("Scene drawable() — 1M rects (retained)", N, after - before);
  });

  it("d3gl Scene: drawable() 1M rects + buffers() assembled (GPU-ready)", () => {
    const before = heap();
    const scene = new Scene();
    scene.group("rects", (g) => {
      for (let i = 0; i < N; i++) {
        const x = (i % 1000) * 2, y = ((i / 1000) | 0) * 2;
        g.drawable(i, (ctx) => ctx.rect(x, y, 1, 1));
      }
    });
    const buf = scene.buffers("rects");
    const after = heap();
    if (buf.drawableCount !== N) throw new Error("unreachable");
    report("Scene 1M rects + buffers() (both forms)", N, after - before);
  });
});
