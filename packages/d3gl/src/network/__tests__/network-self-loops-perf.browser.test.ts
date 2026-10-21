import { describe, it, expect, afterAll } from "vitest";
import { network, type Network } from "../network.js";
import { buildGraph } from "../graph.js";
import { keptLoopStats, selfLoopStats } from "../self-loops.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost, zoomSteps } from "../../__tests__/engine-sweep.js";

/**
 * Self-link loops (#505) at ≈1M nodes (docs/agents/performance.md), LOD off and on, on WebGL, through the real
 * triggers: a `setTransform` zoom sweep and position frames (`layout({ backend: "positions" })`).
 *
 * Asserted (counts, never scaled):
 * - a graph WITHOUT self-links pays nothing for them: no loop update, no loop instance written, no LOD loop
 *   listing, on any frame, with LOD off or on;
 * - LOD off, with S self-links: a zoom frame does no loop work and creates or destroys no GPU buffer (the
 *   loops' columns stay resident), a position frame rewrites exactly the S loops, in place;
 * - LOD on, with S self-links: each frame lists its kept leaves' loops in at most min(S, frontier) reads and
 *   writes at most that many loop instances: O(visible), never O(S) when the frontier is smaller.
 * The full-detail zoom frame also keeps the static ceiling of `network-selection-sweep-1m-perf`.
 */

const N = perfN(1_000_000, { max: 1_000_000 });
/** One node in LOOP_EVERY has a self-link. */
const LOOP_EVERY = 10;
const S = Math.ceil(N / LOOP_EVERY);
const COLS = Math.max(1, Math.round(Math.sqrt(N)));
const W = 640;
const H = 400;
const FRAME_MS_STATIC = perfBudget(4 + (4 * N) / 50_000);
const POSITION_FRAMES = 3;

/** A binary tree on a square grid (as the selection sweep's), with a self-link on every LOOP_EVERY-th node. */
function fixture(n: number, loops: boolean): { graph: ReturnType<typeof buildGraph>; positions: Float32Array } {
  const positions = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    positions[i * 2] = (i % COLS) * 8;
    positions[i * 2 + 1] = Math.floor(i / COLS) * 8;
  }
  const m = n - 1 + (loops ? Math.ceil(n / LOOP_EVERY) : 0);
  const source = new Int32Array(m);
  const target = new Int32Array(m);
  let e = 0;
  for (let i = 1; i < n; i++) {
    source[e] = i;
    target[e++] = Math.floor(i / 2);
  }
  if (loops)
    for (let i = 0; i < n; i += LOOP_EVERY) {
      source[e] = i;
      target[e++] = i;
    }
  return { graph: buildGraph({ nodeCount: n, source, target, directed: false }), positions };
}

interface Leg {
  zoomFrames: number;
  worstZoomMs: number;
  zoomLoopUpdates: number;
  zoomLoopInstances: number;
  zoomCreated: number;
  zoomDeleted: number;
  /** Per zoom frame (LOD on): loop entries read, loop instances written, and the frontier the cut thinned. */
  perFrame: { reads: number; instances: number; glyphs: number }[];
  listedFrames: number;
  positionUpdates: number;
  positionInstances: number;
  registered: number;
}

async function runLeg(loops: boolean, lod: boolean): Promise<Leg> {
  const host = perfHost(W, H);
  const net: Network = network(host, { width: W, height: H, backend: "webgl" });
  const spy = new GlBufferSpy();
  try {
    await net.whenReady();
    const { graph, positions } = fixture(N, loops);
    const atStart = spy.mark();
    net
      .data(graph)
      .style({ nodeRadius: 3, sizeMode: "screen", linkStroke: "rgb(100,116,139)" })
      .lod(lod ? {} : false)
      .layout({ backend: "positions", positions });
    net.setTransform({ k: 1, x: 0, y: 0 }); // settle the registration's first frame outside the sweep
    const registered = spy.since(atStart).uploadedBytes;
    const u0 = selfLoopStats.updates;
    const i0 = selfLoopStats.instances;
    const f0 = keptLoopStats.frames;
    const before = spy.mark();
    const perFrame: Leg["perFrame"] = [];
    let worstZoomMs = 0;
    const steps = zoomSteps(W, H);
    for (const t of [...steps, ...steps.slice().reverse()]) {
      const r = keptLoopStats.reads;
      const inst = selfLoopStats.instances;
      const t0 = performance.now();
      net.setTransform(t);
      worstZoomMs = Math.max(worstZoomMs, performance.now() - t0);
      perFrame.push({ reads: keptLoopStats.reads - r, instances: selfLoopStats.instances - inst, glyphs: net.declutterStats?.glyphs ?? N });
    }
    const used = spy.since(before);
    const zoomLoopUpdates = selfLoopStats.updates - u0;
    const zoomLoopInstances = selfLoopStats.instances - i0;
    const listedFrames = keptLoopStats.frames - f0;
    // Position frames: the layout moves every node a little, at the fit view.
    net.setTransform({ k: 1, x: 0, y: 0 });
    const pu = selfLoopStats.updates;
    const pi = selfLoopStats.instances;
    const moved = new Float32Array(positions.length);
    // LOD legs skip them: the guard asserts LOD's zoom frames, and each LOD position frame rebuilds a 1M-leaf tree.
    for (let f = 1; f <= (lod ? 0 : POSITION_FRAMES); f++) {
      for (let i = 0; i < positions.length; i++) moved[i] = (positions[i] ?? 0) + f;
      net.layout({ backend: "positions", positions: moved.slice() });
      net.render();
    }
    return {
      zoomFrames: perFrame.length,
      worstZoomMs,
      zoomLoopUpdates,
      zoomLoopInstances,
      zoomCreated: used.created,
      zoomDeleted: used.deleted,
      perFrame,
      listedFrames,
      positionUpdates: selfLoopStats.updates - pu,
      positionInstances: selfLoopStats.instances - pi,
      registered,
    };
  } finally {
    spy.restore();
    net.destroy();
    host.remove();
  }
}

const TIMEOUT = perfBudget(180_000 + N / 2);

describe(`self-link loops per frame (#505) at N=${N.toLocaleString()}, S=${S.toLocaleString()}`, () => {
  afterAll(() => document.body.replaceChildren());

  it(
    "LOD off, no self-links: no loop work on a zoom or a position frame",
    async () => {
      const leg = await runLeg(false, false);
      expect(leg.registered, "registration uploaded nothing — the spy is not observing the live context").toBeGreaterThan(0);
      expect(leg.zoomLoopUpdates + leg.zoomLoopInstances + leg.listedFrames).toBe(0);
      expect(leg.positionUpdates + leg.positionInstances).toBe(0);
      console.log(`  LOD off, no self-links: worst zoom frame ${leg.worstZoomMs.toFixed(2)} ms`);
    },
    TIMEOUT,
  );

  it(
    "LOD off, S self-links: a zoom frame does no loop work and churns no buffer; a position frame rewrites the S loops",
    async () => {
      const leg = await runLeg(true, false);
      expect(leg.zoomLoopUpdates, "a zoom frame updated the loops").toBe(0);
      expect(leg.zoomLoopInstances, "a zoom frame wrote loop instances").toBe(0);
      expect(leg.zoomCreated, "GPU buffers created during the sweep").toBe(0);
      expect(leg.zoomDeleted, "GPU buffers destroyed during the sweep").toBe(0);
      expect(leg.positionUpdates, "the position frames never reached the loops (non-vacuity)").toBeGreaterThan(0);
      expect(leg.positionUpdates, "more than one loop update per position frame").toBeLessThanOrEqual(POSITION_FRAMES);
      expect(leg.positionInstances, "a loop update wrote other than the S loops").toBe(leg.positionUpdates * S);
      expect(leg.worstZoomMs, `worst zoom frame ${leg.worstZoomMs.toFixed(2)} ms`).toBeLessThan(FRAME_MS_STATIC);
      console.log(`  LOD off, S=${S}: worst zoom frame ${leg.worstZoomMs.toFixed(2)} ms, ${leg.positionUpdates} loop updates over ${POSITION_FRAMES} position frames`);
    },
    TIMEOUT,
  );

  it(
    "LOD on, no self-links: no LOD frame lists or writes a loop",
    async () => {
      const leg = await runLeg(false, true);
      expect(leg.listedFrames, "an LOD frame listed loops of a graph without self-links").toBe(0);
      expect(leg.zoomLoopInstances + leg.positionInstances).toBe(0);
      console.log(`  LOD on, no self-links: worst zoom frame ${leg.worstZoomMs.toFixed(2)} ms`);
    },
    TIMEOUT,
  );

  it(
    "LOD on, S self-links: each frame reads at most min(S, frontier) entries and writes at most that many loops",
    async () => {
      const leg = await runLeg(true, true);
      expect(leg.listedFrames, "no LOD frame listed the kept leaves' loops (non-vacuity)").toBeGreaterThan(0);
      expect(leg.perFrame.some((f) => f.instances > 0), "no frame drew a loop: the sweep never reached the leaves").toBe(true);
      for (const [k, f] of leg.perFrame.entries()) {
        const bound = Math.min(S, f.glyphs);
        expect(f.reads, `frame ${k}: ${f.reads} reads, frontier ${f.glyphs}, S ${S}`).toBeLessThanOrEqual(bound);
        expect(f.instances, `frame ${k}: ${f.instances} loops written`).toBeLessThanOrEqual(f.reads);
      }
      const worst = Math.max(...leg.perFrame.map((f) => f.reads));
      console.log(`  LOD on, S=${S}: worst zoom frame ${leg.worstZoomMs.toFixed(2)} ms, at most ${worst} loop entries read per frame, frontiers ${leg.perFrame.map((f) => f.glyphs).join("/")}`);
    },
    TIMEOUT,
  );
});
