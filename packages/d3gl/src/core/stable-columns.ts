/**
 * Content-stable instance columns for a lane that re-emits fresh arrays every frame.
 *
 * The WebGL instanced primitives skip re-uploading a style column when it is the SAME array object
 * they uploaded last (`writeIfChanged`, webgl/instanced.ts — safe because a handed-out column is never
 * mutated in place). An emit that builds its columns afresh each frame (the network's LOD frontier)
 * defeats that skip even when nothing changed: a held view, a pan inside the same cut, or a streamed
 * layout frame that moved nothing on screen re-uploads every width/colour/bend/group column.
 *
 * {@link StableColumns} keeps the last array it handed out per key and, when the next frame's array
 * holds the same values, hands the OLD one back — so the identity skip fires and the upload is
 * dropped. Cost: one comparison pass over the column (stops at the first difference); memory: the
 * previous array per key, which the GPU layer already retains as its last-uploaded reference.
 */
export class StableColumns {
  private readonly f32 = new Map<string, Float32Array>();
  private readonly u8 = new Map<string, Uint8Array>();

  /** `next`, or the previously handed-out array under `key` when it holds the same values. */
  float32(key: string, next: Float32Array): Float32Array {
    const prev = this.f32.get(key);
    if (prev !== undefined && sameValues(prev, next)) return prev;
    this.f32.set(key, next);
    return next;
  }

  /** The {@link float32} twin for byte columns (RGBA colours, selected flags). */
  uint8(key: string, next: Uint8Array): Uint8Array {
    const prev = this.u8.get(key);
    if (prev !== undefined && sameValues(prev, next)) return prev;
    this.u8.set(key, next);
    return next;
  }

  /** Forget every retained column (the lane was dropped, or stopped emitting through this memo). */
  clear(): void {
    this.f32.clear();
    this.u8.clear();
  }
}

/** Element-wise equality of two same-typed columns. NaN never equals itself, so a NaN column always
 *  counts as changed — the safe direction (it re-uploads). */
function sameValues<T extends Float32Array | Uint8Array>(a: T, b: T): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
