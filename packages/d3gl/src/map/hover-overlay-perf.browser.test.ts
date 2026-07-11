import { describe, it, expect } from "vitest";
import type { PathContext } from "../core/index.js";
import { plot, type Plot } from "./plot.js";
import { groupRendererConstructions } from "../webgl/renderer.js";

/**
 * Per-interaction cost guard for the auto-hover overlay (#218).
 *
 * The regression this pins: `pushHighlight` calls `Backend.updateLayer` on EVERY hover-target
 * change, and WebGL `updateLayer` used to destroy the overlay's GroupRenderer and construct a
 * new one — GrowBuffers, GrowTextures, Models/pipelines, ~10 GPU objects — per crossed glyph.
 * A hover sweep is a continuous pointer interaction (per-frame per AGENTS §5), so that churn
 * scaled with every pointermove. The fix (`GroupRenderer.replace`) reuses ONE renderer per
 * overlay layer and rewrites its small buffers in place; a full rebuild remains only for
 * structural changes (a pass type appearing that the renderer was built without).
 *
 * Headless GPU timing is too lenient to catch object churn reliably, so the primary assertion
 * is the deterministic signature — ZERO GroupRenderer constructions across the sweep after the
 * overlay's first — plus a generous per-change wall-clock budget and pixel identity with the
 * full-rebuild path.
 */

const W = 480, H = 320;
const COLS = 40, ROWS = 25; // 1000 glyphs; cell 12 x 12.8 px, glyph 8x8 centred (gaps between)
const CELL_W = W / COLS, CELL_H = H / ROWS;

function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;
  document.body.appendChild(el);
  return el;
}

function pointer(el: HTMLElement, x: number, y: number): void {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
}

const center = (i: number): [number, number] =>
  [(i % COLS) * CELL_W + CELL_W / 2, Math.floor(i / COLS) * CELL_H + CELL_H / 2];
/** A point in the gap between glyphs (cell corner — > 4px from every glyph edge). */
const gap = (i: number): [number, number] =>
  [(i % COLS) * CELL_W + 1, Math.floor(i / COLS) * CELL_H + 1];

async function makeChart(): Promise<{ chart: Plot; el: HTMLElement }> {
  const el = host();
  const chart = plot(el, { width: W, height: H, backend: "webgl" });
  await chart.whenReady();
  const data = Array.from({ length: COLS * ROWS }, (_, i) => ({ i }));
  chart.layer("cells", data, {
    draw: (ctx: PathContext, d) => {
      const [cx, cy] = center(d.i);
      ctx.rect(cx - 4, cy - 4, 8, 8);
    },
    fill: (d) => (d.i % 2 ? "#3b82f6" : "#ef4444"),
    id: (d) => d.i,
    hover: { fill: "rgb(0,255,0)" },
  });
  chart.render();
  return { chart, el };
}

describe("hover overlay renderer reuse (#218)", () => {
  it("webgl: a 100-glyph hover sweep (with gap clears) constructs ZERO extra GroupRenderers and stays within budget", async () => {
    const { chart, el } = await makeChart();

    // Warm-up: the FIRST hover legitimately constructs the overlay's renderer (once per layer).
    pointer(el, ...center(0));
    const base = groupRendererConstructions;

    // Sweep 1: 100 distinct glyph centres (direct re-target, non-empty -> non-empty).
    const times: number[] = [];
    for (let i = 1; i <= 100; i++) {
      const [x, y] = center(i);
      const t0 = performance.now();
      pointer(el, x, y);
      times.push(performance.now() - t0);
    }
    // Sweep 2: 25 centre<->gap alternations (non-empty <-> EMPTY overlay — the hover-out/in
    // path must also reuse the renderer, keeping its passes alive at zero counts).
    for (let i = 101; i <= 125; i++) {
      const t0 = performance.now();
      pointer(el, ...gap(i));
      pointer(el, ...center(i));
      times.push((performance.now() - t0) / 2);
    }
    const built = groupRendererConstructions - base;

    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.log(
      `#218 hover sweep (${COLS * ROWS} glyphs, ${times.length + 25} hover changes): ` +
        `constructions=${built}, median=${median.toFixed(2)} ms, p95=${p95.toFixed(2)} ms per change`,
    );

    // Deterministic signature: renderer reuse — no per-hover-change GPU object churn.
    expect(built).toBe(0);
    // Generous headless ceiling that still catches an order-of-magnitude drop. Each change
    // includes the O(highlighted)=1 re-tessellation + a full recomposite (pre-existing).
    expect(median).toBeLessThan(12);

    chart.destroy();
    el.remove();
  }, 60_000);

  it("webgl: in-place overlay pixels are identical to a fresh-construction reference; a gap clear restores the base", async () => {
    const { chart, el } = await makeChart();
    const noHover = chart.toPNG();

    // Reach glyph 42 AFTER a sweep — its overlay was rewritten in place many times.
    for (const i of [0, 7, 199, 512, 999, 42]) pointer(el, ...center(i));
    const inPlace = chart.toPNG();
    expect(inPlace).not.toBe(noHover); // non-vacuous: the highlight is visible

    // Reference: a fresh chart whose FIRST hover is glyph 42 — that overlay renderer was
    // constructed from the same buffers (the full-rebuild path).
    const ref = await makeChart();
    pointer(ref.el, ...center(42));
    expect(ref.chart.toPNG()).toBe(inPlace);
    ref.chart.destroy();
    ref.el.remove();

    // Hover-out over a gap: the overlay is emptied IN PLACE (zero-count passes) — pixels
    // must return to the exact no-hover frame.
    pointer(el, ...gap(43));
    expect(chart.toPNG()).toBe(noHover);
    // …and hover-in again after the empty state still highlights (passes kept alive).
    pointer(el, ...center(43));
    expect(chart.toPNG()).not.toBe(noHover);

    chart.destroy();
    el.remove();
  }, 60_000);
});
