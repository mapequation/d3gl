import { describe, it, expect, beforeAll } from "vitest";
import { network } from "../network.js";
import { buildGraph } from "../graph.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost, sweepFrames, zoomSteps } from "../../__tests__/engine-sweep.js";

/**
 * ENGINE-level at-scale zoom sweep for `network()` (#263, gap 2 of #258).
 *
 * Every at-scale network guard that existed before this one drives a **module**, not the engine:
 * `frontier-perf` calls `computeFrontier` directly, `super-edges-perf` the super-edge builder,
 * `label-candidates-perf` the label ranker. They are the right shape for what they assert, but the
 * thing a user actually triggers — `net.setTransform()` → `BaseEngine.setTransform` → dynamic-lane
 * re-emit → `frontierLayers` → `emitInstancedLane`'s in-place `updateInstancedLayer` — was never
 * driven end-to-end at scale. An O(N)-per-frame cost in the glue between those modules trips nothing.
 *
 * Both reduction states run, per AGENTS.md §5 — a green result on one does not prove the other:
 *   - **LOD OFF** (full detail, the lane is `dynamic: false`): the whole graph is drawn every frame
 *     from a static emit. This is where an O(N)-per-frame cost hides, precisely because nothing is
 *     *supposed* to happen per frame.
 *   - **LOD ON** (reductions on, `dynamic: true`): the lane re-cuts the frontier and re-emits on
 *     every `setTransform`. This is where per-frame work must stay O(visible frontier).
 *
 * Signatures pinned (deterministic first; wall-clock is the order-of-magnitude backstop):
 *   1. **`nodeFill` resolves O(nodes) at registration, ZERO per frame** — in both reduction states,
 *      in the N-invariant `toBe(before)` form. Per-node colour propagates up the LOD tree at build
 *      time, so even a frontier re-cut must not re-invoke it.
 *   2. **`linkStroke` is exactly zero per frame with LOD off, and screen-bounded with LOD on.**
 *      Super-edges are genuinely view-dependent — their accumulated flow changes with the cut — so
 *      per-frame calls are correct under LOD and asserting zero there would be wrong. What must hold
 *      is the scale: an N-independent ceiling, since declutter bounds the frontier in screen space.
 *   3. **GPU buffers are updated in place, not destroyed + recreated, and not re-uploaded** —
 *      `emitInstancedLane`'s `sameSet` fast path plus the bytes actually pushed across the bus, both
 *      counted on the live `WebGL2RenderingContext`, with non-vacuity checks that registration DID
 *      create buffers and DID upload. The upload counter is what gives the full-detail leg teeth:
 *      the accessor assertions there are satisfied for free by the static emit, but re-pushing the
 *      retained instance arrays every frame (the #186 shape) moves no create/delete count at all.
 *
 * ONE ENGINE, TWO PHASES — deliberate, not tidiness. Constructing a second WebGL engine after a
 * first one has uploaded a ~100k-node graph costs **9-12s in `whenReady()`** on local headless
 * Chromium (measured: 24ms for the first engine, 12,168ms for the second, 9,251ms for a third even
 * when it is tiny, 20ms for a fourth). That stall is not this guard's subject and it would eat the
 * tier's 300s per-file budget, so the LOD-off and LOD-on legs share one engine and toggle `lod()`
 * between them — which also exercises the toggle. Tracked as #287.
 */

// Local default keeps the always-on run ~1s of fixture build; the browser tier raises it via
// PERF_BROWSER_N (#262). `max`: this leg holds the graph, the LOD tree, and the per-frame frontier
// scratch simultaneously, and the LOD tree build is the O(N log N) one-time cost that would eat the
// tier's 300s per-file budget — the same 200k ceiling `gpu-frame-budget-perf` settled on.
const N = perfN(50_000, { max: 200_000 });
const EDGES = N - 1; // the binary-tree fixture below
const COLS = Math.max(1, Math.round(Math.sqrt(N)));
const W = 640;
const H = 400;
// Measured worst frame (best-of-3 per step, local headless Chromium): LOD off 0.10ms at 50k and at
// 100k — Chromium's 100µs `performance.now()` quantum, because a static-emit frame is a uniform
// write plus the instanced draws. LOD on 5.1ms at 50k and 5.6ms at 100k: a real frontier re-cut +
// declutter + in-place re-upload per frame, and near-flat in N, which is the O(visible) property in
// wall-clock form. Separate ceilings because they are different orders of work; each is ~4-6x the
// measured value (non-flaky) and well under an O(N)-per-frame regression (a full 50k-node style
// re-resolve is ~40-90ms/frame).
const FRAME_MS_STATIC = perfBudget(4 + (4 * N) / 50_000);
const FRAME_MS_LOD = perfBudget(20 + (10 * N) / 50_000);
// Per-frame super-edge colour resolutions allowed under LOD. Deliberately an ABSOLUTE number and
// NOT passed through `perfN`/`perfBudget`: it is a deterministic count, and the whole point is that
// it must not grow with N. Measured ~2.3k/frame at both 50k and 100k nodes in this 640x400
// viewport, so ~8x headroom; the regression it catches (colouring every edge per frame) lands at
// `EDGES`, which an assertion below proves sits above this ceiling for whatever N is running.
const LOD_LINK_COLOURS_PER_FRAME = 20_000;
// Per-frame GPU upload allowed under LOD, for the same reason and on the same terms: absolute, so
// it asserts that the frontier's instance upload does not grow with N. Measured ~103 KB/frame at
// 50k and ~105 KB/frame at 100k, so ~10x headroom; the 12MB retained buffer set is what an
// O(N)-per-frame re-upload would push, 12x over the line even at the local default.
const LOD_UPLOAD_BYTES_PER_FRAME = 1024 * 1024;
// Registration (graph + layout + LOD tree) is the O(N) phase; a timeout is a harness limit, not a
// budget (AGENTS.md §Tests).
const SETUP_MS = perfBudget(120_000 + N / 2);

/** A binary-tree graph on a square grid: deterministic positions, a real hierarchy for LOD to coarsen. */
function fixture(n: number): { graph: ReturnType<typeof buildGraph>; positions: Float32Array } {
  const positions = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    positions[i * 2] = (i % COLS) * 8;
    positions[i * 2 + 1] = Math.floor(i / COLS) * 8;
  }
  const source = new Int32Array(n - 1);
  const target = new Int32Array(n - 1);
  for (let i = 1; i < n; i++) {
    source[i - 1] = i;
    target[i - 1] = Math.floor(i / 2);
  }
  return { graph: buildGraph({ nodeCount: n, source, target, directed: false }), positions };
}

/** One reduction state's measurements: what the sweep re-derived, re-uploaded, and cost. */
interface Leg {
  /** Style-accessor calls counted just before the sweep (i.e. the registration total). */
  nodeFillBefore: number;
  linkStrokeBefore: number;
  /** …and just after it. */
  nodeFillAfter: number;
  linkStrokeAfter: number;
  buffersCreated: number;
  buffersDeleted: number;
  uploadedBytes: number;
  worstFrameMs: number;
  frames: number;
}

let registrationBuffersCreated = 0;
let registrationUploadedBytes = 0;
let registrationNodeFill = 0;
let registrationLinkStroke = 0;
let buildMs = 0;
let lodBuildMs = 0;
let lodOff: Leg;
let lodOn: Leg;

beforeAll(async () => {
  const spy = new GlBufferSpy();
  try {
    const { graph, positions } = fixture(N);
    let nodeFillCalls = 0;
    let linkStrokeCalls = 0;

    const net = network(perfHost(W, H), { width: W, height: H, backend: "webgl" });
    await net.whenReady();

    const atStart = spy.mark();
    const buildStart = performance.now();
    net
      .data(graph)
      .style({
        nodeRadius: 3,
        sizeMode: "screen",
        nodeFill: (i) => {
          nodeFillCalls++;
          return i % 2 ? "rgb(59,130,246)" : "rgb(245,158,11)";
        },
        linkStroke: (weight) => {
          linkStrokeCalls++;
          return weight > 1 ? "rgb(100,116,139)" : "rgb(203,213,225)";
        },
      })
      .layout({ backend: "positions", positions });
    buildMs = performance.now() - buildStart;
    const registration = spy.since(atStart);
    registrationBuffersCreated = registration.created;
    registrationUploadedBytes = registration.uploadedBytes;
    registrationNodeFill = nodeFillCalls;
    registrationLinkStroke = linkStrokeCalls;

    /** Snapshot the counters, run the sweep, and report the deltas. */
    const runLeg = (): Leg => {
      const nodeFillBefore = nodeFillCalls;
      const linkStrokeBefore = linkStrokeCalls;
      const before = spy.mark();
      const { worstFrameMs, frames } = sweepFrames(zoomSteps(W, H), (t) => net.setTransform(t));
      const buffers = spy.since(before);
      return {
        nodeFillBefore,
        linkStrokeBefore,
        nodeFillAfter: nodeFillCalls,
        linkStrokeAfter: linkStrokeCalls,
        buffersCreated: buffers.created,
        buffersDeleted: buffers.deleted,
        uploadedBytes: buffers.uploadedBytes,
        worstFrameMs,
        frames,
      };
    };

    lodOff = runLeg();

    // Enabling LOD is a REGISTRATION event (it builds the tree and its aggregate geometry), so the
    // accessor counters are re-snapshotted by `runLeg` afterwards — only the per-frame delta is asserted.
    const lodStart = performance.now();
    net.lod({ declutter: true, maxAggregateRadius: 24 });
    lodBuildMs = performance.now() - lodStart;
    lodOn = runLeg();

    net.destroy();
  } finally {
    spy.restore();
  }
}, SETUP_MS);

describe(`network() engine zoom sweep — per-frame cost at N=${N.toLocaleString()} nodes / ${EDGES.toLocaleString()} edges (#263)`, () => {
  it("registers the style ONCE per node and really owns GPU buffers (non-vacuity)", () => {
    // Without this the zeros below could mean "the fixture never built" instead of "nothing re-ran".
    expect(registrationNodeFill, "nodeFill never ran — the fixture did not register").toBe(N);
    expect(registrationLinkStroke, "linkStroke never ran — the link pass did not build").toBeGreaterThan(0);
    expect(
      registrationBuffersCreated,
      "registration created no GPU buffer — the spy is not observing the live context",
    ).toBeGreaterThan(0);
    expect(
      registrationUploadedBytes,
      "registration uploaded no geometry — the spy is not observing the live context",
    ).toBeGreaterThan(0);
    // The per-frame ceiling only means something while it sits below a full pass over the edges.
    expect(
      LOD_LINK_COLOURS_PER_FRAME,
      "the fixture is too small for the per-frame link-colour ceiling to bite — raise N or lower the ceiling",
    ).toBeLessThan(EDGES);
  });

  it("LOD OFF (full detail): the static emit re-derives nothing and re-uploads nothing per frame", () => {
    expect(lodOff.nodeFillAfter, "nodeFill re-ran during the full-detail zoom sweep").toBe(lodOff.nodeFillBefore);
    // `dynamic: false` ⇒ the emit is static ⇒ link-colour work per frame is exactly zero.
    expect(lodOff.linkStrokeAfter, "linkStroke re-ran during the zoom sweep on a static emit").toBe(lodOff.linkStrokeBefore);
    expect(lodOff.buffersCreated, "GPU buffers were created during the full-detail zoom sweep").toBe(0);
    expect(lodOff.buffersDeleted, "GPU buffers were destroyed during the full-detail zoom sweep").toBe(0);
    // …and nothing is re-uploaded into them. Measured: exactly 0 bytes over the sweep against 12MB
    // at registration. This is the assertion with teeth on the full-detail leg — the accessor counts
    // above are satisfied for free by the static emit, whereas a re-upload of the retained node/link
    // instance arrays (the #186 shape) lands at ~1x the registration figure, 1000x over this line.
    // The ratio form (rather than `toBe(0)`) keeps a future per-frame UNIFORM write from tripping it.
    expect(
      lodOff.uploadedBytes,
      `${lodOff.uploadedBytes.toLocaleString()} bytes re-uploaded over the full-detail sweep (registration uploaded ${registrationUploadedBytes.toLocaleString()})`,
    ).toBeLessThan(registrationUploadedBytes / 1000);
    expect(
      lodOff.worstFrameMs,
      `LOD off: worst frame ${lodOff.worstFrameMs.toFixed(2)}ms at N=${N.toLocaleString()} (build ${buildMs.toFixed(0)}ms once)`,
    ).toBeLessThan(FRAME_MS_STATIC);
  });

  it("LOD ON (reductions on): the frontier re-cut stays O(visible) and re-uploads in place", () => {
    // Signature 1 — per-node colour stays a build-time cost even though the frontier re-cuts per frame.
    expect(lodOn.nodeFillAfter, "nodeFill re-ran during the LOD zoom sweep").toBe(lodOn.nodeFillBefore);

    // Signature 2 — super-edge colour is view-dependent, so it MUST run per frame; the ceiling is
    // absolute and N-independent, which is what makes this an O(visible) assertion rather than an
    // O(N) one: the true value stays flat as N grows while the regression it catches — falling back
    // to colouring every edge each frame — grows with `EDGES`.
    const sweepLinkStroke = lodOn.linkStrokeAfter - lodOn.linkStrokeBefore;
    const perFrame = sweepLinkStroke / lodOn.frames;
    expect(sweepLinkStroke, "the LOD sweep coloured no super-edge — the frontier never re-cut").toBeGreaterThan(0);
    expect(
      perFrame,
      `LOD sweep resolved ${perFrame.toFixed(0)} link colours per frame (${sweepLinkStroke.toLocaleString()} over ${lodOn.frames} frames) — must stay screen-bounded, not O(${EDGES.toLocaleString()} edges)`,
    ).toBeLessThan(LOD_LINK_COLOURS_PER_FRAME);

    // Signature 3 — a set-stable re-emit takes the in-place path, so no per-frame buffer churn.
    expect(lodOn.buffersCreated, "GPU buffers were created during the LOD zoom sweep").toBe(0);
    expect(lodOn.buffersDeleted, "GPU buffers were destroyed during the LOD zoom sweep").toBe(0);
    // The frontier genuinely changes per frame, so bytes DO move here — the requirement is that the
    // volume is screen-bounded, not O(N). Measured ~103 KB/frame at 50k nodes and ~105 KB/frame at
    // 100k (flat, as the declutter-bounded frontier demands), against a 12MB retained upload. Like
    // the link-colour ceiling above this is an ABSOLUTE, N-independent number.
    const uploadPerFrame = lodOn.uploadedBytes / lodOn.frames;
    expect(uploadPerFrame, "the LOD sweep uploaded nothing — the frontier never re-cut").toBeGreaterThan(0);
    expect(
      uploadPerFrame,
      `LOD sweep uploaded ${(uploadPerFrame / 1024).toFixed(0)} KB per frame (${lodOn.uploadedBytes.toLocaleString()} bytes over ${lodOn.frames} frames) — must stay screen-bounded, not O(N)`,
    ).toBeLessThan(LOD_UPLOAD_BYTES_PER_FRAME);
    expect(
      lodOn.worstFrameMs,
      `LOD on: worst frame ${lodOn.worstFrameMs.toFixed(2)}ms at N=${N.toLocaleString()} (LOD tree ${lodBuildMs.toFixed(0)}ms once)`,
    ).toBeLessThan(FRAME_MS_LOD);
  });
});
