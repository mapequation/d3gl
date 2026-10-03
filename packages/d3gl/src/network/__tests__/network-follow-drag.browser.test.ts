import { describe, it, expect, afterEach, vi } from "vitest";
import { network, type Network } from "../network.js";
import { buildGraph, type NetworkGraph } from "../graph.js";
import type { ModuleLink, ModuleNode } from "../modules.js";
import { GpuForceLayout } from "../gpu/gpu-force-layout.js";
import { makeTestDevice } from "../gpu/__tests__/_device.js";

/**
 * A drag next to a followed warm stream (#454) — a warm layout streamed without a transition, whose frames the
 * engine eases toward — through the real gesture (pointer events on the host):
 *
 * - with the nested drag (#451): a node grabbed while a warm nested map streams is held over its frames (the
 *   solve still runs), and once the map has landed a grab re-solves the grabbed node's module — also while
 *   the landed map still eases in: in a followed stream's tail (the solve landed, the ease still catching up)
 *   and in a transition's ease, the grab finishes the ease and re-solves the module;
 * - with the GPU's unchanged-pin skip (#458): a drag during a followed warm GPU stream reaches the GPU solve
 *   through the follower's handle, and re-pinning the unchanged held set on every move writes no pin texels.
 */

const TOP = 4;
const MID = 4;
const LEAVES = 12;
const N = TOP * MID * LEAVES;
const SIZE = 400;
const K = 20; // 1 world unit = 20 px: past the click slop

/** The nested-drag fixture: 4 top modules × 4 bottom modules × 12 leaves, rings inside, module links above. */
function fixture(): { graph: NetworkGraph; modules: ModuleNode[]; links: ModuleLink[] } {
  const modules: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  const links: ModuleLink[] = [];
  for (let a = 1; a <= TOP; a++) {
    for (let m = 1; m <= MID; m++) {
      const lo = modules.length;
      for (let l = 1; l <= LEAVES; l++) modules.push({ id: modules.length, path: [a, m, l] });
      for (let i = 0; i < LEAVES; i++) {
        source.push(lo + i, lo + i);
        target.push(lo + ((i + 1) % LEAVES), lo + ((i + 5) % LEAVES));
      }
      links.push({ source: [a, m], target: [a, (m % MID) + 1], flow: 1 });
    }
    links.push({ source: [a], target: [(a % TOP) + 1], flow: 1 });
  }
  return { graph: buildGraph({ nodeCount: N, source, target, directed: true }), modules, links };
}

const hosts: HTMLElement[] = [];
function host(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `position:absolute;left:0;top:0;width:${SIZE}px;height:${SIZE}px`;
  document.body.appendChild(el);
  hosts.push(el);
  return el;
}
afterEach(() => {
  for (const h of hosts.splice(0)) h.remove();
  vi.restoreAllMocks();
});

const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
};

/** Wait up to `n` animation frames for `done()`; returns whether it happened. */
async function until(done: () => boolean, n = 600): Promise<boolean> {
  for (let i = 0; i < n && !done(); i++) await frames(1);
  return done();
}

function pointer(h: HTMLElement, type: string, x: number, y: number): void {
  const r = h.getBoundingClientRect();
  h.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, button: 0, pointerId: 1 }));
}

/** Zoom to `K` with world point (x, y) at the host's centre. */
function centreOn(net: Network, x: number, y: number): void {
  net.setTransform({ k: K, x: SIZE / 2 - x * K, y: SIZE / 2 - y * K });
}

/** The fixture laid out flat on the worker and settled: what a switch to the nested map goes on from. */
async function flat(): Promise<{ net: Network; h: HTMLElement; g: NetworkGraph }> {
  const h = host();
  const net = network(h, { width: SIZE, height: SIZE });
  await net.whenReady();
  const { graph: g, modules, links } = fixture();
  net.data(g, { modules, moduleLinks: links }).style({ nodeRadius: 3, sizeMode: "screen" }).lod(false);
  net.layout({ backend: "worker", fit: true });
  await net.whenSettled();
  await frames(5);
  net.interactive({ draggable: true, selectable: true });
  return { net, h, g };
}

/** The unit vector from `leaf` toward its bottom module's leaf centroid. */
function towardModule(p: Float32Array, leaf: number): [number, number] {
  const lo = leaf - (leaf % LEAVES);
  let mx = 0;
  let my = 0;
  for (let i = lo; i < lo + LEAVES; i++) {
    mx += p[2 * i]! / LEAVES;
    my += p[2 * i + 1]! / LEAVES;
  }
  const d = Math.hypot(mx - p[2 * leaf]!, my - p[2 * leaf + 1]!) || 1;
  return [(mx - p[2 * leaf]!) / d, (my - p[2 * leaf + 1]!) / d];
}

/**
 * Grab the leaf under the cursor once the view is centred on `leaf` (the leaf itself on a landed map; in a
 * running ease, whichever leaf is there as the grab lands), drag it one world unit toward its module's centre
 * and hold it there for 30 frames. Returns how many of its module's other leaves moved from where the drag
 * started (a nested drag re-solves the module; a translate-only drag moves none), how far the leaf ended from
 * where the cursor took it, and whether the drag's start moved the other nodes (it finished a running ease).
 */
async function nestedDrag(net: Network, h: HTMLElement, g: NetworkGraph, leaf: number, onStart?: () => void): Promise<{ siblingsMoved: number; off: number; finishedEase: boolean }> {
  const c = SIZE / 2;
  let hit: number | undefined;
  for (let attempt = 0; attempt < 20 && hit === undefined; attempt++) {
    centreOn(net, g.positions[2 * leaf]!, g.positions[2 * leaf + 1]!);
    await frames(1);
    hit = net.pick(c, c)?.id;
  }
  if (hit === undefined) throw new Error("nothing under the cursor to grab");
  const grabbed = g.positions.slice();
  const [ux, uy] = towardModule(grabbed, hit);
  pointer(h, "pointerdown", c, c); // the grab is picked here, with the positions `pick` just saw
  pointer(h, "pointermove", c + 0.5 * ux * K, c + 0.5 * uy * K); // past the click slop: the drag starts
  pointer(h, "pointermove", c, c); // and back, before any frame: every node where the drag started
  const started = g.positions.slice(); // where the drag started: a running ease finished, the landed map
  onStart?.();
  let finishedEase = false;
  for (let i = 0; i < N && !finishedEase; i++) finishedEase = started[2 * i] !== grabbed[2 * i] || started[2 * i + 1] !== grabbed[2 * i + 1];
  const x0 = started[2 * hit]!;
  const y0 = started[2 * hit + 1]!;
  pointer(h, "pointermove", c + ux * K, c + uy * K);
  await frames(30);
  const lo = hit - (hit % LEAVES);
  let siblingsMoved = 0;
  for (let i = lo; i < lo + LEAVES; i++) {
    if (i !== hit && (g.positions[2 * i] !== started[2 * i] || g.positions[2 * i + 1] !== started[2 * i + 1])) siblingsMoved++;
  }
  const off = Math.hypot(g.positions[2 * hit]! - (x0 + ux), g.positions[2 * hit + 1]! - (y0 + uy));
  pointer(h, "pointerup", c + ux * K, c + uy * K);
  await frames(120); // the re-cool (at most 90 ticks)
  return { siblingsMoved, off, finishedEase };
}

describe("a drag next to a followed warm nested stream (#454, #451)", () => {
  for (const backend of ["worker", "gpu"] as const) {
    it(`${backend}: a node grabbed as the map starts streaming is held over its frames; once it has landed, a drag re-solves the module`, async () => {
      const { net, h, g } = await flat();
      const leaf = 2 * LEAVES + 3;
      centreOn(net, g.positions[2 * leaf]!, g.positions[2 * leaf + 1]!);
      await frames(1);
      expect(net.pick(SIZE / 2, SIZE / 2)?.id).toBe(leaf);
      const before = g.positions.slice();
      // Followed: warm, streamed, no transition. The grab lands before the stream's first frame does, so the
      // hold spans the whole followed stream — the solve still runs, so it is held over its frames (#451).
      net.layout({ backend, nested: true, warm: true });
      const c = SIZE / 2;
      pointer(h, "pointerdown", c, c);
      pointer(h, "pointermove", c + 10, c);
      pointer(h, "pointermove", c + 20, c); // one world unit to the right
      await net.whenSettled();
      await frames(5);
      expect(g.positions[2 * leaf]).toBeCloseTo(before[2 * leaf]! + 1, 3);
      expect(g.positions[2 * leaf + 1]).toBeCloseTo(before[2 * leaf + 1]!, 3);
      let moved = 0;
      for (let i = 0; i < N; i++) if (i !== leaf && g.positions[2 * i] !== before[2 * i]) moved++;
      expect(moved, "non-vacuity: the nested map streamed under the hold").toBeGreaterThan(N / 2);
      pointer(h, "pointerup", c + 20, c);
      await frames(10);

      // Landed: a grab re-solves the grabbed node's module, as on any landed nested map (#451).
      const drag = await nestedDrag(net, h, g, 5 * LEAVES + 7);
      expect(drag.finishedEase, "the map had not landed").toBe(false);
      expect(drag.off, "the dragged leaf left the cursor").toBeLessThan(0.05);
      expect(drag.siblingsMoved, "a translate-only drag: the module did not re-solve around the held leaf").toBeGreaterThan(0);
      net.destroy();
    });
  }

  // The followed stream's tail (no transition: the ease chases the solve's frames, and outlasts a small solve), and
  // a warm map eased in over a transition (the ease starts once the solve has landed): either way the map has
  // landed and is still easing in when the grab lands.
  for (const transition of [0, 1000]) it(`worker, ${transition ? "a transition's ease" : "a followed stream's tail"}: a grab while the landed map eases in finishes the ease and re-solves the module`, async () => {
    const { net, h, g } = await flat();
    // Both eases run on `performance.now`: held still until the solve has landed, so the grab is guaranteed
    // to land mid-ease however slowly the worker answers.
    let virtual = performance.now();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => virtual);
    const terminate = vi.spyOn(Worker.prototype, "terminate"); // calls through
    net.layout({ backend: "worker", nested: true, warm: true, ...(transition ? { transition } : {}) });
    // The flat run's worker went with the call; the nested solve's worker exits with the landed layout.
    const base = terminate.mock.calls.length;
    expect(await until(() => terminate.mock.calls.length > base), "the nested solve never landed").toBe(true);
    // About 130 ms into the ease (a fifth of the follower's 600 ms, an eighth of the transition), then held
    // again for the grab.
    for (let i = 0; i < 8; i++) {
      virtual += 16;
      await frames(1);
    }
    const drag = await nestedDrag(net, h, g, 2 * LEAVES + 3, () => clock.mockRestore());
    expect(drag.finishedEase, "non-vacuity: the ease had ended before the grab").toBe(true);
    expect(drag.off, "the dragged leaf left the cursor").toBeLessThan(0.05);
    expect(drag.siblingsMoved, "a translate-only drag: the module did not re-solve around the held leaf").toBeGreaterThan(0);
    await net.whenSettled();
    net.destroy();
  });
});

describe("a drag during a followed warm GPU stream re-pins through the follower without pin writes (#454, #458)", () => {
  it("every move reaches the GPU solve; only the first pin and the release write pin texels", async () => {
    const h = host();
    const net = network(h, { width: SIZE, height: SIZE, backend: "webgl" });
    await net.whenReady();
    const { graph: g } = fixture();
    net.data(g).style({ nodeRadius: 6, sizeMode: "screen" }).lod(false).layout({ backend: "gpu", fit: true });
    await net.whenSettled();
    expect(net.layoutTransport).toBe("gpu");
    await frames(5);
    // A pin flag is one r8 texel written from the layout's 1-byte scratch (held positions are Float32Arrays, the
    // renderer's style tables whole rows).
    const device = await makeTestDevice();
    const probe = device.createTexture({ width: 1, height: 1, format: "r8unorm" });
    const writes = vi.spyOn(Object.getPrototypeOf(probe) as { writeData: (...a: unknown[]) => void }, "writeData");
    probe.destroy();
    const flagWrites = (): number => writes.mock.calls.filter(([data]) => data instanceof Uint8Array && data.length === 1).length;
    const setPinned = vi.spyOn(GpuForceLayout.prototype, "setPinned"); // calls through

    // A selected bottom module: a grab of one of its leaves drags all twelve.
    const held = Array.from({ length: LEAVES }, (_, i) => 3 * LEAVES + i);
    net.interactive({ draggable: true, selectable: { multi: true } });
    net.select("nodes", held);
    const leaf = held[0]!;
    centreOn(net, g.positions[2 * leaf]!, g.positions[2 * leaf + 1]!);
    await frames(1);
    expect(held).toContain(net.pick(SIZE / 2, SIZE / 2)?.id);
    const before = g.positions.slice();
    // Followed: a warm GPU stream with no transition. Grabbed at once, before its first frame.
    net.layout({ backend: "gpu", warm: true });
    const c = SIZE / 2;
    pointer(h, "pointerdown", c, c);
    pointer(h, "pointermove", c + 10, c);
    // The follower eases toward the GPU solve's frames while the module is held.
    expect(await until(() => g.positions[2 * 0] !== before[2 * 0]), "the followed stream never moved the layout").toBe(true);
    expect(flagWrites(), "the first pin sets one flag per held node").toBe(held.length);
    writes.mockClear();
    setPinned.mockClear();
    for (let move = 1; move <= 5; move++) {
      pointer(h, "pointermove", c + 10 + 4 * move, c);
      await frames(1);
    }
    expect(setPinned.mock.calls.length, "non-vacuity: the moves did not reach the GPU solve").toBeGreaterThanOrEqual(5);
    expect(flagWrites(), "re-pinning the unchanged held set wrote pin texels").toBe(0);
    for (const id of held) expect(g.positions[2 * id]).toBeCloseTo(before[2 * id]! + 30 / K, 3); // held under the cursor
    pointer(h, "pointerup", c + 30, c);
    expect(flagWrites(), "the release clears one flag per held node").toBe(held.length);
    await net.whenSettled();
    writes.mockRestore();
    net.destroy();
    device.destroy();
  });
});
