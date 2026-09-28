/**
 * Shared by the GPU nested layout's per-frame guards (#355, #375): `gpu-nested-perf.browser.test.ts` (the
 * cold stream, the warm re-layout with a transition, the solve per tick) and
 * `gpu-nested-interaction-perf.browser.test.ts` (a node drag and a zoom sweep while the solve runs) — the
 * Infomap-shaped fixture, the GL call log and its checks, and the per-animation-frame timer.
 */
import { expect } from "vitest";
import { buildGraph, type NetworkGraph } from "../../graph.js";
import type { ModuleNode } from "../../modules.js";
import { COLLISION_STEPS } from "../passes/collision.js";

export const ITERATIONS = 30; // 18 organise + 12 compact solve ticks = 18 + 24 stream ticks
export const STREAM_TICKS = 18 + COLLISION_STEPS * 12;
export const W = 800;
export const H = 600;

/** Minimal seeded LCG. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * An Infomap-shaped map over `n` leaves: top modules of ~10 mid modules of ~40 leaves (so the bottom
 * segments take the tile + grid paths), leaves chained inside each bottom module, a few random links
 * between modules (the super-edges the sibling springs read), and a heavy-tailed flow.
 */
export function infomapLike(n: number): { graph: NetworkGraph; modules: ModuleNode[] } {
  const rng = makePrng(0x355);
  const modules: ModuleNode[] = [];
  const source: number[] = [];
  const target: number[] = [];
  const flow = new Float32Array(n);
  for (let id = 0; id < n; id++) {
    const bottom = Math.floor(id / 40);
    modules.push({ id, path: [Math.floor(bottom / 10) + 1, (bottom % 10) + 1, (id % 40) + 1] });
    if (id % 40) {
      source.push(id - 1);
      target.push(id);
    }
    if (rng() < 0.2) {
      source.push(id);
      target.push(Math.floor(rng() * n));
    }
    flow[id] = (rng() + 0.05) ** -1.2;
  }
  return { graph: buildGraph({ nodeCount: n, source, target, nodeFlow: flow }), modules };
}

// ── GL call log (the flat streaming guard's, _gpu-stream-harness.ts) ────────────────────────────────

export type GlEvent =
  | { kind: "copy"; toPbo: boolean; pbo: WebGLBuffer | null }
  | { kind: "harvest"; pbo: WebGLBuffer | null }
  | { kind: "fence"; sync: WebGLSync | null }
  | { kind: "wait"; sync: WebGLSync; signaled: boolean }
  | { kind: "layout-draw"; count: number; viewport1x1: boolean; points: boolean }
  | { kind: "create" }
  /** A `setTransform` call starts (`true`) or returns: the draw path's re-emit, attributed apart from the transport. */
  | { kind: "camera"; start: boolean }
  | { kind: "frame-end" };

/** The buffer bound to `PIXEL_PACK_BUFFER` — the PBO a `readPixels` writes or a `getBufferSubData` reads. */
function boundPackBuffer(gl: WebGL2RenderingContext): WebGLBuffer | null {
  const bound: unknown = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
  return bound instanceof WebGLBuffer ? bound : null;
}

/**
 * Each readback PBO's writes (`w`, a `readPixels` into it) and reads (`r`, a `getBufferSubData` of it), in
 * order. Chrome serves a READ buffer's `getBufferSubData` from its shadow copy only for **one write, then
 * one read, per fence**: a second write before the read discards the copy ("written again before being
 * read back"), and a second read of the same copy is a synchronous GPU round trip ("read back without
 * waiting on a fence", a pipeline stall that main-thread time does not show).
 */
export function pboAccesses(events: readonly GlEvent[]): string[] {
  const perPbo = new Map<WebGLBuffer, string>();
  for (const e of events) {
    if ((e.kind === "copy" || e.kind === "harvest") && e.pbo) {
      perPbo.set(e.pbo, (perPbo.get(e.pbo) ?? "") + (e.kind === "copy" ? "w" : "r"));
    }
  }
  return [...perPbo.values()];
}

export class GlCallLog {
  readonly events: GlEvent[] = [];
  private readonly restores: (() => void)[] = [];

  constructor() {
    const proto = WebGL2RenderingContext.prototype;
    const log = this.events;
    this.wrap(proto, "readPixels", (gl, args) => {
      const toPbo = typeof args[6] === "number";
      log.push({ kind: "copy", toPbo, pbo: toPbo ? boundPackBuffer(gl) : null });
    });
    this.wrap(proto, "getBufferSubData", (gl, args) => {
      if (args[0] === gl.PIXEL_PACK_BUFFER) log.push({ kind: "harvest", pbo: boundPackBuffer(gl) });
    });
    this.wrap(proto, "clientWaitSync", (gl, args, result) => {
      const sync = args[0];
      if (sync instanceof WebGLSync) {
        log.push({ kind: "wait", sync, signaled: result === gl.ALREADY_SIGNALED || result === gl.CONDITION_SATISFIED });
      }
    });
    this.wrap(proto, "fenceSync", (_gl, _args, result) => log.push({ kind: "fence", sync: result instanceof WebGLSync ? result : null }));
    this.wrap(proto, "drawArrays", (gl, args) => {
      if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === null) return;
      const vp: unknown = gl.getParameter(gl.VIEWPORT);
      const one = vp instanceof Int32Array && vp[2] === 1 && vp[3] === 1;
      log.push({ kind: "layout-draw", count: typeof args[2] === "number" ? args[2] : 0, viewport1x1: one, points: args[0] === gl.POINTS });
    });
    for (const name of ["createBuffer", "createTexture", "createFramebuffer"] as const) {
      this.wrap(proto, name, () => log.push({ kind: "create" }));
    }
  }

  private wrap(
    proto: WebGL2RenderingContext,
    name: "readPixels" | "getBufferSubData" | "clientWaitSync" | "fenceSync" | "drawArrays" | "createBuffer" | "createTexture" | "createFramebuffer",
    after: (gl: WebGL2RenderingContext, args: unknown[], result: unknown) => void,
  ): void {
    const installed: unknown = Reflect.get(proto, name);
    if (typeof installed !== "function") throw new Error(`no ${name}`);
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value: function (this: WebGL2RenderingContext, ...args: unknown[]) {
        const result: unknown = Reflect.apply(installed, this, args);
        after(this, args, result);
        return result;
      },
    });
    this.restores.push(() => Object.defineProperty(proto, name, { configurable: true, writable: true, value: installed }));
  }

  restore(): void {
    for (const r of this.restores) r();
  }
}

export function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}
export function quantile(xs: number[], q: number): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}

export function perFrame(events: GlEvent[]): GlEvent[][] {
  const out: GlEvent[][] = [[]];
  for (const e of events) {
    if (e.kind === "frame-end") out.push([]);
    else out[out.length - 1]?.push(e);
  }
  out.pop();
  return out;
}

/** Every harvest comes after a fence inserted after its copy was seen signalled. */
export function assertFencedHarvests(events: readonly GlEvent[]): void {
  const fenceAt = new Map<WebGLSync, number>();
  let lastCopy = -1;
  events.forEach((e, i) => {
    if (e.kind === "copy") lastCopy = i;
    else if (e.kind === "fence" && e.sync) fenceAt.set(e.sync, i);
    else if (e.kind === "harvest") {
      let ok = false;
      for (let j = i - 1; j > lastCopy && !ok; j--) {
        const w = events[j];
        if (w?.kind === "wait" && w.signaled && (fenceAt.get(w.sync) ?? -1) > lastCopy) ok = true;
      }
      expect(ok, `harvest #${i} before its copy's fence signalled`).toBe(true);
    }
  });
}

/**
 * Main-thread ms per animation frame: the synchronous time of every `requestAnimationFrame` callback
 * of the frame (they share its timestamp) — the stream's transport, the tween's interpolation and
 * repaint — while installed. Wraps whatever is installed now and puts it back after.
 */
export class RafTimer {
  private readonly perFrame = new Map<number, number>();
  private readonly installed = window.requestAnimationFrame;

  constructor() {
    const installed = this.installed;
    const perFrame = this.perFrame;
    window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
      Reflect.apply(installed, window, [
        (now: number) => {
          const t0 = performance.now();
          try {
            callback(now);
          } finally {
            perFrame.set(now, (perFrame.get(now) ?? 0) + performance.now() - t0);
          }
        },
      ]);
  }

  get frames(): number[] {
    return [...this.perFrame.values()];
  }

  /** The main-thread ms of the frames at these rAF timestamps (a frame no callback ran in is absent). */
  at(timestamps: readonly number[]): number[] {
    return timestamps.flatMap((now) => {
      const ms = this.perFrame.get(now);
      return ms === undefined ? [] : [ms];
    });
  }

  restore(): void {
    window.requestAnimationFrame = this.installed;
  }
}
