import { vi } from "vitest";
import type { Device, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";

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
