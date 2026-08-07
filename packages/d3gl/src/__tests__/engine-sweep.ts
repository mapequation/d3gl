// Shared harness for the ENGINE-level at-scale zoom sweeps (#263).
//
// The at-scale guards that existed before this file drive **backends**: `canvas-`/`svg-`/
// `geo-zoom-sweep-perf.test.ts` construct a `CanvasBackend`/`SvgBackend` against a fake canvas and
// call `backend.setTransform()` + `backend.render()` directly. That is the right seam for what they
// assert, but it leaves everything ABOVE it — accessor resolution, instanced-lane emit, the
// style-version cache, LOD/declutter integration — guarded only at the small N the behavioural
// browser tests happen to use. These helpers drive the same zoom sweep through the **public engine
// entry points** (`plot()` / `geoMap()` / `network()`) and their real `setTransform`.
//
// WHY THE BROWSER TIER AND NOT NODE WITH A FAKE HOST:
//   1. Every engine constructor takes an `HTMLElement`, creates backend `<canvas>` elements
//      (`makeCanvas`, map/backend-factory.ts), promotes the host to `position:relative`, installs a
//      `ResizeObserver` and resolves its box from layout. A node fake host has to stub all of that.
//   2. The layer this issue wants covered only *exists* on WebGL: the instanced lanes, the
//      style-table textures, and `updateInstancedLayer`'s in-place buffer write. Faking a
//      `WebGL2RenderingContext` in node would turn "GPU buffers are updated in place" into an
//      assertion about the fake, not about d3gl.
//   3. A node fake-canvas harness is *exactly* the seam `canvas-zoom-sweep-perf` already owns, so
//      it would re-cover the covered half and still miss the uncovered half.
// The browser perf tier (`scripts/run-browser-perf-tier.mjs`, blocking since #262) already gives
// pattern-driven enrolment (`*-perf.browser.test.ts`), the `PERF_BROWSER_N` fixture knob via
// `perfN`, and `PERF_BUDGET_SCALE` ceiling scaling via `perfBudget`.

/** A sized, attached host element for an engine under test. */
export function perfHost(width: number, height: number): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px`;
  document.body.appendChild(el);
  return el;
}

/** GPU buffer traffic over one phase: lifecycle churn and bytes pushed across the bus. */
export interface GlBufferUsage {
  created: number;
  deleted: number;
  /** Bytes handed to `bufferData` + `bufferSubData` — the geometry/style re-upload signal. */
  uploadedBytes: number;
}

/** Bytes a `bufferData`/`bufferSubData` source represents (a size argument counts as itself). */
function sourceBytes(src: number | AllowSharedBufferSource | null | undefined): number {
  if (typeof src === "number") return src;
  return src == null ? 0 : src.byteLength;
}

// The individual overload signatures of the two upload entry points, so the spy can forward each
// call through the one it actually received (see the note in the constructor).
type BufferDataSized = (this: WebGL2RenderingContext, target: GLenum, size: GLsizeiptr, usage: GLenum) => void;
type BufferDataSource = (
  this: WebGL2RenderingContext,
  target: GLenum,
  source: AllowSharedBufferSource | null,
  usage: GLenum,
) => void;
type BufferDataRanged = (
  this: WebGL2RenderingContext,
  target: GLenum,
  source: ArrayBufferView,
  usage: GLenum,
  srcOffset: GLuint,
  length?: GLuint,
) => void;
type BufferSubDataShort = (
  this: WebGL2RenderingContext,
  target: GLenum,
  dstByteOffset: GLintptr,
  source: AllowSharedBufferSource,
) => void;
type BufferSubDataRanged = (
  this: WebGL2RenderingContext,
  target: GLenum,
  dstByteOffset: GLintptr,
  source: ArrayBufferView,
  srcOffset: GLuint,
  length?: GLuint,
) => void;

/**
 * Counts GPU buffer lifecycle + upload traffic on the live WebGL2 context.
 *
 * This is the cast-free form of the two §5 signatures about the GPU: buffers must be **updated in
 * place, not destroyed + recreated** each frame, and per-frame work must not **re-upload** geometry
 * the engine already retained. Patching the prototype needs no reach into `engine.handle.backend`,
 * and it observes what the driver was actually asked to do rather than what a spy object recorded.
 *
 * The two counters catch different regressions and neither subsumes the other: recreating buffers
 * shows in `created`/`deleted`, while re-pushing the same arrays into the *same* buffer every frame
 * shows only in `uploadedBytes`. That second shape is exactly the #186 "render re-emit" regression —
 * recreate + accessor re-derive + re-upload — whose re-upload half a create/delete count misses.
 *
 * Non-vacuity is checkable in the same run: a guard asserts buffers WERE created and bytes WERE
 * uploaded during registration, so a zero over the sweep means "nothing re-done", never "nothing
 * wired up".
 */
export class GlBufferSpy {
  created = 0;
  deleted = 0;
  uploadedBytes = 0;
  private readonly origCreate: WebGL2RenderingContext["createBuffer"];
  private readonly origDelete: WebGL2RenderingContext["deleteBuffer"];
  private readonly origData: WebGL2RenderingContext["bufferData"];
  private readonly origSubData: WebGL2RenderingContext["bufferSubData"];

  constructor() {
    const proto = WebGL2RenderingContext.prototype;
    this.origCreate = proto.createBuffer;
    this.origDelete = proto.deleteBuffer;
    this.origData = proto.bufferData;
    this.origSubData = proto.bufferSubData;
    const spy = this;
    proto.createBuffer = function (this: WebGL2RenderingContext) {
      spy.created++;
      return spy.origCreate.call(this);
    };
    proto.deleteBuffer = function (this: WebGL2RenderingContext, buffer: WebGLBuffer | null) {
      spy.deleted++;
      spy.origDelete.call(this, buffer);
    };
    // `bufferData`/`bufferSubData` are OVERLOADED, and `.call` on an overloaded reference resolves
    // to the last overload only. Narrowing each original to the exact overload we are about to
    // forward keeps the passthrough exact (no dropped `srcOffset`/`length`) and cast-free — an
    // overloaded function type is assignable to any single one of its own signatures.
    const dataSized: BufferDataSized = this.origData;
    const dataSource: BufferDataSource = this.origData;
    const dataRanged: BufferDataRanged = this.origData;
    const subShort: BufferSubDataShort = this.origSubData;
    const subRanged: BufferSubDataRanged = this.origSubData;
    proto.bufferData = function (
      this: WebGL2RenderingContext,
      target: GLenum,
      source: number | AllowSharedBufferSource | null,
      usage: GLenum,
      srcOffset?: GLuint,
      length?: GLuint,
    ): void {
      spy.uploadedBytes += sourceBytes(source);
      if (typeof source === "number") dataSized.call(this, target, source, usage);
      else if (srcOffset !== undefined && ArrayBuffer.isView(source)) dataRanged.call(this, target, source, usage, srcOffset, length);
      else dataSource.call(this, target, source, usage);
    };
    proto.bufferSubData = function (
      this: WebGL2RenderingContext,
      target: GLenum,
      dstByteOffset: GLintptr,
      source: AllowSharedBufferSource,
      srcOffset?: GLuint,
      length?: GLuint,
    ): void {
      spy.uploadedBytes += sourceBytes(source);
      if (srcOffset !== undefined && ArrayBuffer.isView(source)) subRanged.call(this, target, dstByteOffset, source, srcOffset, length);
      else subShort.call(this, target, dstByteOffset, source);
    };
  }

  /** Snapshot the counters, so a later {@link since} reads a phase delta. */
  mark(): GlBufferUsage {
    return { created: this.created, deleted: this.deleted, uploadedBytes: this.uploadedBytes };
  }

  /** Buffer churn and upload traffic since `at`. */
  since(at: GlBufferUsage): GlBufferUsage {
    return {
      created: this.created - at.created,
      deleted: this.deleted - at.deleted,
      uploadedBytes: this.uploadedBytes - at.uploadedBytes,
    };
  }

  /** Always call this (in a `finally`) — the patch is on a shared prototype. */
  restore(): void {
    const proto = WebGL2RenderingContext.prototype;
    proto.createBuffer = this.origCreate;
    proto.deleteBuffer = this.origDelete;
    proto.bufferData = this.origData;
    proto.bufferSubData = this.origSubData;
  }
}

/** A zoom-in sweep anchored on the viewport centre — the same shape the backend-level sweeps use. */
export function zoomSteps(width: number, height: number, ks: readonly number[] = [1, 2, 4, 8, 16, 32]) {
  return ks.map((k) => ({ k, x: (width / 2) * (1 - k), y: (height / 2) * (1 - k) }));
}

/**
 * Drive `apply` over the sweep; report the worst step's wall-clock and how many frames ran.
 *
 * Each step runs `reps` times and keeps the **fastest** — the same denoising the backend sweeps
 * use. A per-frame regression shows up in the fastest rep too (it is work, not jitter), while a GC
 * pause or a co-scheduled process only inflates the slow reps. `frames` is the total number of
 * `apply` calls, so a caller counting accessor invocations can divide by it to get a per-frame rate
 * (the reps are real frames, not a timing-only artefact).
 */
export function sweepFrames(
  steps: readonly { k: number; x: number; y: number }[],
  apply: (t: { k: number; x: number; y: number }) => void,
  reps = 3,
): { worstFrameMs: number; frames: number } {
  let worstFrameMs = 0;
  for (const t of steps) {
    let best = Infinity;
    for (let rep = 0; rep < reps; rep++) {
      const t0 = performance.now();
      apply(t);
      best = Math.min(best, performance.now() - t0);
    }
    worstFrameMs = Math.max(worstFrameMs, best);
  }
  return { worstFrameMs, frames: steps.length * reps };
}
