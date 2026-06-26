import { describe, it, expect } from "vitest";
import { Plot, plot } from "./plot.js";

/** Brute-force reference declutter: keep a glyph unless its projected anchor lands within
 *  `radius` px of an already-kept one; ties break by input order (earlier wins). */
function referenceVisible(
  anchors: [number, number][],
  radius: number,
  t: { k: number; x: number; y: number },
): boolean[] {
  const r2 = radius * radius;
  const kept: [number, number][] = [];
  return anchors.map(([ax, ay]) => {
    const sx = t.k * ax + t.x, sy = t.k * ay + t.y;
    for (const [kx, ky] of kept) {
      const dx = kx - sx, dy = ky - sy;
      if (dx * dx + dy * dy < r2) return false;
    }
    kept.push([sx, sy]);
    return true;
  });
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Access private internals for verification (same pattern as auto-backend.browser.test.ts).
const upgradeOf = (chart: unknown): Promise<void> | null =>
  (chart as { upgradeDone: Promise<void> | null }).upgradeDone;
const liveBackend = (chart: unknown): string =>
  (chart as { currentBackend: string }).currentBackend;
// Access baseProto for spy (same approach as auto-backend.browser.test.ts).
const baseProto = Object.getPrototypeOf(Plot.prototype) as Record<string, unknown>;

describe("plot.points() lane lifecycle across backend swaps", () => {
  it("canvas→WebGL (backend:\"auto\"): points() with declutter upgrades to instanced lane after upgrade", async () => {
    const W = 600, H = 400, N = 300, RADIUS = 24;
    const host = document.createElement("div");
    host.style.width = `${W}px`; host.style.height = `${H}px`;
    document.body.appendChild(host);

    // backend:"auto" starts on canvas (no setInstancedLayer) then upgrades to WebGL.
    const chart = plot(host, { width: W, height: H, backend: "auto" });

    // Register the points layer BEFORE the upgrade resolves — while still on canvas.
    const rnd = mulberry32(42);
    const nodes = Array.from({ length: N }, (_, i) => ({
      id: i, x: 60 + rnd() * (W - 120), y: 60 + rnd() * (H - 120),
    }));
    const anchors = nodes.map((d) => [d.x, d.y] as [number, number]);

    // At call time the backend is canvas — syncPointsLayer takes the Scene path.
    chart.points("pts", nodes, {
      x: (d) => d.x, y: (d) => d.y, radius: 5, fill: () => "#3b82f6",
      sizeMode: "screen", declutter: RADIUS, id: (d) => d.id,
    });

    // Verify we are still on canvas: lane must NOT exist yet.
    expect(liveBackend(chart)).toBe("canvas");
    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect((chart as any).instancedLanes.has("points:pts")).toBe(false);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // Await the background WebGL upgrade.
    await upgradeOf(chart);
    expect(liveBackend(chart)).toBe("webgl");

    // (a) After upgrade, the lane MUST be registered on WebGL.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect((chart as any).instancedLanes.has("points:pts")).toBe(true);

    // (b) The lane's declutter must still be correct — match the brute-force reference.
    const lane = (chart as any).instancedLanes.get("points:pts").lane;
    const kept = new Set(Array.from(lane.visible as Uint32Array));
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const t = { k: 1, x: 0, y: 0 };
    const ref = referenceVisible(anchors, RADIUS, t);
    const engineVisible = nodes.map((_, i) => kept.has(i));
    const mismatches = engineVisible.reduce((n: number, v: boolean, i: number) => n + (v === ref[i] ? 0 : 1), 0);
    expect(mismatches).toBe(0);
    // Non-vacuous: the density is high enough that some points are culled.
    expect(ref.filter((v) => !v).length).toBeGreaterThan(0);

    chart.destroy();
    host.remove();
  });

  it("explicit canvas→WebGL swap: points() lane upgrades on setBackend(\"webgl\")", async () => {
    const W = 600, H = 400, N = 250, RADIUS = 20;
    const host = document.createElement("div");
    host.style.width = `${W}px`; host.style.height = `${H}px`;
    document.body.appendChild(host);

    const chart = plot(host, { width: W, height: H, backend: "canvas" });
    await chart.whenReady();

    const rnd = mulberry32(77);
    const nodes = Array.from({ length: N }, (_, i) => ({
      id: i, x: 50 + rnd() * (W - 100), y: 50 + rnd() * (H - 100),
    }));
    const anchors = nodes.map((d) => [d.x, d.y] as [number, number]);

    chart.points("dots", nodes, {
      x: (d) => d.x, y: (d) => d.y, radius: 4, fill: () => "#ef4444",
      sizeMode: "screen", declutter: RADIUS, id: (d) => d.id,
    });

    // On canvas: lane must NOT exist.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect((chart as any).instancedLanes.has("points:dots")).toBe(false);
    // Scene spec must have been registered.
    expect((chart as any).specs.find((s: any) => s.name === "dots")).toBeTruthy();
    /* eslint-enable @typescript-eslint/no-explicit-any */

    chart.setBackend("webgl");
    await chart.whenReady();

    // After explicit swap to WebGL: lane must now be registered.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect((chart as any).instancedLanes.has("points:dots")).toBe(true);

    // Declutter correctness after swap.
    const lane = (chart as any).instancedLanes.get("points:dots").lane;
    const kept = new Set(Array.from(lane.visible as Uint32Array));
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const ref = referenceVisible(anchors, RADIUS, { k: 1, x: 0, y: 0 });
    const mismatches = nodes.reduce((n, _, i) => n + (kept.has(i) === ref[i] ? 0 : 1), 0);
    expect(mismatches).toBe(0);
    expect(ref.filter((v) => !v).length).toBeGreaterThan(0);

    chart.destroy();
    host.remove();
  });

  it("WebGL→canvas downgrade: points() lane reverts to Scene path", async () => {
    const W = 600, H = 400, N = 200, RADIUS = 22;
    const host = document.createElement("div");
    host.style.width = `${W}px`; host.style.height = `${H}px`;
    document.body.appendChild(host);

    const chart = plot(host, { width: W, height: H, backend: "webgl" });
    await chart.whenReady();

    const rnd = mulberry32(99);
    const nodes = Array.from({ length: N }, (_, i) => ({
      id: i, x: 50 + rnd() * (W - 100), y: 50 + rnd() * (H - 100),
    }));

    chart.points("circles", nodes, {
      x: (d) => d.x, y: (d) => d.y, radius: 5, fill: () => "#10b981",
      sizeMode: "screen", declutter: RADIUS, id: (d) => d.id,
    });

    // WebGL: lane must be registered.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect((chart as any).instancedLanes.has("points:circles")).toBe(true);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // Downgrade to canvas.
    chart.setBackend("canvas");
    await chart.whenReady();

    // After downgrade: lane must be gone; Scene spec must be registered.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect((chart as any).instancedLanes.has("points:circles")).toBe(false);
    expect((chart as any).specs.find((s: any) => s.name === "circles")).toBeTruthy();
    // Scene layer must have the correct number of drawables (N points, not 0 from empty build).
    const flags = (chart as any).scene.buffers("circles").flags as Uint8Array;
    expect(flags.length).toBe(N);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    chart.destroy();
    host.remove();
  });

  it("declutter:0 takes the Scene path (not the lane) on WebGL", async () => {
    const W = 400, H = 300, N = 50;
    const host = document.createElement("div");
    host.style.width = `${W}px`; host.style.height = `${H}px`;
    document.body.appendChild(host);

    const chart = plot(host, { width: W, height: H, backend: "webgl" });
    await chart.whenReady();

    const rnd = mulberry32(7);
    const nodes = Array.from({ length: N }, (_, i) => ({
      id: i, x: rnd() * W, y: rnd() * H,
    }));

    chart.points("zeropt", nodes, {
      x: (d) => d.x, y: (d) => d.y, radius: 3, fill: () => "#000",
      sizeMode: "screen", declutter: 0, id: (d) => d.id, // declutter:0 → not eligible for lane
    });

    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect((chart as any).instancedLanes.has("points:zeropt")).toBe(false);
    const spec = (chart as any).specs.find((s: any) => s.name === "zeropt");
    expect(spec).toBeTruthy();
    expect(spec.declutter).toBe(0);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    chart.destroy();
    host.remove();
  });

  it("append() on a lane layer throws a clear error", async () => {
    const W = 400, H = 300, N = 50;
    const host = document.createElement("div");
    host.style.width = `${W}px`; host.style.height = `${H}px`;
    document.body.appendChild(host);

    const chart = plot(host, { width: W, height: H, backend: "webgl" });
    await chart.whenReady();

    const rnd = mulberry32(13);
    const nodes = Array.from({ length: N }, (_, i) => ({
      id: i, x: rnd() * W, y: rnd() * H,
    }));

    const handle = chart.points("lane-pts", nodes, {
      x: (d) => d.x, y: (d) => d.y, radius: 3, fill: () => "#000",
      sizeMode: "screen", declutter: 20, id: (d) => d.id,
    });

    // Lane is active on WebGL.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect((chart as any).instancedLanes.has("points:lane-pts")).toBe(true);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // append() must throw a clear error (not silently no-op).
    const extra = [{ id: N, x: 10, y: 10 }];
    expect(() => handle.append(extra)).toThrow(/append\(\) is not supported on a declutter points layer/);

    chart.destroy();
    host.remove();
  });

  it("append() on a declutter layer created on CANVAS throws — before AND after the WebGL upgrade", async () => {
    const W = 400, H = 300, N = 50;
    const host = document.createElement("div");
    host.style.width = `${W}px`; host.style.height = `${H}px`;
    document.body.appendChild(host);

    // backend:"auto" starts on canvas — the layer is registered as a Scene spec, not a lane.
    const chart = plot(host, { width: W, height: H, backend: "auto" });

    const rnd = mulberry32(8);
    const nodes = Array.from({ length: N }, (_, i) => ({ id: i, x: rnd() * W, y: rnd() * H }));

    // Declutter layer created while on canvas: it's lane-ELIGIBLE (declutter > 0) even though it
    // renders via the Scene right now. Its handle must throw on append regardless of backend, or
    // it would silently append to a Scene spec that the upgrade replaces with a no-op build.
    const handle = chart.points("auto-decl", nodes, {
      x: (d) => d.x, y: (d) => d.y, radius: 3, fill: () => "#000",
      sizeMode: "screen", declutter: 20, id: (d) => d.id,
    });

    // Pre-upgrade (canvas): no lane yet, but append must STILL throw.
    expect(liveBackend(chart)).toBe("canvas");
    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect((chart as any).instancedLanes.has("points:auto-decl")).toBe(false);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const extra = [{ id: N, x: 10, y: 10 }];
    expect(() => handle.append(extra)).toThrow(/append\(\) is not supported on a declutter points layer/);

    // After the WebGL upgrade: layer becomes a lane; append must continue to throw.
    await upgradeOf(chart);
    expect(liveBackend(chart)).toBe("webgl");
    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect((chart as any).instancedLanes.has("points:auto-decl")).toBe(true);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    expect(() => handle.append(extra)).toThrow(/append\(\) is not supported on a declutter points layer/);

    chart.destroy();
    host.remove();
  });

  it("append() on a NON-declutter points layer still works (Scene path append)", async () => {
    const W = 400, H = 300, N = 30;
    const host = document.createElement("div");
    host.style.width = `${W}px`; host.style.height = `${H}px`;
    document.body.appendChild(host);

    const chart = plot(host, { width: W, height: H, backend: "webgl" });
    await chart.whenReady();

    const rnd = mulberry32(21);
    const nodes = Array.from({ length: N }, (_, i) => ({ id: i, x: rnd() * W, y: rnd() * H }));

    // No declutter → always Scene; append must continue to work.
    const handle = chart.points("plain", nodes, {
      x: (d) => d.x, y: (d) => d.y, radius: 3, fill: () => "#333", id: (d) => d.id,
    });

    const extra = [{ id: N, x: 5, y: 5 }, { id: N + 1, x: 9, y: 9 }];
    expect(() => handle.append(extra)).not.toThrow();

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const spec = (chart as any).specs.find((s: any) => s.name === "plain");
    expect(spec.data.length).toBe(N + 2); // data extended by the appended items
    expect((chart as any).scene.buffers("plain").flags.length).toBe(N + 2);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    chart.destroy();
    host.remove();
  });

  it("non-declutter points() or hover points() are unaffected by backend swap", async () => {
    const W = 400, H = 300, N = 80;
    const host = document.createElement("div");
    host.style.width = `${W}px`; host.style.height = `${H}px`;
    document.body.appendChild(host);

    const chart = plot(host, { width: W, height: H, backend: "canvas" });
    await chart.whenReady();

    const rnd = mulberry32(55);
    const nodes = Array.from({ length: N }, (_, i) => ({
      id: i, x: rnd() * W, y: rnd() * H,
    }));

    // No declutter: always Scene.
    chart.points("nodecl", nodes, {
      x: (d) => d.x, y: (d) => d.y, radius: 3, fill: () => "#888",
      id: (d) => d.id,
    });
    // Hover: always Scene (disqualified from lane even on WebGL).
    chart.points("hovpt", nodes, {
      x: (d) => d.x, y: (d) => d.y, radius: 3, fill: () => "#f00",
      sizeMode: "screen", declutter: 10, id: (d) => d.id, hover: true,
    });

    chart.setBackend("webgl");
    await chart.whenReady();

    /* eslint-disable @typescript-eslint/no-explicit-any */
    // Neither should have a lane registered.
    expect((chart as any).instancedLanes.has("points:nodecl")).toBe(false);
    expect((chart as any).instancedLanes.has("points:hovpt")).toBe(false);
    // Both must be Scene specs with drawable data.
    expect((chart as any).scene.buffers("nodecl").flags.length).toBe(N);
    expect((chart as any).scene.buffers("hovpt").flags.length).toBe(N);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    chart.destroy();
    host.remove();
  });

  it("backend:\"auto\" upgrade fails (WebGL unavailable): points() stays on Scene (canvas)", async () => {
    const W = 400, H = 300, N = 100, RADIUS = 18;
    const host = document.createElement("div");
    host.style.width = `${W}px`; host.style.height = `${H}px`;
    document.body.appendChild(host);

    const { vi } = await import("vitest");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi.spyOn(baseProto, "createWebGLBackend").mockRejectedValue(new Error("no webgl2"));

    const chart = plot(host, { width: W, height: H, backend: "auto" });

    const rnd = mulberry32(31);
    const nodes = Array.from({ length: N }, (_, i) => ({
      id: i, x: 50 + rnd() * (W - 100), y: 50 + rnd() * (H - 100),
    }));

    chart.points("fallback", nodes, {
      x: (d) => d.x, y: (d) => d.y, radius: 4, fill: () => "#a00",
      sizeMode: "screen", declutter: RADIUS, id: (d) => d.id,
    });

    await upgradeOf(chart);
    // Upgrade failed — must stay on canvas, no lane.
    expect(liveBackend(chart)).toBe("canvas");
    /* eslint-disable @typescript-eslint/no-explicit-any */
    expect((chart as any).instancedLanes.has("points:fallback")).toBe(false);
    // Scene spec must still be live.
    expect((chart as any).specs.find((s: any) => s.name === "fallback")).toBeTruthy();
    /* eslint-enable @typescript-eslint/no-explicit-any */

    spy.mockRestore();
    warn.mockRestore();
    chart.destroy();
    host.remove();
  });
});
