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

  /**
   * A column of `length` values written by `fill` into a retained spare array (#447), with no allocation of
   * backing storage once warm: `fill` writes every slot of the view it is given; when the result holds the
   * values last handed out under `key`, that view is handed back (the GPU layer's identity skip drops the
   * upload), else the spare becomes the column and the old one the next spare. The column handed out is never
   * written again while it is the column, so the identity skip stays safe. `length` may vary per call: the two
   * arrays grow by at least doubling, and the column is a view of its first `length` values. Memory: two
   * arrays per key, at the largest `length` seen (up to 2×).
   */
  float32Into(key: string, length: number, fill: (out: Float32Array) => void): Float32Array {
    return into(this.f32Pairs, key, length, fill, (n) => new Float32Array(n));
  }

  /** The {@link float32Into} twin for byte columns. */
  uint8Into(key: string, length: number, fill: (out: Uint8Array) => void): Uint8Array {
    return into(this.u8Pairs, key, length, fill, (n) => new Uint8Array(n));
  }

  /** Forget every retained column (the lane was dropped, or stopped emitting through this memo). */
  clear(): void {
    this.f32.clear();
    this.u8.clear();
    this.f32Pairs.clear();
    this.u8Pairs.clear();
  }

  private readonly f32Pairs = new Map<string, Pair<Float32Array>>();
  private readonly u8Pairs = new Map<string, Pair<Uint8Array>>();
}

/** A retained column (a view of one array) and the other array, its spare (see {@link StableColumns.float32Into}). */
interface Pair<T> {
  cur: T | null;
  curBuf: T | null;
  spare: T;
}

function into<T extends Float32Array | Uint8Array>(pairs: Map<string, Pair<T>>, key: string, length: number, fill: (out: T) => void, make: (n: number) => T): T {
  let p = pairs.get(key);
  if (!p) {
    p = { cur: null, curBuf: null, spare: make(length) };
    pairs.set(key, p);
  } else if (p.spare.length < length) {
    p.spare = make(Math.max(length, 2 * p.spare.length));
  }
  const view = (p.spare.length === length ? p.spare : p.spare.subarray(0, length)) as T;
  fill(view);
  if (p.cur !== null && sameValues(p.cur, view)) return p.cur;
  const buf = p.spare;
  p.spare = p.curBuf ?? make(buf.length);
  p.curBuf = buf;
  p.cur = view;
  return view;
}

/** Element-wise equality of two same-typed columns. NaN never equals itself, so a NaN column always
 *  counts as changed — the safe direction (it re-uploads). */
function sameValues<T extends Float32Array | Uint8Array>(a: T, b: T): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
