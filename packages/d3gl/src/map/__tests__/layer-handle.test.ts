import { describe, it, expect, vi } from "vitest";
import { LayerHandle } from "../layer-handle.js";
import type { BaseEngine } from "../base-engine.js";

function fakeEngine() {
  return { recolor: vi.fn(), setClip: vi.fn() } as unknown as BaseEngine;
}

describe("LayerHandle", () => {
  it("wraps a single item into an array and forwards a batch as-is", () => {
    const appendImpl = vi.fn();
    const h = new LayerHandle(fakeEngine(), "occ", appendImpl);
    h.append({ id: 1 });
    h.append([{ id: 2 }, { id: 3 }]);
    expect(appendImpl).toHaveBeenNthCalledWith(1, [{ id: 1 }]);
    expect(appendImpl).toHaveBeenNthCalledWith(2, [{ id: 2 }, { id: 3 }]);
  });

  it("append returns the handle (chainable) and forwards an empty batch", () => {
    const appendImpl = vi.fn();
    const h = new LayerHandle(fakeEngine(), "occ", appendImpl);
    expect(h.append([])).toBe(h);
    expect(appendImpl).toHaveBeenCalledWith([]);
  });

  it("delegates recolor and setClip to the engine by name", () => {
    const engine = fakeEngine();
    const h = new LayerHandle(engine, "occ", vi.fn());
    h.recolor();
    h.setClip("land");
    expect(engine.recolor).toHaveBeenCalledWith("occ");
    expect(engine.setClip).toHaveBeenCalledWith("occ", "land");
  });
});
