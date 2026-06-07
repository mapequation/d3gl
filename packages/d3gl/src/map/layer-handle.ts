import type { BaseEngine } from "./base-engine.js";

/**
 * A handle to one registered layer, returned by `GeoMap.layer`, `Plot.layer`, and
 * `Plot.points`. Lets you stream more data into the layer via {@link append} without
 * re-projecting or re-building the features already in it.
 */
export class LayerHandle<D = any> {
  constructor(
    private readonly engine: BaseEngine,
    /** The layer's name. */
    readonly name: string,
    private readonly appendImpl: (items: readonly D[]) => void,
  ) {}

  /**
   * Append one item or a batch to this layer. Only the new items are built/projected;
   * existing geometry is untouched. An empty batch is a no-op downstream.
   */
  append(items: D | readonly D[]): this {
    this.appendImpl(Array.isArray(items) ? (items as readonly D[]) : [items as D]);
    return this;
  }

  /** Re-apply this layer's fill/stroke accessors (e.g. after mutating bound data). */
  recolor(): this {
    this.engine.recolor(this.name);
    return this;
  }

  /** Set or clear the clip mask for this layer. */
  setClip(clipTo?: string): this {
    this.engine.setClip(this.name, clipTo);
    return this;
  }
}
