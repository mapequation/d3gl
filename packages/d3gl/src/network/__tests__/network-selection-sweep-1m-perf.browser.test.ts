import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { network, type Network } from "../network.js";
import { buildGraph } from "../graph.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost, sweepFrames, zoomSteps } from "../../__tests__/engine-sweep.js";

/**
 * `network-sweep-perf`'s full-detail selection leg (#428) at ≈1M nodes (AGENTS lifecycle §5), on an engine of
 * its own: LOD off, interactive, every 97th node selected, a `setTransform` zoom sweep. The no-LOD
 * selected-flag cache is keyed on the selection set's identity (#428: a `select()` made while the lane waited
 * must invalidate it), one reference compare per no-LOD emit; a key that stopped matching per frame would
 * rebuild and re-upload one byte per node and per edge on every zoom step.
 *
 * Asserted: no accessor re-run, no GPU buffer created or destroyed, and a per-frame upload under an absolute
 * O(selected) bound — the ring overlay's 24-byte instances, 48 B allowed per selected node — which a flags
 * re-upload at this N (≈2 MB per frame) crosses by two orders of magnitude; plus a static-frame ceiling.
 * `network-sweep-perf` keeps the same leg at the tier's scale beside its LOD legs, which cap it at 200k.
 */

const N = perfN(1_000_000, { max: 1_000_000 });
const EDGES = N - 1;
const COLS = Math.max(1, Math.round(Math.sqrt(N)));
const W = 640;
const H = 400;
/** Per-frame upload allowed per selected node: 2× the ring overlay's 24-byte instance. Deterministic, never scaled. */
const RING_BYTES_PER_SELECTED = 48;
const SELECTED = Array.from({ length: Math.ceil(N / 97) }, (_, i) => i * 97);
// A static full-detail frame is a uniform write plus the instanced draws: `network-sweep-perf` measured
// 0.1 ms at 50k and 100k. The ceiling is its static one at this N, far under an O(N) flags rebuild.
const FRAME_MS_STATIC = perfBudget(4 + (4 * N) / 50_000);

/** A binary-tree graph on a square grid, as `network-sweep-perf`'s fixture. */
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

describe(`network() full-detail zoom sweep with a selection (#428) at N=${N.toLocaleString()}`, () => {
  let net: Network;
  let host: HTMLElement;
  const spy = new GlBufferSpy();
  let nodeFill = 0;
  let linkStroke = 0;
  let result = { fillBefore: 0, fillAfter: 0, strokeBefore: 0, strokeAfter: 0, created: 0, deleted: 0, uploaded: 0, frames: 0, worstFrameMs: 0, registered: 0 };

  beforeAll(async () => {
    host = perfHost(W, H);
    net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const { graph, positions } = fixture(N);
    const atStart = spy.mark();
    net
      .data(graph)
      .style({
        nodeRadius: 3,
        sizeMode: "screen",
        nodeFill: (i) => (nodeFill++, i % 2 ? "rgb(59,130,246)" : "rgb(245,158,11)"),
        linkStroke: (w) => (linkStroke++, w > 1 ? "rgb(100,116,139)" : "rgb(203,213,225)"),
      })
      .lod(false)
      .layout({ backend: "positions", positions });
    net.interactive({ selectable: true }).select("nodes", SELECTED);
    net.setTransform({ k: 1, x: 0, y: 0 }); // settle the registration's first frame outside the sweep
    const registered = spy.since(atStart).uploadedBytes;
    const fillBefore = nodeFill;
    const strokeBefore = linkStroke;
    const before = spy.mark();
    const { worstFrameMs, frames } = sweepFrames(zoomSteps(W, H), (t) => net.setTransform(t));
    const used = spy.since(before);
    result = { fillBefore, fillAfter: nodeFill, strokeBefore, strokeAfter: linkStroke, created: used.created, deleted: used.deleted, uploaded: used.uploadedBytes, frames, worstFrameMs, registered };
  }, perfBudget(120_000 + N / 2));

  afterAll(() => {
    spy.restore();
    net?.destroy();
    host?.remove();
  });

  it("registers and really uploads (non-vacuity)", () => {
    expect(result.registered, "registration uploaded nothing — the spy is not observing the live context").toBeGreaterThan(0);
    expect(result.fillBefore, "nodeFill did not resolve once per node — the fixture did not register").toBe(N);
    expect(result.frames).toBeGreaterThan(0);
    console.log(`  N=${N}: ${result.frames} frames, ${(result.uploaded / result.frames).toFixed(0)} B uploaded per frame (${SELECTED.length} selected), worst frame ${result.worstFrameMs.toFixed(2)} ms, registration uploaded ${(result.registered / 1e6).toFixed(1)} MB`);
    expect(N + EDGES, "the fixture is too small for a flags re-upload to cross the ring bound").toBeGreaterThan(SELECTED.length * RING_BYTES_PER_SELECTED);
  });

  it("a zoom frame re-runs no accessor, churns no buffer and uploads O(selected), not the selected flags", () => {
    expect(result.fillAfter, "nodeFill re-ran during the sweep").toBe(result.fillBefore);
    expect(result.strokeAfter, "linkStroke re-ran during the sweep").toBe(result.strokeBefore);
    expect(result.created, "GPU buffers created during the sweep").toBe(0);
    expect(result.deleted, "GPU buffers destroyed during the sweep").toBe(0);
    const perFrame = result.uploaded / result.frames;
    expect(perFrame, `${perFrame.toLocaleString()} B per frame, ${SELECTED.length.toLocaleString()} nodes selected`).toBeLessThan(SELECTED.length * RING_BYTES_PER_SELECTED);
    expect(result.worstFrameMs, `worst frame ${result.worstFrameMs.toFixed(2)} ms at N=${N.toLocaleString()}`).toBeLessThan(FRAME_MS_STATIC);
  });
});
