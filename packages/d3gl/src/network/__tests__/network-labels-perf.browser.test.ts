import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { perfHost, sweepFrames, zoomSteps } from "../../__tests__/engine-sweep.js";

/**
 * ENGINE-level per-frame guard for #204 (AGENTS.md §5): `network.labels()` now measures every
 * candidate's text so its collision box is real. Text measurement is the expensive part of label
 * placement (a `CanvasRenderingContext2D.measureText` per string), and the network derives label
 * text PER FRAME from the current frontier / viewport — so the one thing that must never regress is
 * that a text is measured **once**, not once per frame. `map/data-labels.browser.test.ts` pins the
 * same contract for plot/geo, where anchors are registered up front; this pins it for the network,
 * where they are not.
 *
 * Both reduction states run on ONE engine (a second WebGL engine after a large first one stalls
 * `whenReady()` for 9-12s locally — #287), because they build label candidates through completely
 * different code paths and a green result on one proves nothing about the other:
 *   - **LOD OFF** — `gatherCandidates` over the whole graph: every in-view node is a candidate, so
 *     the per-frame set is as large as the graph. This is where an O(N) measure would hide.
 *   - **LOD ON** — the frontier cut: candidates are leaves *and* aggregates, and the set CHANGES as
 *     the cut moves, so a naive implementation re-measures whatever the new cut exposes each frame.
 *     Run twice: at the default expand threshold (a real aggregate frontier) and fully expanded (an
 *     all-leaves frontier, held to the SAME budget as the LOD-off leg — LOD is not allowed to shrink
 *     the visible set the guard measures).
 *
 * Signatures pinned (deterministic first; wall-clock is the order-of-magnitude backstop):
 *   1. **Zero `measureText` calls across a repeated zoom sweep** — after a warm-up sweep, an
 *      identical second sweep must measure nothing (the memoizing `TextMeasurer`), while the
 *      registration frame must measure a non-zero number of texts (non-vacuity).
 *   2. **The DOM label set stays bounded and non-overlapping** — the #204 bug itself: every
 *      candidate used to reach the DOM because its collision box was zero-area. The viewport can
 *      hold only so many label boxes, and no two of them may overlap.
 *   3. **A per-frame wall-clock ceiling** in both reduction states.
 */

// Local default keeps the fixture build ~1s; the browser tier raises it via PERF_BROWSER_N. `max` is
// 50k, below the other network guards' 100k, because this file runs THREE sweep legs (LOD off,
// aggregate frontier, all-leaves frontier) on one engine plus a registration frame that measures one
// text per node: 42s wall clock at 50k vs 73s at 100k locally, against the tier's 300s per-file
// budget on software GL. The assertions are exact at whatever N comes back.
const N = perfN(20_000, { max: 50_000 });
const W = 640;
const H = 400;
const COLS = Math.max(1, Math.round(Math.sqrt(N)));
// Measured worst frame (best-of-3 per step, local headless Chromium) at N = 20k: 8.3ms with LOD
// off and 8.1ms with LOD on and the frontier fully expanded — i.e. the same work either way, which
// is the property the two legs exist to prove. That is a whole `setTransform` (lane emit + render +
// label refresh), not the placement pass alone. Constant + N-linear terms, per AGENTS §Perf-guard,
// so the tier's larger N gets room only for the part that really is linear (the candidate scan).
const FRAME_OFF_MS = perfBudget(12 + 20 * (N / 20_000));
const FRAME_ON_MS = perfBudget(12 + 20 * (N / 20_000));
/** Label boxes are ≥ ~20×14px, so a 640×400 viewport cannot fit more than ~900 without overlap.
 *  Before #204 every in-view candidate reached the DOM — i.e. N of them. */
const MAX_LABELS = 1200;

/** Spatially compact 8×8 blocks of the grid below, so a module's on-screen extent (~36×22px at
 *  k = 1) sits just under the default `expandPx` — collapsed when zoomed out, expanded when zoomed
 *  in. That is what makes the aggregate leg's frontier genuinely aggregate-shaped. */
const BLOCK = 8;
const MODULES = Array.from({ length: N }, (_, id) => {
  const col = id % COLS;
  const row = Math.floor(id / COLS);
  const block = Math.floor(row / BLOCK) * Math.ceil(COLS / BLOCK) + Math.floor(col / BLOCK);
  return { id, path: [1 + block, 1 + id] };
});

const labelEls = (h: HTMLElement): HTMLElement[] => [...h.querySelectorAll<HTMLElement>("[data-label-id]")];

/** No two rendered label boxes may overlap (1px slack for sub-pixel rounding). */
function overlappingPairs(els: readonly HTMLElement[]): number {
  const rects = els.map((e) => e.getBoundingClientRect());
  let hits = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (!a || !b) continue;
      if (a.right - 1 > b.left && b.right - 1 > a.left && a.bottom - 1 > b.top && b.bottom - 1 > a.top) hits++;
    }
  }
  return hits;
}

describe(`network.labels() per-frame cost (n=${N})`, () => {
  let host: HTMLElement;
  let net: ReturnType<typeof network>;
  let steps: ReturnType<typeof zoomSteps>;
  let atRegistration = 0;
  let spy: ReturnType<typeof vi.spyOn<CanvasRenderingContext2D, "measureText">>;

  beforeAll(async () => {
    host = perfHost(W, H);
    net = network(host, { width: W, height: H });
    await net.whenReady();
    // A grid layout with a path backbone: every node is in view at k = 1, so the registration frame
    // measures every label exactly once and the sweep can only ever REVEAL fewer.
    const source: number[] = [];
    const target: number[] = [];
    for (let i = 1; i < N; i++) { source.push(i - 1); target.push(i); }
    const positions = new Float32Array(2 * N);
    for (let i = 0; i < N; i++) {
      positions[2 * i] = ((i % COLS) / COLS) * W;
      positions[2 * i + 1] = (Math.floor(i / COLS) / COLS) * H;
    }
    net.data(buildGraph({ nodeCount: N, source, target, directed: false }))
      .style({ nodeRadius: 2 })
      .layout({ backend: "positions", positions });

    spy = vi.spyOn(CanvasRenderingContext2D.prototype, "measureText");
    // Uncapped — collision culling is the only thinning. Aggregates get a distinguishable text so
    // each LOD leg can assert its frontier really is the shape it claims.
    net.labels({ labelOf: (id, info) => (info.aggregate ? `agg${id}` : `n${id}`) });
    net.setTransform({ k: 1, x: 0, y: 0 });
    atRegistration = spy.mock.calls.length;
    steps = zoomSteps(W, H, [1, 1.5, 2, 3, 5, 8]); // zoom IN: no unseen label text can appear
  }, 120_000);

  // Release the WebGL context + the overlay when the file is done. A live engine holding a large
  // graph makes the NEXT file's `whenReady()` stall for 9-12s in the same browser session (#287).
  afterAll(() => {
    net.destroy();
    host.remove();
  });

  /** Run the sweep once so every text the cut can expose is cached, then reset to the wide view. */
  const warm = (): void => {
    net.setTransform({ k: 1, x: 0, y: 0 });
    for (const t of steps) net.setTransform(t);
    for (const t of steps) net.setTransform(t);
  };

  it("measures each label text ONCE — a repeated zoom sweep measures nothing (LOD off)", () => {
    // Exactly one measurement per distinct label text — every node is in view at k = 1, all N texts
    // are distinct, and the row height comes from the font string rather than a measurement.
    expect(atRegistration).toBe(N);

    for (const t of steps) net.setTransform(t); // warm-up: everything the sweep can reveal is cached
    spy.mockClear();
    const { worstFrameMs, frames } = sweepFrames(steps, (t) => { net.setTransform(t); });
    expect(spy.mock.calls.length).toBe(0); // ZERO measurements over `frames` real frames
    expect(frames).toBeGreaterThan(0);

    const els = labelEls(host);
    expect(els.length).toBeGreaterThan(0);
    expect(els.length).toBeLessThan(MAX_LABELS); // the #204 bug put ALL in-view candidates here
    expect(overlappingPairs(els)).toBe(0);
    expect(worstFrameMs).toBeLessThan(FRAME_OFF_MS);
  }, 120_000);

  it("stays measure-once and non-overlapping with LOD on, where the candidate set changes per frame", () => {
    // Modules of ~64 nodes at the default expand threshold: the frontier really does expand and
    // collapse across the sweep, so the *set of texts* a frame asks for keeps changing — the shape
    // that would defeat a per-registration measurement.
    net.lod({ modules: MODULES, expandPx: 40 });
    warm();
    spy.mockClear();
    const { worstFrameMs } = sweepFrames(steps, (t) => { net.setTransform(t); });
    expect(spy.mock.calls.length).toBe(0); // aggregate + leaf texts alike stay cached

    net.setTransform({ k: 1, x: 0, y: 0 }); // the collapsed end of the sweep, where the cut aggregates
    const els = labelEls(host);
    expect(els.length).toBeGreaterThan(0);
    expect(els.some((e) => e.textContent?.startsWith("agg"))).toBe(true); // non-vacuous: really aggregated
    expect(els.length).toBeLessThan(MAX_LABELS);
    expect(overlappingPairs(els)).toBe(0);
    expect(worstFrameMs).toBeLessThan(FRAME_ON_MS);
  }, 120_000);

  it("LOD on with an ALL-LEAVES frontier costs no more than the non-reduced draw", () => {
    // AGENTS core values: LOD is a helper, not a guarantee — a fully expanded frontier is as large
    // as the graph, and must be as cheap as the LOD-off leg above (same budget, deliberately).
    net.lod({ modules: MODULES, expandPx: 1 }); // every module expands ⇒ frontier = leaves in view
    warm();
    spy.mockClear();
    const { worstFrameMs } = sweepFrames(steps, (t) => { net.setTransform(t); });
    expect(spy.mock.calls.length).toBe(0);

    net.setTransform({ k: 1, x: 0, y: 0 }); // widest view: with expandPx 1 the cut is STILL all leaves
    const els = labelEls(host);
    expect(els.length).toBeGreaterThan(0);
    expect(els.every((e) => !e.textContent?.startsWith("agg"))).toBe(true); // non-vacuous: no aggregate left
    expect(els.length).toBeLessThan(MAX_LABELS);
    expect(overlappingPairs(els)).toBe(0);
    expect(worstFrameMs).toBeLessThan(FRAME_ON_MS);
    spy.mockRestore();
  }, 120_000);
});
