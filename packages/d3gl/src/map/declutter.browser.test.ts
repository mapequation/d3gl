import { describe, it, expect } from "vitest";
import type { PathContext } from "../core/index.js";
import { plot } from "./plot.js";

/** Brute-force reference declutter: keep a glyph unless its projected anchor lands within
 *  `radius` px of an already-kept one; ties break by input order (earlier wins). This is the
 *  O(n²) ground truth the engine's flat-grid pass must match for on-screen anchors. */
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

describe("screen-space declutter (flat-grid cull)", () => {
  it("matches a brute-force reference for on-screen anchors across transforms", async () => {
    const W = 900, H = 450, N = 1200, RADIUS = 28;
    const host = document.createElement("div");
    host.style.width = `${W}px`; host.style.height = `${H}px`;
    document.body.appendChild(host);
    const chart = plot(host, { width: W, height: H, backend: "webgl" });
    await chart.whenReady();

    // Anchors kept well inside the viewport so the viewport-margin shortcut never fires under
    // the (identity-ish) transforms tested — every anchor stays on-screen, so the engine must
    // agree with the reference exactly.
    const rnd = mulberry32(N);
    const nodes = Array.from({ length: N }, (_, i) => ({
      id: i, x: 60 + rnd() * (W - 120), y: 60 + rnd() * (H - 120),
    }));
    const anchors = nodes.map((d) => [d.x, d.y] as [number, number]);

    chart.layer("nodes", nodes, {
      draw: (ctx: PathContext, d) => { ctx.arc(d.x, d.y, 5, 0, 2 * Math.PI); ctx.closePath(); },
      fill: () => "#3b82f6",
      anchor: (d) => [d.x, d.y],
      sizeMode: "screen",
      declutter: RADIUS,
      id: (d) => d.id,
    });
    chart.render();

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const eng = chart as any;
    // Translation-only transforms keep every anchor on-screen (scale > 1 would push some out).
    const transforms = [
      { k: 1, x: 0, y: 0 },
      { k: 1, x: 25, y: -15 },
      { k: 1, x: -40, y: 30 },
    ];
    for (const t of transforms) {
      chart.setTransform(t);
      const flags = eng.scene.buffers("nodes").flags as Uint8Array; // drawableId == input order
      const ref = referenceVisible(anchors, RADIUS, t);
      const engineVisible = Array.from(flags, (f) => (f & 1) === 1);
      const mismatches = engineVisible.reduce((n, v, i) => n + (v === ref[i] ? 0 : 1), 0);
      expect(mismatches).toBe(0);
      // sanity: the reference actually culls some glyphs at this density (the test would be
      // vacuous if everything were visible)
      expect(ref.filter((v) => !v).length).toBeGreaterThan(0);
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    chart.destroy();
    host.remove();
  });

  it("applies declutter on the FIRST draw, before any interaction", async () => {
    const W = 900, H = 450, N = 1000, RADIUS = 30;
    const host = document.createElement("div");
    host.style.width = `${W}px`; host.style.height = `${H}px`;
    document.body.appendChild(host);
    const chart = plot(host, { width: W, height: H, backend: "webgl" });
    await chart.whenReady();

    const rnd = mulberry32(N);
    const nodes = Array.from({ length: N }, (_, i) => ({ id: i, x: 60 + rnd() * (W - 120), y: 60 + rnd() * (H - 120) }));
    const anchors = nodes.map((d) => [d.x, d.y] as [number, number]);

    chart.layer("nodes", nodes, {
      draw: (ctx: PathContext, d) => { ctx.arc(d.x, d.y, 5, 0, 2 * Math.PI); ctx.closePath(); },
      fill: () => "#3b82f6", anchor: (d) => [d.x, d.y], sizeMode: "screen", declutter: RADIUS, id: (d) => d.id,
    });
    chart.render();

    // No setTransform/zoom yet — flags must already match the identity-transform reference.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const flags = (chart as any).scene.buffers("nodes").flags as Uint8Array;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const ref = referenceVisible(anchors, RADIUS, { k: 1, x: 0, y: 0 });
    const engineVisible = Array.from(flags, (f) => (f & 1) === 1);
    expect(engineVisible.reduce((n, v, i) => n + (v === ref[i] ? 0 : 1), 0)).toBe(0);
    expect(ref.filter((v) => !v).length).toBeGreaterThan(0); // non-vacuous: some are culled

    chart.destroy();
    host.remove();
  });
});
