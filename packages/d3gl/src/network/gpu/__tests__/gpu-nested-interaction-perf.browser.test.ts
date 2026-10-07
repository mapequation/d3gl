/**
 * A node drag and a zoom sweep while the GPU nested solve runs (#375, AGENTS §5: continuous pointer
 * interaction and a `setTransform` sweep are per-frame paths). `layout({ backend: "auto", nested })` moves
 * a nested layout from the worker, which costs the main thread no frame while it solves, to the GPU
 * transport, whose work shares each frame with the interaction. Through the real triggers — pointer
 * events on the engine's host and `setTransform` — during the cold stream (a repaint per harvest) and
 * during the warm solve before its transition (the re-clustering call: nothing repaints until it lands),
 * LOD off and on, each against the same interaction during the worker's solve:
 *
 * - the held leaves stay under the cursor after every frame, GPU harvests included (a harvest and the
 *   repaint that re-holds them run in one animation-frame callback);
 * - the transport keeps its per-frame p95 ceiling and encode median (the stream guard's);
 * - GL signatures: every harvest after its copy's fence, each readback PBO written once then read once,
 *   one fence per solve frame, no GPU object created in a solve frame. The sweep's `setTransform` re-emits
 *   the LOD lane, which reallocates its buffers when the frontier reaches a new maximum (#395); those,
 *   and a landed map's repaint after the solve's last frame, are the draw path's and reported apart;
 * - each animation frame's main thread (every callback of the frame) within the worker run's p95 plus the
 *   transport ceiling.
 *
 * The fixture and the GL call log are `_nested-perf.ts`, shared with `gpu-nested-perf.browser.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { network, type Network } from "../../network.js";
import type { NetworkGraph } from "../../graph.js";
import type { ModuleNode } from "../../modules.js";
import type { HoverHit } from "../../../map/base-engine.js";
import { observeGpuLayoutFrames, type GpuFrameSample } from "../gpu-stream.js";
import { perfBudget, perfN } from "../../../__tests__/perf-budget.js";
import { perfHost } from "../../../__tests__/engine-sweep.js";
import {
  GlCallLog,
  H,
  ITERATIONS,
  RafTimer,
  W,
  assertFencedHarvests,
  infomapLike,
  median,
  pboAccesses,
  perFrame,
  quantile,
  type GlEvent,
} from "./_nested-perf.js";

const LOCAL_N = 20_000;
// Capped at the local default: under software GL a drag repaints a LOD-off frame of every leaf on each
// pointer move, and at the browser tier's 100k one variant (the cold stream, LOD off, worker and GPU runs)
// took 183 s locally, past the tier's 5-minute per-file budget with four (at 20k all four take ~90 s).
const N = perfN(LOCAL_N, { max: LOCAL_N });

/** Pointer moves of the drag (one per frame), then frames of the zoom sweep, while the solve runs: 24
 *  frames per run, so a p95 is the second-largest sample. */
const DRAG_FRAMES = 16;
const SWEEP_FRAMES = 8;
/** Zoom of the drag (leaf spacing ≈ 18 world units, so ≈ 72 px apart). */
const DRAG_K = 4;
/** Frames the grab looks for a drawn glyph under a leaf's streamed position before it gives up. */
const GRAB_FRAMES = 30;
/**
 * Frames the grab may wait for the drawn map to catch up with the positions it read: a worker frame's
 * positions are drawn in the next animation frame (see the grab), a GPU harvest's in its own.
 */
const GRAB_LAG_FRAMES = 1;
/** World units a held leaf may sit off the cursor (float32 positions of a map ~1,400 units across). */
const HOLD_TOLERANCE = 1e-2;
/** The warm re-layout's transition, as the re-clustering call passes one (the Navigator: 600 ms). */
const TRANSITION_MS = 1000;

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** What one drag-and-sweep during a nested solve observed. */
interface InteractLeg {
  /** The GPU stream's frames during the interaction (none on the worker). */
  frames: GpuFrameSample[];
  /** GL calls from the layout call on (every harvest's copy and fence included), and where the interaction starts. */
  events: GlEvent[];
  interactionAt: number;
  /** Main-thread ms of every animation frame of the interaction (the transport's, the repaints'). */
  rafMs: number[];
  /** Main-thread ms of each pointer move's handler (the held-set write and repaint). */
  moveMs: number[];
  /** Leaves the grab held, and how many of them sat under the cursor after every held frame (checked on "auto"). */
  held: number;
  heldTracked: number;
  /** GPU frames that harvested positions while the held leaves were checked. */
  harvestsWhileHeld: number;
  /** Animation frames the grab waited for a drawn glyph under a leaf's position (0: found at once). */
  grabFrames: number;
  transport: string;
}

/**
 * Start a nested layout of the map on `backend` — cold (streamed), or warm with a transition from a cold
 * worker map (the re-clustering call) — and, while it solves, drag a leaf glyph for DRAG_FRAMES frames,
 * release it, and sweep the zoom for SWEEP_FRAMES frames. `hovered()` is the engine's latest hover hit.
 * The layout is stopped after the interaction.
 */
async function interactLeg(
  net: Network,
  host: HTMLElement,
  hovered: () => HoverHit | null,
  graph: NetworkGraph,
  modules: ModuleNode[],
  lod: boolean,
  backend: "auto" | "worker",
  phase: "cold" | "warm",
): Promise<InteractLeg> {
  net.setTransform({ k: 1, x: 0, y: 0 });
  // declutterSpacing 1: the grab looks for a glyph under the pointer; this guard is about drag lag, not the spacing.
  net.data(graph, { modules }).lod(lod ? { declutter: true, declutterSpacing: 1 } : false);
  if (phase === "warm") {
    net.layout({ backend: "worker", nested: { iterations: ITERATIONS } });
    await net.whenSettled();
  }
  const frames: GpuFrameSample[] = [];
  const log = new GlCallLog();
  const unobserve = observeGpuLayoutFrames((f) => {
    frames.push({ ...f });
    log.events.push({ kind: "frame-end" });
  });
  let raf: RafTimer | null = null;
  const id = Math.floor(graph.nodeCount / 3);
  const before = graph.positions.slice(2 * id, 2 * id + 2);
  const moveMs: number[] = [];
  let interactionFrame = 0;
  let interactionAt = 0;
  let trackedFrame = -1; // the frame the held-leaf check starts from
  let releasedFrame = 0;
  let held: number[] = [];
  let tracked: boolean[] = [];
  let grabFrames = 0;
  try {
    net.layout(phase === "warm" ? { backend, nested: { warm: true, iterations: ITERATIONS }, transition: TRANSITION_MS } : { backend, nested: { iterations: ITERATIONS } });
    // Interact once the solve is under way: a cold layout's first frame has landed (the grab is on the
    // streamed map); a warm GPU solve has encoded its first frame (the worker's runs off-thread).
    const moved = (): boolean => graph.positions[2 * id] !== before[0] || graph.positions[2 * id + 1] !== before[1];
    const running = phase === "cold" ? () => moved() && (backend === "worker" || frames.some((f) => f.harvested)) : () => backend === "worker" || frames.length > 0;
    for (let f = 0; f < 2000 && !running(); f++) await nextFrame();
    expect(running(), "the solve did not start").toBe(true);

    // Centre the leaf at the drag zoom (the LOD lane cuts its frontier there at once), then find a glyph
    // under the pointer — the leaf, or with LOD on an aggregate holding it, or else one of its module's
    // leaves — with a plain pointer move (the hover pick), and grab it there while the solve still runs.
    // The hover pick resolves the drawn glyphs, as the screen shows them. A worker frame writes the
    // positions in its message handler and draws them in an animation-frame callback queued after this
    // harness's, so the positions read here can be a frame ahead of the glyphs (the previous leg's map,
    // or the streamed frame before). With LOD on the cut is drawn from its tree's geometry, which that
    // repaint refits, so the pointer can land where nothing is drawn yet. Look again on the next frame,
    // until the drawn frame has caught up with the positions read.
    const rect = host.getBoundingClientRect();
    const pointer = (type: string, x: number, y: number, buttons: number): void => {
      host.dispatchEvent(new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, button: 0, buttons, pointerId: 1 }));
    };
    let t = { k: DRAG_K, x: 0, y: 0 };
    let gx = W / 2;
    let gy = H / 2;
    const first = id - (id % 40); // the leaf's bottom module: 40 consecutive ids (`infomapLike`)
    for (let tries = 0; tries < GRAB_FRAMES && held.length === 0; tries++) {
      grabFrames = tries;
      if (tries > 0) await nextFrame();
      t = { k: DRAG_K, x: W / 2 - (graph.positions[2 * id] ?? 0) * DRAG_K, y: H / 2 - (graph.positions[2 * id + 1] ?? 0) * DRAG_K };
      net.setTransform(t);
      for (let c = -1; c < 40 && held.length === 0; c++) {
        const leaf = c < 0 ? id : first + c;
        const x = (graph.positions[2 * leaf] ?? 0) * t.k + t.x;
        const y = (graph.positions[2 * leaf + 1] ?? 0) * t.k + t.y;
        if (x < 20 || y < 20 || x > W - 80 || y > H - 20) continue;
        pointer("pointermove", x, y, 0);
        const hit = hovered();
        held = (hit?.members?.() ?? (hit ? [hit.id] : [])).flatMap((m) => (typeof m === "number" && m < graph.nodeCount ? [m] : []));
        gx = x;
        gy = y;
      }
    }
    expect(held.length, `no glyph under the pointer to grab within ${GRAB_FRAMES} frames`).toBeGreaterThan(0);

    interactionFrame = frames.length;
    interactionAt = log.events.length;
    raf = new RafTimer();
    pointer("pointerdown", gx, gy, 1);
    pointer("pointermove", gx + 8, gy, 1); // past the click slop: the drag session starts
    const ref = new Float32Array(2 * held.length);
    let refX = 0;
    let refY = 0;
    for (let f = 1; f <= DRAG_FRAMES; f++) {
      const x = gx + 8 + 4 * f;
      const y = gy - 2 * f;
      const t0 = performance.now();
      pointer("pointermove", x, y, 1);
      moveMs.push(performance.now() - t0);
      await nextFrame();
      // On "auto", the held leaves move with the cursor frame to frame, whatever a GPU harvest wrote in
      // between. (A worker frame writes the positions in its message handler, between animation frames, and
      // the next repaint re-holds them, so the worker run is not checked here.)
      if (backend !== "auto") continue;
      const pos = graph.positions;
      if (trackedFrame < 0) {
        held.forEach((leaf, k) => {
          ref[2 * k] = pos[2 * leaf] ?? 0;
          ref[2 * k + 1] = pos[2 * leaf + 1] ?? 0;
        });
        tracked = held.map(() => true);
        refX = x;
        refY = y;
        trackedFrame = frames.length;
        continue;
      }
      const dx = (x - refX) / t.k;
      const dy = (y - refY) / t.k;
      held.forEach((leaf, k) => {
        const ex = (ref[2 * k] ?? 0) + dx - (pos[2 * leaf] ?? 0);
        const ey = (ref[2 * k + 1] ?? 0) + dy - (pos[2 * leaf + 1] ?? 0);
        if (Math.abs(ex) > HOLD_TOLERANCE || Math.abs(ey) > HOLD_TOLERANCE) tracked[k] = false;
      });
    }
    releasedFrame = frames.length;
    pointer("pointerup", gx + 8 + 4 * DRAG_FRAMES, gy - 2 * DRAG_FRAMES, 0);
    const wx = (gx - t.x) / t.k;
    const wy = (gy - t.y) / t.k;
    for (let f = 1; f <= SWEEP_FRAMES; f++) {
      const k = t.k * 1.04 ** f;
      log.events.push({ kind: "camera", start: true });
      net.setTransform({ k, x: gx - wx * k, y: gy - wy * k });
      log.events.push({ kind: "camera", start: false });
      await nextFrame();
    }
  } finally {
    unobserve();
    raf?.restore();
    log.restore();
  }
  const transport = net.layoutTransport;
  net.stopLayout();
  net.setTransform({ k: 1, x: 0, y: 0 });
  return {
    frames: frames.slice(interactionFrame),
    events: log.events,
    interactionAt,
    rafMs: raf?.frames ?? [],
    moveMs,
    held: held.length,
    heldTracked: tracked.filter(Boolean).length,
    harvestsWhileHeld: trackedFrame < 0 ? 0 : frames.slice(trackedFrame, releasedFrame).filter((f) => f.harvested).length,
    grabFrames,
    transport,
  };
}

/**
 * GPU objects an interaction created, by where: in the solve's frames (the transport, the drag and the
 * streamed repaints, which create none), inside a `setTransform` (the draw path's lane re-emit), and
 * after the solve's last frame (a warm solve lands and its transition repaints). The last two are the
 * draw path's: a zoom-in sweep or a landed map grows the LOD frontier, and an instanced lane reallocates
 * at every new maximum (#395), on the worker's run as on this one.
 */
function interactionCreates(leg: InteractLeg): { solveFrames: number; camera: number; after: number } {
  const during = leg.events.slice(leg.interactionAt);
  const lastFrame = during.map((e) => e.kind).lastIndexOf("frame-end");
  let inCamera = false;
  const out = { solveFrames: 0, camera: 0, after: 0 };
  during.forEach((e, i) => {
    if (e.kind === "camera") inCamera = e.start;
    else if (e.kind === "create") {
      if (inCamera) out.camera++;
      else if (i < lastFrame) out.solveFrames++;
      else out.after++;
    }
  });
  return out;
}

/** The transport's GL contract over an interaction: fenced PBO copies, one fence per solve frame, nothing created in one. */
function assertInteractSignatures(leg: InteractLeg): void {
  assertFencedHarvests(leg.events); // over the whole run: an interaction frame's harvest may read a copy from before it
  for (const accesses of pboAccesses(leg.events)) expect(accesses, "a readback PBO's writes (w) and reads (r)").toMatch(/^(wr)*w?$/);
  const during = leg.events.slice(leg.interactionAt);
  expect(during.filter((e) => e.kind === "copy").every((e) => e.kind === "copy" && e.toPbo), "a synchronous readPixels during the interaction").toBe(true);
  const segments = perFrame(during);
  expect(segments.length).toBe(leg.frames.length);
  segments.forEach((seg, f) => expect(seg.filter((e) => e.kind === "fence").length, `interaction frame ${f} fences`).toBe(1));
  expect(interactionCreates(leg).solveFrames, "GPU objects created in the solve's frames during the interaction").toBe(0);
  expect(during.filter((e) => e.kind === "layout-draw" && e.viewport1x1 && e.count >= N).length, "a draw of ≥ N points into a 1×1 viewport").toBe(0);
}

function reportInteract(label: string, gpu: InteractLeg, worker: InteractLeg): number[] {
  const transport = gpu.frames.map((f) => f.harvestMs + f.encodeMs);
  const f = (xs: number[]): string => `median ${median(xs).toFixed(2)} p95 ${quantile(xs, 0.95).toFixed(2)} max ${Math.max(0, ...xs).toFixed(2)} (${xs.length})`;
  const created = (leg: InteractLeg): string => {
    const c = interactionCreates(leg);
    return `${c.camera} / ${c.after}`;
  };
  console.log(
    `  drag + zoom sweep during a nested solve [${label}] N=${N}: "auto" (GPU) ${gpu.frames.length} solve frames ` +
      `(${gpu.harvestsWhileHeld} harvests while held, ${gpu.heldTracked} of ${gpu.held} held leaves tracked), transport ms/frame ${f(transport)}; ` +
      `frames the grab waited for the drawn map: "auto" ${gpu.grabFrames}, worker ${worker.grabFrames}; ` +
      `main thread ms/frame: "auto" ${f(gpu.rafMs)}, worker ${f(worker.rafMs)}; ` +
      `pointer-move handler ms: "auto" ${f(gpu.moveMs)}, worker ${f(worker.moveMs)}; ` +
      `GPU objects the draw path created (#395), in setTransform / after the solve: "auto" ${created(gpu)}, worker ${created(worker)}`,
  );
  return transport;
}

describe("a node drag and a zoom sweep during the GPU nested solve (#375) — network().layout({ backend: 'auto', nested })", () => {
  let host: HTMLElement;
  let net: Network;
  let fixture: { graph: NetworkGraph; modules: ModuleNode[] };
  let hover: HoverHit | null = null;

  beforeAll(async () => {
    fixture = infomapLike(N);
    host = perfHost(W, H);
    net = network(host, { width: W, height: H, backend: "webgl" });
    await net.whenReady();
    net.interactive({ draggable: true });
    net.on("hover", (hit) => {
      hover = hit;
    });
    // Warm-up on the same engine: the capability probe, shader compiles and the lane programs.
    const warm = infomapLike(2_000);
    net.data(warm.graph, { modules: warm.modules }).layout({ backend: "auto", nested: { iterations: 5 } });
    await net.whenSettled();
  }, perfBudget(120_000));

  afterAll(() => {
    net?.destroy();
    host?.remove();
  });

  // The stream guard's ceilings (`gpu-nested-perf.browser.test.ts`): fence polls, a harvest's memcpy and
  // at most 2 ms of encode per frame.
  const TRANSPORT_P95_MS = perfBudget(4 + 2 * (N / 100_000));
  const ENCODE_MEDIAN_MS = perfBudget(2.5);

  it.each<{ name: string; phase: "cold" | "warm"; lod: boolean }>([
    { name: "cold stream, LOD off", phase: "cold", lod: false },
    { name: "cold stream, LOD on", phase: "cold", lod: true },
    { name: "warm + transition, LOD off", phase: "warm", lod: false },
    { name: "warm + transition, LOD on", phase: "warm", lod: true },
  ])("$name: held leaves track the cursor; transport bounds; frames vs the worker's", async ({ name, phase, lod }) => {
    const hovered = (): HoverHit | null => hover;
    const worker = await interactLeg(net, host, hovered, fixture.graph, fixture.modules, lod, "worker", phase);
    const gpu = await interactLeg(net, host, hovered, fixture.graph, fixture.modules, lod, "auto", phase);
    const transport = reportInteract(name, gpu, worker);
    expect(worker.transport).toBe("copy");
    expect(worker.frames).toHaveLength(0);
    expect(gpu.transport).toBe("gpu");
    // The GPU solve ran through the drag: frames, and on the cold stream harvests while the leaves were held.
    expect(gpu.frames.length, "GPU solve frames during the interaction").toBeGreaterThan(0);
    if (phase === "cold") expect(gpu.harvestsWhileHeld, "GPU harvests while the leaves were held").toBeGreaterThan(0);
    expect(gpu.heldTracked, "held leaves under the cursor after every frame").toBe(gpu.held);
    for (const leg of [gpu, worker]) expect(leg.grabFrames, `${leg.transport}: frames the drawn map lagged the positions read`).toBeLessThanOrEqual(GRAB_LAG_FRAMES);
    expect(quantile(transport, 0.95)).toBeLessThan(TRANSPORT_P95_MS);
    expect(median(gpu.frames.map((f) => f.encodeMs))).toBeLessThan(ENCODE_MEDIAN_MS);
    assertInteractSignatures(gpu);
    for (const leg of [gpu, worker]) expect(leg.rafMs.length, "interaction frames").toBeGreaterThanOrEqual(DRAG_FRAMES + SWEEP_FRAMES);
    expect(quantile(gpu.rafMs, 0.95)).toBeLessThan(quantile(worker.rafMs, 0.95) + TRANSPORT_P95_MS);
  }, perfBudget(300_000));
});
