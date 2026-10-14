import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { network, type Network } from "../network.js";
import { buildGraph } from "../graph.js";
import { perfBudget } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost } from "../../__tests__/engine-sweep.js";

/**
 * The highlight lane's idle room bound (#478). With nothing highlighted the lane keeps its layers registered and
 * empty, so a hover change creates no GL buffer (`network-module-boundary-perf` pins that at 0 with LOD on and off);
 * but a layer that grew for a large selection would keep that room after the selection is cleared. The lane drops
 * an idle layer whose room is past 65,536 circles (`HIGHLIGHT_IDLE_ROOM_MAX`, network.ts), freeing its GL buffers.
 *
 * Driven through the real triggers on one engine, LOD off and then LOD on with every leaf kept: `select()` of
 * exactly 65,536 nodes, cleared (the layer stays: nothing freed); `select()` of all N nodes, cleared (the layer is
 * dropped: its buffers deleted); then two pointer sweeps across the glyphs. The first re-creates the small ring
 * layer once, the second creates and deletes nothing.
 *
 * N is set by the bound, not by `PERF_BROWSER_N`: a selection must draw more than 65,536 rings, and the full
 * selection's ring count is N (every node in view, LOD off; every leaf kept, LOD on). The glyphs are 1 px discs
 * on a 3 px pitch, so none overlap at the fixed view and the LOD cut keeps every leaf.
 */

const ROOM_MAX = 65_536;
const COLS = 400;
const ROWS = 200;
const N = COLS * ROWS; // 80,000 > ROOM_MAX
const PITCH = 8; // world units between grid nodes
const K = 3 / PITCH; // 3 px between glyph centres
const MARGIN = 8;
const W = COLS * 3 + 2 * MARGIN;
const H = ROWS * 3 + 2 * MARGIN;
const VIEW = { k: K, x: MARGIN + 1, y: MARGIN + 1 };
/** The smallest upload a ring instance makes: centre (8 B) + radius, colour, border, border colour (4 B each). */
const RING_BYTES = 24;
/** The pointer path: one glyph centre per move, spread over the grid. */
const SWEEP = Array.from({ length: 40 }, (_, i) => ((i * 7919) % ROWS) * COLS + ((i * 104729) % COLS));

/** A binary-tree graph on a grid, as `network-selection-sweep-1m-perf`'s fixture. */
function fixture(): { graph: ReturnType<typeof buildGraph>; positions: Float32Array } {
  const positions = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    positions[i * 2] = (i % COLS) * PITCH;
    positions[i * 2 + 1] = Math.floor(i / COLS) * PITCH;
  }
  const source = new Int32Array(N - 1);
  const target = new Int32Array(N - 1);
  for (let i = 1; i < N; i++) {
    source[i - 1] = i;
    target[i - 1] = Math.floor(i / 2);
  }
  return { graph: buildGraph({ nodeCount: N, source, target, directed: false }), positions };
}

interface Step { created: number; deleted: number; uploaded: number }
interface Sweep extends Step { moves: number; changes: number }
interface Leg { atMax: { select: Step; clear: Step }; past: { select: Step; clear: Step }; first: Sweep; second: Sweep }

describe(`network() highlight lane: an idle layer past ${ROOM_MAX.toLocaleString()} circles is released (#478), N=${N.toLocaleString()}`, () => {
  let net: Network;
  let host: HTMLElement;
  const spy = new GlBufferSpy();
  const legs: { off?: Leg; on?: Leg } = {};

  beforeAll(async () => {
    host = perfHost(W, H);
    net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const { graph, positions } = fixture();
    net.data(graph).style({ nodeRadius: 1, sizeMode: "screen" }).lod(false).layout({ backend: "positions", positions });
    let changes = 0;
    let last: number | string | null = null;
    net.on("hover", (h) => {
      const id = h?.id ?? null;
      if (id !== last) changes++;
      last = id;
    });
    net.interactive({ hover: true, selectable: true });
    net.setTransform(VIEW);

    const step = (run: () => void): Step => {
      const at = spy.mark();
      run();
      const d = spy.since(at);
      return { created: d.created, deleted: d.deleted, uploaded: d.uploadedBytes };
    };
    const sweep = (): Sweep => {
      const r = host.getBoundingClientRect();
      changes = 0;
      const s = step(() => {
        for (const i of SWEEP) {
          const x = VIEW.x + (i % COLS) * PITCH * K;
          const y = VIEW.y + Math.floor(i / COLS) * PITCH * K;
          host.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
        }
        host.dispatchEvent(new PointerEvent("pointerleave"));
      });
      return { ...s, moves: SWEEP.length, changes };
    };
    const ids = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
    const selectThenClear = (n: number): { select: Step; clear: Step } => {
      host.dispatchEvent(new PointerEvent("pointerleave")); // only the selection is highlighted
      const select = step(() => net.select("nodes", ids(n)));
      const clear = step(() => net.select("nodes", null));
      return { select, clear };
    };
    const runLeg = (): Leg => {
      const atMax = selectThenClear(ROOM_MAX);
      const past = selectThenClear(N);
      const first = sweep();
      const second = sweep();
      return { atMax, past, first, second };
    };

    sweep(); // the ring layer's first use (room 1), as after any hover
    legs.off = runLeg();
    net.lod({ expandPx: 1e-6, declutter: false });
    net.setTransform(VIEW);
    sweep();
    legs.on = runLeg();
  }, perfBudget(240_000));

  afterAll(() => {
    spy.restore();
    net?.destroy();
    host?.remove();
  });

  for (const state of ["off", "on"] as const) {
    it(`LOD ${state}: a layer with room for ${ROOM_MAX.toLocaleString()} circles stays registered; past it, it is released`, () => {
      const leg = legs[state];
      expect(leg, "the leg did not run").toBeDefined();
      if (!leg) return;
      const summary = `LOD ${state}: ${JSON.stringify(leg)}`;
      console.log(`  LOD ${state}: select ${ROOM_MAX} → clear +${leg.atMax.clear.created}/−${leg.atMax.clear.deleted} buffers; select ${N} (${(leg.past.select.uploaded / 1e6).toFixed(1)} MB up) → clear +${leg.past.clear.created}/−${leg.past.clear.deleted}; hover sweeps +${leg.first.created}/−${leg.first.deleted} (${leg.first.changes} changes), +${leg.second.created}/−${leg.second.deleted} (${leg.second.changes} changes)`);
      // Non-vacuity: each selection really drew its rings (at least one ring instance's bytes per selected node).
      expect(leg.atMax.select.uploaded, summary).toBeGreaterThanOrEqual(ROOM_MAX * RING_BYTES);
      expect(leg.past.select.uploaded, summary).toBeGreaterThanOrEqual(N * RING_BYTES);
      // At the bound: cleared, the layer stays registered and empty (no GL buffer created or deleted).
      expect(leg.atMax.clear.created, summary).toBe(0);
      expect(leg.atMax.clear.deleted, summary).toBe(0);
      // Past it: cleared, the layer is dropped and its buffers deleted (the five instance columns, the quad and the
      // highlight columns: 9 measured).
      expect(leg.past.clear.created, summary).toBe(0);
      expect(leg.past.clear.deleted, summary).toBeGreaterThanOrEqual(6);
    });

    it(`LOD ${state}: after the release, hover changes re-create the small layer once, then create no GL buffer`, () => {
      const leg = legs[state];
      if (!leg) throw new Error("the leg did not run");
      const summary = `LOD ${state}: first sweep ${JSON.stringify(leg.first)}, second ${JSON.stringify(leg.second)}, released ${leg.past.clear.deleted}`;
      expect(leg.first.changes, summary).toBeGreaterThan(SWEEP.length / 2); // non-vacuous: the pointer hovered glyphs
      expect(leg.second.changes, summary).toBeGreaterThan(SWEEP.length / 2);
      // The first hover re-creates the ring layer (as many buffers as the release freed), never one per change.
      expect(leg.first.created, summary).toBeLessThanOrEqual(leg.past.clear.deleted);
      expect(leg.first.deleted, summary).toBe(0);
      // Then a hover change updates it in place, and an idle frame keeps it (room 1, under the bound).
      expect(leg.second.created, summary).toBe(0);
      expect(leg.second.deleted, summary).toBe(0);
    });
  }
});
