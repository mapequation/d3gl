import { expect, vi } from "vitest";
import type { Device, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { WebGLDevice } from "@luma.gl/webgl";
import { StreamSchedule } from "../stream-schedule.js";
import { FrameBudget } from "../frame-budget.js";

/** What one GPU layout work item encoded (#402). */
export interface ItemRecord {
  /** Render passes it opened. */
  passes: number;
  /** Passes it opened without drawing: a clear-only pass (a clear belongs to the first pass that draws). */
  clearOnly: number;
  /** `device.submit()` calls it made. */
  submits: number;
}

/**
 * Records the render passes, draws and submits of each work item run through {@link ItemRecorder.record}, by
 * spying `device.beginRenderPass`, `device.submit` and `Model.prototype.draw` (every GPU layout pass draws
 * through luma's `Model.draw`, which takes the pass). The spies call through; {@link ItemRecorder.restore}
 * removes them.
 */
export interface ItemRecorder {
  record(run: () => void): ItemRecord;
  restore(): void;
}

export function recordItems(device: Device): ItemRecorder {
  const begin = vi.spyOn(device, "beginRenderPass");
  const submit = vi.spyOn(device, "submit");
  const draw = vi.spyOn(Model.prototype, "draw");
  return {
    record(run) {
      begin.mockClear();
      submit.mockClear();
      draw.mockClear();
      run();
      const drawn = new Set<RenderPass>(draw.mock.calls.map(([pass]) => pass));
      const passes: RenderPass[] = [];
      for (const result of begin.mock.results) if (result.type === "return") passes.push(result.value);
      return {
        passes: passes.length,
        clearOnly: passes.filter((pass) => !drawn.has(pass)).length,
        submits: submit.mock.calls.length,
      };
    },
    restore() {
      begin.mockRestore();
      submit.mockRestore();
      draw.mockRestore();
    },
  };
}

/** The `device.submit()` calls of one streamed frame (#402, #382). */
export interface FrameSubmits {
  /** Whether the frame encoded a work item or a readback copy. */
  encoded: boolean;
  /** Submits while `StreamSchedule.frame` encoded the frame's items and copy: none may. */
  during: number;
  /** Submits after it, before the frame budget's fence: the stream's one, if the frame encoded anything. */
  after: number;
}

/**
 * Records the `device.submit()` calls of every streamed frame, by spying `StreamSchedule.prototype.frame`
 * (every item and copy of a frame is encoded inside it), `FrameBudget.prototype.endFrame` (the frame's fence)
 * and `WebGLDevice.prototype.submit`. The spies call through; `restore` removes them.
 */
export function recordFrameSubmits(): { frames: FrameSubmits[]; restore: () => void } {
  let submits = 0;
  let mark = 0;
  let pending: FrameSubmits | null = null;
  const frames: FrameSubmits[] = [];
  const { frame } = StreamSchedule.prototype;
  const { endFrame } = FrameBudget.prototype;
  const { submit } = WebGLDevice.prototype;
  const spies = [
    vi.spyOn(StreamSchedule.prototype, "frame").mockImplementation(function (this: StreamSchedule, open, hasWork, copyDue) {
      const before = submits;
      const items = frame.call(this, open, hasWork, copyDue);
      pending = { encoded: items > 0 || this.copied, during: submits - before, after: 0 };
      mark = submits;
      return items;
    }),
    vi.spyOn(FrameBudget.prototype, "endFrame").mockImplementation(function (this: FrameBudget<unknown>, repainted?: boolean) {
      if (pending) {
        pending.after = submits - mark;
        frames.push(pending);
        pending = null;
      }
      return endFrame.call(this, repainted);
    }),
    vi.spyOn(WebGLDevice.prototype, "submit").mockImplementation(function (this: WebGLDevice, ...args: Parameters<WebGLDevice["submit"]>) {
      submits++;
      submit.apply(this, args);
    }),
  ];
  return { frames, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

/**
 * Every streamed frame submits once, after its last item and copy, and only if it encoded one (#402, #382);
 * no item, pass or copy submits on its own.
 */
export function expectOneSubmitPerFrame(frames: readonly FrameSubmits[]): void {
  expect(frames.filter((f) => f.encoded).length, "streamed frames that encoded work").toBeGreaterThan(1);
  expect(frames.filter((f) => f.during !== 0), "frames whose items or copy submitted").toEqual([]);
  expect(frames.filter((f) => f.after !== (f.encoded ? 1 : 0)), "frames that did not submit exactly once after their work").toEqual([]);
}
