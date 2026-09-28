/**
 * `reportUncaught` (#352): the GPU stream's guard around the engine's repaint reports an exception as
 * uncaught and keeps its loop alive. On a runtime without `reportError` (pre-2022 browsers, some
 * embedded webviews, Node) the guard itself must not throw, or the loop dies and `settled` never resolves.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportUncaught } from "../report-uncaught.js";

describe("reportUncaught", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("hands the error to reportError where the runtime has it", () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const error = new Error("a style accessor threw");
    reportUncaught(error);
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("rethrows it from a task of its own where reportError is missing, never from the caller", () => {
    vi.stubGlobal("reportError", undefined);
    vi.useFakeTimers();
    const error = new Error("a style accessor threw");
    expect(() => reportUncaught(error)).not.toThrow();
    expect(() => vi.runAllTimers()).toThrow(error);
  });
});
