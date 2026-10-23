import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { perfHost } from "../../__tests__/engine-sweep.js";
import { SvgBackend } from "../../svg/svg-backend.js";
import { CanvasBackend } from "../../canvas/canvas-backend.js";

/**
 * Per-hover-change cost guard for the Canvas/SVG hover overlay slot (#519).
 *
 * The regression this pins: a hover change on Canvas/SVG used to go `highlight()` → `pushHighlight()` →
 * `render()`, so Canvas cleared and repainted every node and link, and SVG re-serialized every layer's markup —
 * O(drawn shapes) per crossed glyph, 30 ms (Canvas) / 484 ms (SVG) per change at 50k nodes. The slot repaints only
 * the overlay: Canvas puts back the pixels it kept under the old highlight and paints the new one, SVG rewrites one
 * group. LOD off: every node and link is drawn, so an O(N) path cannot hide behind a small frontier.
 *
 * Deterministic signatures, per hover change, independent of machine load:
 * - Canvas: zero `clearRect` (no full repaint), and `fill` + `stroke` calls ≤ `PER_CHANGE.canvas`;
 * - SVG: the scene's groups are never touched, and the elements written ≤ `PER_CHANGE.svg`.
 * Both are the worst change of the sweep, not an average over it.
 * The wall-clock median is a generous ceiling on top (information under load; an O(N) path is 10-100× over it).
 *
 * The 40 hover targets sit on a strip of their own with a 16 px pitch (above the bulk), so every move re-targets
 * whatever N is: a dense bulk cannot make the sweep vacuous.
 */

const N = perfN(50_000, { max: 200_000 });
const W = 640, H = 400;
const TARGETS = 40, PITCH = 16, STRIP_Y = 20;
const ROUNDS = 3;

/**
 * Per-backend limits per hover change, measured: exactly what the one-node highlight needs, so one more shape
 * painted or element written per change fails. (Before #519 a change repainted the whole scene: O(nodes + links).)
 * - Canvas: 1 `fill` + `stroke` call, the hovered node's ring.
 * - SVG: 2 elements written, the overlay group's highlight markup.
 * WebGL has no overlay slot (it redraws from resident GPU buffers): its hover sweep is guarded in
 * `network-module-boundary-perf` (#476).
 */
const PER_CHANGE = {
  canvas: { fillStroke: 1 },
  svg: { written: 2 },
} as const;

function graph(): { positions: Float32Array; source: number[]; target: number[] } {
  const positions = new Float32Array(2 * N);
  for (let i = 0; i < TARGETS; i++) { positions[2 * i] = 8 + PITCH * i; positions[2 * i + 1] = STRIP_Y; }
  const bulk = N - TARGETS, cols = Math.max(1, Math.round(Math.sqrt(bulk * (W / (H - 60)))));
  for (let j = 0; j < bulk; j++) {
    positions[2 * (TARGETS + j)] = ((j % cols) / cols) * W;
    positions[2 * (TARGETS + j) + 1] = 60 + (Math.floor(j / cols) / Math.ceil(bulk / cols)) * (H - 60);
  }
  const source: number[] = [], target: number[] = [];
  for (let i = 1; i < N; i++) { source.push(i - 1); target.push(i); }
  return { positions, source, target };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

describe.each(["canvas", "svg"] as const)(`hover sweep, LOD off (no lod() set) — %s (n=${N})`, (backend) => {
  const host = perfHost(W, H);
  afterAll(() => host.remove());
  afterEach(() => { vi.restoreAllMocks(); }); // a failed leg must not leak its spies' counts into the next

  it("a hover change repaints only the highlight: O(highlight), not O(nodes + links)", async () => {
    const net = network(host, { width: W, height: H, backend });
    await net.whenReady();
    const { positions, source, target } = graph();
    net.data(buildGraph({ nodeCount: N, source, target, directed: false })).style({ nodeRadius: 3 }).layout({ backend: "positions", positions });
    let tips = 0; // a hover change shows the new node's tooltip once: counts changes independently of the slot
    net.interactive({ hover: true, tooltip: (_d, id) => { tips++; return String(id); } });
    net.setTransform({ k: 1, x: 0, y: 0 });

    const proto = backend === "svg" ? SvgBackend.prototype : CanvasBackend.prototype;
    const slot = vi.spyOn(proto, "renderOverlays");
    const full = vi.spyOn(proto, "render");
    const clear = vi.spyOn(CanvasRenderingContext2D.prototype, "clearRect");
    const fill = vi.spyOn(CanvasRenderingContext2D.prototype, "fill");
    const stroke = vi.spyOn(CanvasRenderingContext2D.prototype, "stroke");
    const svg = host.querySelector("svg");
    const sceneGroups = svg ? [svg.children[1], svg.children[2]] : [];
    let written = 0, sceneMutations = 0;
    const count = (rs: MutationRecord[]): void => {
      for (const r of rs) {
        if (sceneGroups.some((g) => g?.contains(r.target))) sceneMutations++;
        for (const n of r.addedNodes) if (n instanceof Element) written += 1 + n.querySelectorAll("*").length;
      }
    };
    const mo = new MutationObserver(count);
    if (svg) mo.observe(svg, { subtree: true, childList: true, attributes: true });

    const rect = host.getBoundingClientRect();
    const times: number[] = [], paints: number[] = [], writes: number[] = [];
    let changes = 0;
    for (let round = 0; round < ROUNDS; round++) {
      for (let i = 0; i < TARGETS; i++) {
        const before = tips, paint0 = fill.mock.calls.length + stroke.mock.calls.length;
        count(mo.takeRecords());
        const written0 = written;
        const t0 = performance.now();
        host.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + 8 + PITCH * i, clientY: rect.top + STRIP_Y, bubbles: true }));
        const dt = performance.now() - t0;
        if (tips > before) {
          changes++; times.push(dt);
          count(mo.takeRecords());
          paints.push(fill.mock.calls.length + stroke.mock.calls.length - paint0); writes.push(written - written0);
        }
      }
    }
    count(mo.takeRecords());
    mo.disconnect();
    const perChange = (n: number): number => n / Math.max(1, changes);
    console.log(`[hover-slot ${backend} n=${N}] changes=${changes} median=${median(times).toFixed(2)}ms worst=${Math.max(...times).toFixed(2)}ms ` +
      (backend === "svg" ? `written/change=${perChange(written).toFixed(1)}` : `fill+stroke/change=${perChange(fill.mock.calls.length + stroke.mock.calls.length).toFixed(1)}`));

    expect(changes, "every move re-targeted (non-vacuous)").toBe(ROUNDS * TARGETS);
    expect(slot.mock.calls.length, "one overlay-slot repaint per change").toBe(changes);
    expect(full.mock.calls.length, "full repaints during the sweep").toBe(0);
    if (backend === "canvas") {
      expect(clear.mock.calls.length, "the scene was repainted").toBe(0);
      expect(Math.max(...paints), "fill + stroke calls per hover change").toBeLessThanOrEqual(PER_CHANGE.canvas.fillStroke);
    } else {
      expect(sceneMutations, "the scene's markup was touched").toBe(0);
      expect(Math.max(...writes), "elements written per hover change").toBeLessThanOrEqual(PER_CHANGE.svg.written);
    }
    expect(median(times), "median ms per hover change").toBeLessThan(perfBudget(10));
    vi.restoreAllMocks();
    net.destroy();
  }, 120_000);
});
