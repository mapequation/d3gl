import { describe, it, expect, beforeAll } from "vitest";
import { Network, type NetworkOptions, type NetworkStyle } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import { nodeBorderColumnStats } from "../glyphs.js";
import { borderColumnStats } from "../../webgl/instanced.js";
import { perfBudget, perfN } from "../../__tests__/perf-budget.js";
import { GlBufferSpy, perfHost } from "../../__tests__/engine-sweep.js";

/**
 * ENGINE-level per-frame guard for #513: with LOD off, a position-only frame (a layout tick, a drag) must not
 * rebuild or re-upload the node layer's border columns (`borders`, 4 B per node, and `borderColors`, 4 B per
 * node). They depend on the style and the node colours only, so the no-LOD style cache builds them once per
 * style version and the renderer skips their upload while they are the arrays it last wrote.
 *
 * One engine (a second WebGL engine after a large upload stalls `whenReady`, #287) through the real repaint
 * path: the positions move in place, then the engine's streamed-frame repaint ({@link FrameProbe.positionFrame},
 * what the worker transport triggers). Legs: an absolute flow border with one colour, a flow border shaded from
 * each node's fill, and a node border shaded from each node's fill. Signatures, all load-independent: no border
 * column built and none written per position frame, and the frame's whole upload at most the 16 B per node of
 * centres, radii and fill colours. Then the other way: new node colours, or a new flow border, rebuild and
 * re-upload them once, and the frames after skip them again. The frame time is a generous ceiling only.
 */

const N = perfN(1_000_000, { max: 1_000_000 });
const W = 640;
const H = 400;
const FRAMES = 8;
// Measured (local headless Chromium, M-series laptop, host load ~60; median frame, absolute / shaded flow border /
// node border): at 600k, 6.9 / 9.5 / 11.5 ms with the border columns rebuilt and uploaded per frame (24 B per node
// uploaded), 1.4 / 0.7 / 1.4 ms without (16 B); at 1M, 3-5 / 3 / 3-7 ms (the per-frame rebuild did not finish the
// file within the runner's watchdog at ≥900k). Constant + linear ceiling, ~5-10× the measured value
// (docs/agents/performance.md).
const FRAME_MS = perfBudget(5 + (35 * N) / 1_000_000);
/** Centres (8 B), radii (4 B) and fill colours (4 B) per node: what a position frame may still upload. */
const FRAME_BYTES = 16 * N + 4096;
const SETUP_MS = perfBudget(120_000 + N / 5);

class FrameProbe extends Network {
  constructor(host: HTMLElement, opts: NetworkOptions) {
    super(host, opts);
  }
  /** One layout frame: the positions already moved in place, then the streamed-frame repaint, drawn now. */
  positionFrame(): void {
    this.scheduleLayoutRepaint();
    this.flushFrame();
  }
}

function fixture(n: number): { graph: NetworkGraph; flow: Float32Array } {
  const side = Math.ceil(Math.sqrt(n));
  const graph = buildGraph({ nodeCount: n, source: [], target: [], directed: false });
  for (let i = 0; i < n; i++) {
    graph.positions[2 * i] = (i % side) * 10;
    graph.positions[2 * i + 1] = Math.floor(i / side) * 10;
  }
  const flow = Float32Array.from({ length: n }, (_, i) => (1 + (i % 7)) / n);
  return { graph, flow };
}

interface Frames {
  builds: number;
  writes: number;
  uploadedBytes: number;
  created: number;
  medianMs: number;
}

interface Restyle {
  builds: number;
  writes: number;
}

let absolute: Frames, shaded: Frames, nodeBorder: Frames, afterRecolour: Frames;
let recolour: Restyle, newFlowBorder: Restyle;

beforeAll(async () => {
  const spy = new GlBufferSpy();
  try {
    const { graph, flow } = fixture(N);
    const net = new FrameProbe(perfHost(W, H), { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    const fill = (i: number): string => (i % 2 ? "#4878d0" : "#ee854a");
    const base: NetworkStyle = { nodeRadius: 3, sizeMode: "screen", linkStyle: "none", nodeFill: fill };
    const scale = (v: number): number => Math.min(3, Math.sqrt(v * N));
    net.data(graph).style({ ...base, flowBorder: { flow, scale, color: "#333" } });

    /** Move every node a little, in place, as a layout tick does. */
    const move = (frame: number): void => {
      const p = graph.positions;
      for (let i = 0; i < 2 * N; i++) p[i] = p[i]! + (frame % 2 ? 0.5 : -0.5);
    };
    const runFrames = (): Frames => {
      move(0);
      net.positionFrame(); // warm
      const builds = nodeBorderColumnStats.builds;
      const writes = borderColumnStats.writes;
      const mark = spy.mark();
      const times: number[] = [];
      for (let f = 1; f <= FRAMES; f++) {
        move(f);
        const t0 = performance.now();
        net.positionFrame();
        times.push(performance.now() - t0);
      }
      const d = spy.since(mark);
      times.sort((a, b) => a - b);
      return {
        builds: nodeBorderColumnStats.builds - builds,
        writes: borderColumnStats.writes - writes,
        uploadedBytes: d.uploadedBytes / FRAMES,
        created: d.created,
        medianMs: times[FRAMES >> 1] ?? 0,
      };
    };
    const restyle = (style: NetworkStyle): Restyle => {
      const builds = nodeBorderColumnStats.builds;
      const writes = borderColumnStats.writes;
      net.style(style);
      net.positionFrame();
      return { builds: nodeBorderColumnStats.builds - builds, writes: borderColumnStats.writes - writes };
    };

    absolute = runFrames();
    net.style({ ...base, flowBorder: { flow, scale } }); // no colour: each node's fill, darkened
    shaded = runFrames();
    net.style({ ...base, flowBorder: undefined, nodeBorder: { width: 1 } }); // the flow border off; no colour: each node's fill, darkened
    nodeBorder = runFrames();
    recolour = restyle({ ...base, nodeBorder: { width: 1 }, nodeFill: (i) => (i % 3 ? "#6acc64" : "#d65f5f") });
    afterRecolour = runFrames();
    newFlowBorder = restyle({ ...base, flowBorder: { flow, scale: (v) => Math.min(2, v * N), color: "#000" }, nodeBorder: undefined });
    console.log(
      `[#513] N=${N.toLocaleString()} median frame: absolute ${absolute.medianMs.toFixed(1)}ms, shaded ${shaded.medianMs.toFixed(1)}ms, ` +
        `node border ${nodeBorder.medianMs.toFixed(1)}ms; upload ${(absolute.uploadedBytes / N).toFixed(1)} B/node/frame`,
    );
    net.destroy();
  } finally {
    spy.restore();
  }
}, SETUP_MS);

describe(`network() LOD off: border columns across position frames at N=${N.toLocaleString()} (#513)`, () => {
  it("a position frame builds no border column", () => {
    expect(absolute.builds, "absolute flow border").toBe(0);
    expect(shaded.builds, "shaded flow border").toBe(0);
    expect(nodeBorder.builds, "node border").toBe(0);
    expect(afterRecolour.builds, "node border after new colours").toBe(0);
  });

  it("a position frame uploads no border column, and at most the centres, radii and fill colours", () => {
    for (const [name, leg] of [["absolute", absolute], ["shaded", shaded], ["node border", nodeBorder], ["after new colours", afterRecolour]] as const) {
      expect(leg.writes, `${name}: border columns written`).toBe(0);
      expect(leg.uploadedBytes, `${name}: ${(leg.uploadedBytes / N).toFixed(1)} B per node per frame`).toBeLessThanOrEqual(FRAME_BYTES);
      expect(leg.uploadedBytes, `${name}: the frame uploaded nothing (vacuous)`).toBeGreaterThan(0);
      expect(leg.created, `${name}: GPU buffers created`).toBe(0);
    }
  });

  it("new node colours rebuild and re-upload the shaded node border once", () => {
    expect(recolour.builds).toBe(1);
    expect(recolour.writes).toBe(2);
  });

  it("a new flow border rebuilds and re-uploads the border columns once", () => {
    expect(newFlowBorder.builds).toBe(1);
    expect(newFlowBorder.writes).toBe(2);
  });

  it("a position frame stays within its frame budget", () => {
    for (const leg of [absolute, shaded, nodeBorder]) expect(leg.medianMs).toBeLessThan(FRAME_MS);
  });
});
