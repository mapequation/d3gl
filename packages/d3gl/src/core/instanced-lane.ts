import type { InstancedLayer } from "./backend.js";

/** Screen transform: `screen = world·k + (x, y)`. Matches `ViewTransform`/`LODTransform`. */
export interface LaneTransform {
  k: number;
  x: number;
  y: number;
}

/** A screen-space (CSS px) rectangle for marquee region selection (#159), normalized so x0≤x1, y0≤y1. */
export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Chooses which of a lane's glyphs are on screen for a view, and resolves a screen point back to one.
 * The returned indices ARE the per-frame "frontier" — the lane's emit gathers a compact instance
 * buffer from them (index compaction), so draw cost ∝ the visible set, not the total. Strategies are
 * composable: viewport cull, screen-space declutter, or an LOD hierarchy cut.
 */
export interface SelectionStrategy {
  /**
   * Indices (into the lane's source) to draw for this view. The returned array is valid only until
   * the **next** `select` call — a strategy may return a view over a reused scratch buffer (#217),
   * so consumers must not retain it across frames (copy it if you need a snapshot).
   */
  select(t: LaneTransform, width: number, height: number): Uint32Array;
  /** Hit-test a screen point (CSS px) against `visible`; return a source index or -1 (topmost wins). */
  pick(x: number, y: number, t: LaneTransform, visible: Uint32Array): number;
  /**
   * Marquee region query (#159): the source indices whose glyph **centre** falls inside `rect` (CSS px),
   * tested against `visible`. Optional — a strategy without it isn't marquee-selectable. Centre-in-rect
   * is sizeMode-independent (the centre projects the same way in world/screen mode), so unlike {@link pick}
   * it needs no radius.
   */
  pickRegion?(rect: ScreenRect, t: LaneTransform, visible: Uint32Array): number[];
}

/** Builds the instanced draw layers for a given visible index set (the index-compacted gather). */
export type LaneEmit = (visible: Uint32Array) => InstancedLayer[];

/**
 * Ties a {@link SelectionStrategy} to an emitter: each view, `select` produces the visible set, `emit`
 * gathers a compact instance buffer from it, and `pick` resolves a screen point against that retained
 * set. Backend-agnostic and GPU-free — the engine pushes the returned layers and owns the device.
 * #108-B hoists ownership of a registry of these into `BaseEngine` so plot + network share the seam.
 */
export class InstancedLane {
  /**
   * The visible index set from the last {@link update} — retained for {@link pick}. May be a view
   * over strategy-owned scratch that the next {@link update} overwrites (#217): always read it
   * fresh through this property and iterate/copy immediately; never hold the array across frames.
   */
  visible: Uint32Array = new Uint32Array(0);

  constructor(private strategy: SelectionStrategy, private emit: LaneEmit) {}

  /** Re-select for the view, retain the visible set, and return the index-compacted draw layers. */
  update(t: LaneTransform, width: number, height: number): InstancedLayer[] {
    this.visible = this.strategy.select(t, width, height);
    return this.emit(this.visible);
  }

  /** Resolve a screen point against the retained visible set; -1 on a miss. */
  pick(x: number, y: number, t: LaneTransform): number {
    return this.strategy.pick(x, y, t, this.visible);
  }

  /** Source indices whose centre is inside `rect` (marquee, #159); empty if the strategy has no region query. */
  pickRegion(rect: ScreenRect, t: LaneTransform): number[] {
    return this.strategy.pickRegion?.(rect, t, this.visible) ?? [];
  }
}
