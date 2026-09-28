/**
 * The one rule both GPU streaming guards (`_gpu-stream-harness.ts`, the flat layout; `_nested-perf.ts`, the
 * nested one) apply to GPU objects created while a layout streams (#417 decision 12): none, except an instanced
 * lane that outgrows its buffers, and each such grow must at least double the lane's capacity — so it happens
 * log2(peak / first) times over a run, where an exact fit would reallocate on every repaint that set a new high.
 *
 * Each lane's `update` is bracketed with its capacity before and after, so a GPU object created inside it reads
 * as that lane growing ({@link attributeCreates}).
 */
import { expect } from "vitest";
import { InstancedArrows, InstancedCircles, InstancedHalfArrows, InstancedLines, InstancedPie } from "../../../webgl/instanced.js";

/** A GPU object created (`createBuffer` / `createTexture` / `createFramebuffer`). */
export interface CreateEvent {
  kind: "create";
}

/** An instanced lane's `update` starts, or returns with its capacity before and after it. */
export type LaneEvent = { kind: "lane-begin" } | { kind: "lane-end"; before: number; after: number };

/**
 * Bracket every instanced lane's `update` with {@link LaneEvent}s pushed to `log`; returns the restore of the
 * installed methods. Cast-free: `defineProperty` takes the wrapper as a plain value.
 */
export function wrapLaneUpdates(log: { push(e: LaneEvent): unknown }): () => void {
  const restores: (() => void)[] = [];
  const wrap = <A extends unknown[], R>(proto: { readonly capacity: number; update(...args: A): R }): void => {
    const installed = proto.update;
    Object.defineProperty(proto, "update", {
      configurable: true,
      writable: true,
      value: function (this: { readonly capacity: number }, ...args: A): R {
        const before = this.capacity;
        log.push({ kind: "lane-begin" });
        const result = installed.apply(this, args);
        log.push({ kind: "lane-end", before, after: this.capacity });
        return result;
      },
    });
    restores.push(() => Object.defineProperty(proto, "update", { configurable: true, writable: true, value: installed }));
  };
  wrap(InstancedCircles.prototype);
  wrap(InstancedPie.prototype);
  wrap(InstancedLines.prototype);
  wrap(InstancedArrows.prototype);
  wrap(InstancedHalfArrows.prototype);
  return () => {
    for (const r of restores) r();
  };
}

/**
 * Split the GPU objects created in `events` into the grows of an instanced lane (created inside its `update`
 * while its capacity rose) and the rest (`stray`): anything the transport or the engine created outside a lane
 * update, and a lane update that recreated its buffers without growing them. Other events are skipped.
 */
export function attributeCreates(events: readonly (CreateEvent | LaneEvent | { kind: string })[]): { stray: number; grows: { before: number; after: number }[] } {
  let stray = 0;
  let open = false;
  let inLane = 0;
  const grows: { before: number; after: number }[] = [];
  for (const e of events) {
    if (e.kind === "lane-begin") {
      open = true;
      inLane = 0;
    } else if (e.kind === "create") {
      if (open) inLane++;
      else stray++;
    } else if (isLaneEnd(e)) {
      open = false;
      if (inLane > 0 && e.after > e.before) grows.push({ before: e.before, after: e.after });
      else stray += inLane;
    }
  }
  return { stray, grows };
}

function isLaneEnd(e: { kind: string; before?: unknown; after?: unknown }): e is { kind: "lane-end"; before: number; after: number } {
  return e.kind === "lane-end" && typeof e.before === "number" && typeof e.after === "number";
}

/** Assert the rule on the GPU objects `events` created: no stray one, and every lane grow at least doubling. */
export function expectLaneGrowthOnly(events: readonly (CreateEvent | LaneEvent | { kind: string })[]): void {
  const { stray, grows } = attributeCreates(events);
  expect(stray, "GPU objects created per streamed frame").toBe(0);
  for (const g of grows) {
    expect(g.after, `an instanced lane grew from ${g.before} to ${g.after} instances, less than double`).toBeGreaterThanOrEqual(2 * g.before);
  }
}
