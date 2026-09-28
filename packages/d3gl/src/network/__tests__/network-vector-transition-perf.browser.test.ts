import { describe, it, expect, beforeAll, vi } from "vitest";
import { Network, type NetworkOptions } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ViewTransform } from "../../core/index.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { perfHost } from "../../__tests__/engine-sweep.js";

// Count the retained Scene's glyph emits: every rebuild of the network Scene emits its nodes once, through
// `emitNodes` (LOD off) or `traceFrontierGlyphs` (the LOD frontier) — network-vector-zoom-perf's probe.
const emits = vi.hoisted(() => ({ n: 0 }));
vi.mock("../glyphs.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../glyphs.js")>();
  return {
    ...mod,
    emitNodes: (...args: Parameters<typeof mod.emitNodes>) => {
      emits.n++;
      return mod.emitNodes(...args);
    },
    traceFrontierGlyphs: (...args: Parameters<typeof mod.traceFrontierGlyphs>) => {
      emits.n++;
      return mod.traceFrontierGlyphs(...args);
    },
  };
});

/**
 * ENGINE-level per-frame guard for a **fitted position transition** on a **Canvas / SVG** network with zoom
 * enabled (#427, AGENTS.md lifecycle §5).
 *
 * With `layout({ transition, fit: true })` the camera eases along with the nodes, moving the view on every
 * frame without `setTransform`: `frameView` sets the transform state and re-seeds d3-zoom (its handler
 * suppressed), and the frame's own rebuild re-cuts the retained Scene at the new view — O(drawn nodes +
 * edges): every node and edge with LOD off, the frontier and its super-edges with LOD on, exactly as an
 * unfitted transition frame. So a fitted frame must cost one Scene rebuild plus the O(1) camera. A re-seed
 * routed through the programmatic-transform hook (`afterProgrammaticTransform` → `syncScreenGeometry`,
 * network-vector-zoom-perf) would add a second rebuild per frame, and nothing else would notice.
 *
 * The trigger is the real one, `layout({ transition, fit })` on the public engine, stepped on a virtual clock,
 * against the same transition without `fit`, in both reduction states on one engine per backend:
 *   - **moving camera**: a 1 s transition to a layout twice the extent, every timed frame mid-ease, so the
 *     fitted camera zooms out ~2× across them. Signatures (deterministic): exactly one Scene rebuild's glyph
 *     emit per frame, fitted or not; the camera re-seeded once per fitted frame and never unfitted; no
 *     `syncScreenGeometry` re-cut; no gesture boundary. Budget: an absolute ceiling, split into constant and
 *     linear terms. No fitted-vs-unfitted ratio here: a retained frame's work follows the view it shows
 *     (LOD off culls the nodes that moved off screen, LOD on cuts its frontier at the view), and the two
 *     cameras show different views.
 *   - **still camera**: the same transition an hour long, so the fitted camera's eased progress stays under
 *     1e-10 and both phases draw the same view — where the ratio isolates the camera's own glue: the fitted
 *     median within 1.3× + 2 ms of the unfitted one's, with the same signatures.
 *
 * Each stepped frame is laid out after it, outside the timed window (a layout read), as the browser's
 * rendering between two animation frames does. Without it SVG's DOM is never laid out between the stepped
 * frames, and the fitted frame's d3-zoom re-seed — whose default extent reads the host's `clientWidth` —
 * forces the layout of the whole previous frame's DOM inside the timed window: measured +14% (LOD off) and
 * +21% (LOD on) at an equal view, and 1.02× / 1.06× with the layout flushed between frames. That layout is
 * work the browser does at paint for fitted and unfitted frames alike.
 *
 * Scale: Canvas at `perfN(20k, max 40k)`, SVG at `perfN(10k, max 20k)`. A retained transition frame rebuilds
 * one Scene entry per drawn node and edge (SVG one DOM node each) — about twice a `setTransform` re-cut on
 * Canvas (see MEASURED) — and this guard steps ~50 of them per reduction state; the caps keep the file
 * inside the tier's per-file budget on CI's slower runners. ≈1M is the WebGL lane's regime
 * (`network-transition-perf`). The signature guarded here, a second rebuild per frame, is an exact count at
 * any N, and the camera's own work does not grow with N at all.
 */

// MEASURED (local headless Chromium, load average ~30-40; fitted / unfitted median of 6 frames, best of 2
// rounds for the still camera):
//                 still camera          moving camera
//   canvas 20k:   off 370 / 373 ms      off 371 / 422 ms,  on 14.5 / 30.2 ms   (on, still: 13.6 / 13.6 ms)
//   svg    10k:   off 258 / 252 ms      off 276 / 285 ms,  on 25.7 / 114 ms    (on, still: 25.3 / 23.9 ms)
//   canvas 40k:   off 830 / 824 ms      off 859 / 880 ms,  on 23.8 / 38.6 ms   (on, still: 21.8 / 21.6 ms)
//   svg    20k:   off 537 / 537 ms      off 552 / 548 ms,  on 24.7 / 52.7 ms   (on, still: 23.1 / 22.8 ms)
// For comparison, a zoom-enabled setTransform's re-cut, worst step (network-vector-zoom-perf): canvas 20k
// 202 / 14 ms (LOD off / on), svg 10k 313 / 42 ms. With LOD on the moving fitted camera zooms out onto a
// coarser frontier, so its frame draws less than the unfitted one at its still view.
const W = 640;
const H = 400;
const FRAMES = 6;
const ROUNDS = 2;
const MOVING_MS = 1000;
const STILL_MS = 3_600_000;
const SETUP_MS = perfBudget(120_000);
/** Frame timing's clock: the transitions run on a virtual `performance.now`. */
const wallClock = performance.now.bind(performance);

/** Counts the re-cut, gesture and camera re-seed hooks and exposes the view, without reaching into privates. */
class VectorProbe extends Network {
  syncs = 0;
  boundaries = 0;
  reseeds = 0;
  constructor(host: HTMLElement, opts: NetworkOptions) {
    super(host, opts);
  }
  override syncScreenGeometry(): this {
    this.syncs++;
    return super.syncScreenGeometry();
  }
  protected override setInteracting(v: boolean): void {
    this.boundaries++;
    super.setInteracting(v);
  }
  protected override syncZoomToView(): void {
    this.reseeds++;
    super.syncZoomToView();
  }
  get camera(): ViewTransform {
    return { ...this.transform };
  }
}

/**
 * Frames stepped by hand on a virtual clock: `requestAnimationFrame` queues, {@link Stepper.step} advances
 * the clock by `ms` and runs the queued frames, so each transition frame lands at a known progress.
 */
interface Stepper {
  step(ms: number): void;
  restore(): void;
}
function stepper(): Stepper {
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  const queue = new Map<number, FrameRequestCallback>();
  let id = 0;
  globalThis.requestAnimationFrame = (cb) => (queue.set(++id, cb), id);
  globalThis.cancelAnimationFrame = (i) => void queue.delete(i);
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  return {
    step(ms) {
      clock += ms;
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(clock);
    },
    restore() {
      now.mockRestore();
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCaf;
    },
  };
}

/** A binary-tree graph on a square grid (network-sweep-perf's fixture): a real hierarchy for LOD. */
function fixture(n: number): { graph: NetworkGraph; positions: Float32Array } {
  const cols = Math.max(1, Math.round(Math.sqrt(n)));
  const positions = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    positions[i * 2] = (i % cols) * 8;
    positions[i * 2 + 1] = Math.floor(i / cols) * 8;
  }
  const source = new Int32Array(n - 1);
  const target = new Int32Array(n - 1);
  for (let i = 1; i < n; i++) {
    source[i - 1] = i;
    target[i - 1] = Math.floor(i / 2);
  }
  return { graph: buildGraph({ nodeCount: n, source, target, directed: false }), positions };
}

/** A transition's timed frames, fit on or off: the median frame (best round), and the hooks, emits and the
 *  camera's scale after each frame (the last round's). */
interface Phase {
  medianFrameMs: number;
  syncs: number;
  boundaries: number;
  reseeds: number;
  emits: number;
  ks: number[];
}

interface Pair {
  unfitted: Phase;
  fitted: Phase;
}

interface Leg {
  moving: Pair;
  still: Pair;
  /** Glyph emits of one forced rebuild (the per-frame unit). */
  emitsPerRebuild: number;
}

const BACKENDS = [
  { backend: "canvas", n: perfN(20_000, { max: 40_000 }) },
  { backend: "svg", n: perfN(10_000, { max: 20_000 }) },
] as const;

const results = new Map<string, { off: Leg; on: Leg }>();

beforeAll(async () => {
  for (const { backend, n } of BACKENDS) {
    const host = perfHost(W, H);
    const net = new VectorProbe(host, { width: W, height: H, backend });
    await net.whenReady();
    const { graph, positions } = fixture(n);
    net.data(graph).style({ nodeRadius: 3, sizeMode: "screen" }).enableZoom([1e-3, 1e3]);
    const wide = positions.map((v, i) => 2 * v + (i % 2 ? -40 : 60));

    /** `FRAMES` frames of a `duration` ms transition to `wide`, fit on or off, from the same framed view. */
    const transition = (fit: boolean, duration: number): Phase => {
      net.layout({ backend: "positions", positions, fit: true });
      const frames = stepper();
      try {
        net.layout({ backend: "positions", positions: wide, transition: duration, fit });
        const dt = MOVING_MS / (FRAMES + 2); // mid-ease throughout the moving transition
        frames.step(dt); // warm-up
        void host.getBoundingClientRect(); // lay the frame out, as the browser does between frames (see below)
        const [s0, b0, r0, e0] = [net.syncs, net.boundaries, net.reseeds, emits.n];
        const ts: number[] = [];
        const ks: number[] = [];
        for (let i = 0; i < FRAMES; i++) {
          const t0 = wallClock();
          frames.step(dt);
          ts.push(wallClock() - t0);
          ks.push(net.camera.k);
          void host.getBoundingClientRect();
        }
        ts.sort((a, b) => a - b);
        return {
          medianFrameMs: ts[FRAMES >> 1] ?? Infinity,
          syncs: net.syncs - s0,
          boundaries: net.boundaries - b0,
          reseeds: net.reseeds - r0,
          emits: emits.n - e0,
          ks,
        };
      } finally {
        net.stopLayout();
        frames.restore();
      }
    };
    /** Best of alternating rounds: the medians' minimum, so a burst of contention lands on one round. */
    const pair = (duration: number, rounds: number): Pair => {
      const unfitted: Phase[] = [];
      const fitted: Phase[] = [];
      for (let round = 0; round < rounds; round++) {
        unfitted.push(transition(false, duration));
        fitted.push(transition(true, duration));
      }
      const best = (ps: Phase[]): Phase => {
        const last = ps[ps.length - 1] ?? { medianFrameMs: Infinity, syncs: -1, boundaries: -1, reseeds: -1, emits: -1, ks: [] };
        return { ...last, medianFrameMs: Math.min(...ps.map((p) => p.medianFrameMs)) };
      };
      return { unfitted: best(unfitted), fitted: best(fitted) };
    };
    const leg = (): Leg => {
      net.layout({ backend: "positions", positions, fit: true });
      const e0 = emits.n;
      net.syncScreenGeometry();
      const emitsPerRebuild = emits.n - e0;
      return { moving: pair(MOVING_MS, 1), still: pair(STILL_MS, ROUNDS), emitsPerRebuild };
    };

    const off = leg();
    net.lod({ declutter: true, maxAggregateRadius: 24 });
    const on = leg();
    results.set(backend, { off, on });
    net.destroy();
  }
}, SETUP_MS);

describe("network() Canvas/SVG fitted transition frame, zoom enabled (#427)", () => {
  for (const { backend, n } of BACKENDS) {
    // ~4-14× the measured fitted medians, split into constant + linear terms (see MEASURED).
    const ceiling = {
      off: perfBudget(backend === "canvas" ? 100 + (1800 * n) / 20_000 : 100 + (1400 * n) / 10_000),
      on: perfBudget(backend === "canvas" ? 200 + (25 * n) / 20_000 : 300 + (50 * n) / 10_000),
    };
    for (const lod of ["off", "on"] as const) {
      const get = (): Leg => {
        const r = results.get(backend)?.[lod];
        if (!r) throw new Error("the transitions did not run");
        return r;
      };

      it(`${backend}, LOD ${lod} (N=${n.toLocaleString()}): one Scene rebuild per fitted frame, as unfitted; the camera re-seeded once, no re-cut hook or gesture`, () => {
        const r = get();
        expect(r.emitsPerRebuild, "non-vacuity: a rebuild emitted no glyphs").toBeGreaterThan(0);
        // Non-vacuity: the moving fitted camera zooms out on every timed frame, ~2× across them; unfitted, it holds.
        const ks = r.moving.fitted.ks;
        expect(ks).toHaveLength(FRAMES);
        for (let i = 1; i < ks.length; i++) expect(ks[i], `k at frame ${i}: ${ks.join(", ")}`).toBeLessThan(ks[i - 1] ?? NaN);
        expect((ks[ks.length - 1] ?? NaN) / (ks[0] ?? NaN)).toBeLessThan(0.7);
        expect(new Set(r.moving.unfitted.ks).size, "an unfitted transition moved the camera").toBe(1);
        for (const [name, { unfitted, fitted }] of [["moving", r.moving], ["still", r.still]] as const) {
          expect(unfitted.emits, `${name}: Scene rebuilds per unfitted transition frame`).toBe(FRAMES * r.emitsPerRebuild);
          expect(fitted.emits, `${name}: Scene rebuilds per fitted transition frame`).toBe(FRAMES * r.emitsPerRebuild);
          expect(fitted.reseeds, `${name}: the camera is not re-seeded once per fitted frame`).toBe(FRAMES);
          expect(unfitted.reseeds, `${name}: an unfitted transition re-seeded the camera`).toBe(0);
          expect(fitted.syncs, `${name}: a fitted frame ran the programmatic re-cut`).toBe(0);
          expect(unfitted.syncs).toBe(0);
          expect(fitted.boundaries, `${name}: the fitted camera's re-seed ran a gesture boundary`).toBe(0);
        }
      });

      it(`${backend}, LOD ${lod} (N=${n.toLocaleString()}): a fitted frame stays within the unfitted frame's budget`, () => {
        const { moving, still } = get();
        const msg = (p: Pair): string =>
          `${backend} LOD ${lod}: fitted ${p.fitted.medianFrameMs.toFixed(1)} ms vs unfitted ${p.unfitted.medianFrameMs.toFixed(1)} ms at N=${n.toLocaleString()}`;
        // Same view: the camera's glue is all the fitted frame adds.
        expect(still.fitted.medianFrameMs, msg(still)).toBeLessThanOrEqual(still.unfitted.medianFrameMs * 1.3 + 2);
        expect(still.fitted.medianFrameMs, msg(still)).toBeLessThan(ceiling[lod]);
        expect(moving.fitted.medianFrameMs, msg(moving)).toBeLessThan(ceiling[lod]);
      });
    }
  }
});
