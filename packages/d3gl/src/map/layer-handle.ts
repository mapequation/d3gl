import type { BaseEngine } from "./base-engine.js";

/**
 * A handle to one registered layer, returned by `GeoMap.layer`, `Plot.layer`, and
 * `Plot.points`. Lets you stream more data into the layer via {@link append} without
 * re-projecting or re-building the features already in it.
 */
export class LayerHandle<D = unknown> {
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

  /**
   * Select a set of this layer's drawables — by id array, by a **datum-typed** predicate
   * (`D` is known from registration, unlike the engine-level `select(name, …)` whose datum
   * is caller-asserted), or `null` to clear. Delegates to {@link BaseEngine.select}: members
   * get the layer's `selection.selected` style, the complement `selection.others`.
   */
  select(set: readonly (string | number)[] | ((d: D, i: number) => boolean) | null): this {
    // The branch only narrows the union to match the engine's two select() overloads
    // (id array / null vs. datum-typed predicate); both sides delegate identically.
    if (typeof set === "function") this.engine.select(this.name, set);
    else this.engine.select(this.name, set);
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
