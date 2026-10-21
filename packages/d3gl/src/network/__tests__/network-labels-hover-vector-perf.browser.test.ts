import { describe, it, expect, afterAll, vi } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { perfHost } from "../../__tests__/engine-sweep.js";
import { SvgBackend } from "../../svg/svg-backend.js";
import { CanvasBackend } from "../../canvas/canvas-backend.js";

/**
 * Per-pointer-path guard for #496 (AGENTS.md lifecycle §5) on the VECTOR backends: a hover sweep over glyphs
 * with `labels({ maxWidth })` must show the hovered label in full through a **one-label slot**
 * (`Backend.setHoverText`), never by re-pushing the placed set (`setTextLayer`, which on SVG re-serialises
 * every placed label into the DOM). WebGL's slot (one overlay node) is guarded in `network-labels-perf`.
 *
 * Signatures, per hover change, on a view with hundreds of placed labels (so an O(placed) path cannot hide):
 *   - `setTextLayer` calls: 0 (the placed set is untouched);
 *   - `setHoverText` calls: exactly 1;
 *   - SVG: DOM mutation records ≤ 4, none in the placed-text group; Canvas: 0 `clearRect` (no scene repaint),
 *     ≤ 1 `fillText` (the hovered label only), ≤ 2 `drawImage` (the rectangle kept and put back);
 *   - a wall-clock ceiling per move.
 */
const N = perfN(5_000, { max: 10_000 });
const W = 640, H = 400;
const COLS = Math.max(1, Math.round(Math.sqrt(N)));
const LONG = (id: number) => `{Allentown/Bethlehem,PA:Station${id}}_Albany,NY:AlbanyInternational`;
const BLOCK = 24;

describe.each(["svg", "canvas"] as const)("hover sweep, maxWidth labels — %s (n=%i)", (backend) => {
  const host = perfHost(W, H);
  afterAll(() => host.remove());

  it("shows the full label through the one-label slot: no placed-set push, O(1) writes per change", async () => {
    const net = network(host, { width: W, height: H, backend });
    await net.whenReady();
    const source: number[] = [], target: number[] = [];
    for (let i = 1; i < N; i++) { source.push(i - 1); target.push(i); }
    const positions = new Float32Array(2 * N);
    for (let i = 0; i < N; i++) { positions[2 * i] = ((i % COLS) / COLS) * W; positions[2 * i + 1] = (Math.floor(i / COLS) / COLS) * H; }
    net.data(buildGraph({ nodeCount: N, source, target, directed: false })).style({ nodeRadius: 2 }).layout({ backend: "positions", positions });
    net.interactive({ hover: true });
    net.labels({ labelOf: (id) => LONG(id), maxWidth: 60 });
    net.setTransform({ k: 4, x: -W, y: -H }); // zoomed in: room for hundreds of placed labels
    const proto = backend === "svg" ? SvgBackend.prototype : CanvasBackend.prototype;
    const textLayer = vi.spyOn(proto, "setTextLayer");
    const hoverText = vi.spyOn(proto, "setHoverText");
    const clear = vi.spyOn(CanvasRenderingContext2D.prototype, "clearRect");
    const fill = vi.spyOn(CanvasRenderingContext2D.prototype, "fillText");
    const draw = vi.spyOn(CanvasRenderingContext2D.prototype, "drawImage");
    const svg = host.querySelector("svg");
    const placedG = svg ? [...svg.children].find((c) => c.tagName === "g" && c.querySelector("text")) : undefined;
    const placed = backend === "svg" ? host.querySelectorAll("svg text").length : 0;
    let mutationsOutsideSlot = 0, mutations = 0;
    const mo = new MutationObserver((rs) => { for (const r of rs) { mutations++; if (placedG && placedG.contains(r.target)) mutationsOutsideSlot++; } });
    if (svg) mo.observe(svg, { subtree: true, childList: true, attributes: true, characterData: true });
    let changes = 0;
    net.on("hover", () => {});
    const rect = host.getBoundingClientRect();
    const slotCalls: number[] = [];
    let worst = 0;
    let last = -1;
    for (let i = 0; i < BLOCK * BLOCK; i++) {
      const row = Math.floor(i / BLOCK), col = i % BLOCK;
      // Pointer positions of the grid's nodes at k = 4, whole px; only count moves that changed the target.
      const id = (row + Math.floor(COLS / 4)) * COLS + col + Math.floor(COLS / 4);
      const x = Math.round(((id % COLS) / COLS) * W * 4 - W), y = Math.round((Math.floor(id / COLS) / COLS) * H * 4 - H);
      if (x < 0 || y < 0 || x > W || y > H) continue;
      const before = hoverText.mock.calls.length;
      const t0 = performance.now();
      host.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + x, clientY: rect.top + y, bubbles: true }));
      worst = Math.max(worst, performance.now() - t0);
      const d = hoverText.mock.calls.length - before;
      if (d > 0) { changes++; slotCalls.push(d); }
      last = id;
    }
    mo.disconnect();
    expect(last).toBeGreaterThanOrEqual(0);
    expect(changes, "hover changed on many moves (non-vacuous)").toBeGreaterThan(50);
    expect(Math.max(...slotCalls)).toBe(1); // one slot write per change
    expect(textLayer.mock.calls.length, "the placed set was re-pushed").toBe(0);
    if (backend === "svg") {
      expect(placed, "placed labels in the DOM").toBeGreaterThan(100);
      expect(mutationsOutsideSlot).toBe(0);
      expect(mutations / changes, "DOM mutation records per hover change").toBeLessThanOrEqual(4);
    } else {
      expect(clear.mock.calls.length, "the scene was repainted").toBe(0);
      // The label once, plus once more when the hover highlight's slot (#519) repaints under it: the highlight
      // slot lifts the label above it, puts back the old highlight's pixels, paints the new one and the label again.
      expect(fill.mock.calls.length / changes).toBeLessThanOrEqual(2);
      // A copy out and back per slot paint: the label's own change, the highlight (#519), and the label again above it.
      expect(draw.mock.calls.length / changes).toBeLessThanOrEqual(6);
    }
    expect(worst).toBeLessThan(perfBudget(25));
    vi.restoreAllMocks();
    net.destroy();
  }, 120_000);
});
