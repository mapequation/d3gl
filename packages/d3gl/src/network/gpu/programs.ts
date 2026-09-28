/**
 * The GPU layout's WebGL programs, compiled ahead of the solver and in parallel (#385).
 *
 * luma links a program when a `Model` is built and queries its link status at once, so building a solver
 * compiled its programs one after another while the main thread waited on each. With the driver's shader
 * cache cold (a first visit, or the first run after the layout's shaders changed) ANGLE compiles each
 * program for tens of milliseconds, so the click that started a layout froze the page for the sum of them.
 *
 * Every GPU layout — the flat solver with its multilevel seed, and the nested layout with its collision grid
 * and composition — lists the programs it will build before it builds anything (`GpuForceLayout.programs`,
 * `GpuNestedLayout.programs`, `AsyncPositionReadback.programs`, `blendProbeProgram`), from the same shape its
 * constructor derives, and every pass builds its `Model` from such a declared program (`layoutModel`).
 * {@link compilePrograms} issues them all at once with `KHR_parallel_shader_compile`, polls their completion
 * once per animation frame without blocking, and reports when every one has linked; the transport builds the
 * solver then, when luma links the same sources again and the driver's cache answers. Where the extension is
 * missing, nothing is compiled ahead and the solver is built at once, as before. (ANGLE Metal still compiles a
 * program's pipeline state for each target format and blend on its first draw, which the first frames pay.)
 *
 * Every program built through a layout model is recorded per device ({@link noteProgramBuilt}): luma keeps
 * its pipelines for the device's lifetime, so a later layout on the same device builds them from luma's cache
 * and compiles nothing ahead.
 */
import type { Device } from "@luma.gl/core";
import { ShaderAssembler, type PlatformInfo } from "@luma.gl/shadertools";
import { WebGLDevice } from "@luma.gl/webgl";

/** One GPU layout program: the vertex and fragment sources its pass hands luma. */
export interface LayoutProgram {
  readonly vs: string;
  readonly fs: string;
}

/** `COMPLETION_STATUS_KHR` (`KHR_parallel_shader_compile`): a non-blocking "has the link finished?". */
const COMPLETION_STATUS_KHR = 0x91b1;

/**
 * A set of programs, keyed by their vertex source and then their fragment source (no concatenated copies:
 * the sources are the passes' own strings).
 */
class ProgramSet {
  private readonly byVs = new Map<string, Set<string>>();

  has(program: LayoutProgram): boolean {
    return this.byVs.get(program.vs)?.has(program.fs) ?? false;
  }

  /** Add `program`; false when it was there already. */
  add(program: LayoutProgram): boolean {
    let fss = this.byVs.get(program.vs);
    if (!fss) {
      fss = new Set();
      this.byVs.set(program.vs, fss);
    }
    if (fss.has(program.fs)) return false;
    fss.add(program.fs);
    return true;
  }
}

/** The programs each device has built through a layout model (luma keeps them for the device's lifetime). */
const built = new WeakMap<Device, ProgramSet>();

/** Record that `program` was built on `device` (a luma pipeline now holds it). */
export function noteProgramBuilt(device: Device, program: LayoutProgram): void {
  let set = built.get(device);
  if (!set) {
    set = new ProgramSet();
    built.set(device, set);
  }
  set.add(program);
}

/** Whether `program` was built on `device` before, so luma's pipeline cache holds it. */
export function programBuilt(device: Device, program: LayoutProgram): boolean {
  return built.get(device)?.has(program) ?? false;
}

/** `programs` without repeats, in first-seen order. */
export function uniquePrograms(programs: readonly LayoutProgram[]): LayoutProgram[] {
  const seen = new ProgramSet();
  return programs.filter((program) => seen.add(program));
}

/**
 * The sources luma compiles for `program` on `device`: what a `Model` assembles (the default shader assembler,
 * no modules, the device's platform info), so the warm-up links exactly the program the model links later.
 */
export function assembleProgram(device: Device, program: LayoutProgram): LayoutProgram {
  const platformInfo: PlatformInfo = {
    type: device.type,
    shaderLanguage: device.info.shadingLanguage,
    shaderLanguageVersion: device.info.shadingLanguageVersion === 100 ? 100 : 300,
    gpu: device.info.gpu,
    features: new Set<string>(device.features),
  };
  const { vs, fs } = ShaderAssembler.getDefaultShaderAssembler().assembleGLSLShaderPair({
    platformInfo,
    vs: program.vs,
    fs: program.fs,
    modules: [],
  });
  return { vs, fs };
}

/**
 * Where a warm-up is: still linking, every program linked, one failed (see {@link ProgramWarmup.failure}), or the
 * device's context was lost meanwhile.
 */
export type WarmupStatus = "pending" | "linked" | "failed" | "lost";

/** One warmed program's GL objects. */
interface Warming {
  readonly vs: WebGLShader;
  readonly fs: WebGLShader;
  readonly program: WebGLProgram;
  complete: boolean;
}

/**
 * Compiles and links a run's programs in parallel without blocking (see the file header). {@link start} issues
 * them all; {@link poll} (once per frame) asks whether they have finished and never waits; the GL objects are
 * freed once they have (the driver keeps the compiled result), or on {@link cancel}.
 */
export class ProgramWarmup {
  private readonly gl: WebGL2RenderingContext;
  private readonly warming: Warming[];
  private status: WarmupStatus = "pending";
  private failed: string | null = null;

  private constructor(gl: WebGL2RenderingContext, warming: Warming[]) {
    this.gl = gl;
    this.warming = warming;
  }

  /**
   * Start linking every one of `programs` that `device` has not built yet. Null when there is nothing to do:
   * every program was built before, or the device cannot report a link's completion without blocking (not
   * WebGL2, or no `KHR_parallel_shader_compile`) — then the caller builds at once, as without a warm-up.
   */
  static start(device: Device, programs: readonly LayoutProgram[]): ProgramWarmup | null {
    if (!(device instanceof WebGLDevice)) return null;
    const todo = uniquePrograms(programs).filter((program) => !programBuilt(device, program));
    if (todo.length === 0) return null;
    const gl = device.gl;
    if (!gl.getExtension("KHR_parallel_shader_compile")) return null;
    const warming: Warming[] = [];
    const warmup = new ProgramWarmup(gl, warming);
    try {
      for (const program of todo) {
        const sources = assembleProgram(device, program);
        const vs = compile(gl, gl.VERTEX_SHADER, sources.vs);
        const fs = compile(gl, gl.FRAGMENT_SHADER, sources.fs);
        const handle = gl.createProgram();
        if (handle === null) throw new Error("ProgramWarmup: could not create a program");
        warming.push({ vs, fs, program: handle, complete: false });
        gl.attachShader(handle, vs);
        gl.attachShader(handle, fs);
        gl.linkProgram(handle);
      }
    } catch (error) {
      warmup.cancel();
      throw error;
    }
    return warmup;
  }

  /** Programs this warm-up links. */
  get count(): number {
    return this.warming.length;
  }

  /** The first failed program's info log, once {@link poll} reported `"failed"`. */
  get failure(): string | null {
    return this.failed;
  }

  /**
   * Whether every program has linked — asked without waiting (`COMPLETION_STATUS_KHR`); only once all have
   * finished are their link statuses read, which no longer blocks. Frees the GL objects when it reports
   * `"linked"` or `"failed"`.
   */
  poll(): WarmupStatus {
    if (this.status !== "pending") return this.status;
    const gl = this.gl;
    // A lost context never completes a link: stop here (its GL objects are gone with it).
    if (gl.isContextLost()) {
      this.status = "lost";
      this.release();
      return this.status;
    }
    for (const w of this.warming) {
      if (!w.complete) w.complete = gl.getProgramParameter(w.program, COMPLETION_STATUS_KHR) === true;
      if (!w.complete) return "pending";
    }
    for (const w of this.warming) {
      if (gl.getProgramParameter(w.program, gl.LINK_STATUS) !== true) {
        this.failed = gl.getProgramInfoLog(w.program) || "a GPU layout program failed to link";
        break;
      }
    }
    this.status = this.failed === null ? "linked" : "failed";
    this.release();
    return this.status;
  }

  /**
   * Stop: free every GL object (a link still running finishes in the driver and is discarded). A cancelled
   * warm-up polls `"failed"` with no {@link failure}.
   */
  cancel(): void {
    if (this.status === "pending") this.status = "failed";
    this.release();
  }

  private release(): void {
    const gl = this.gl;
    for (const w of this.warming) {
      gl.deleteProgram(w.program);
      gl.deleteShader(w.vs);
      gl.deleteShader(w.fs);
    }
    this.warming.length = 0;
  }
}

/** How a run's compile ended: every program linked, one failed to link (its info log), or the context was lost. */
export type CompileOutcome =
  | { readonly status: "linked" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "lost" };

/** A compile in flight (see {@link compilePrograms}). */
export interface ProgramCompile {
  /** Stop: no `then`, no further frame, every GL object freed. Idempotent. */
  cancel(): void;
}

/**
 * The one startup step every GPU layout takes before it builds its solver (#385): compile `programs` on `device` in
 * parallel ({@link ProgramWarmup}), poll once per animation frame, and call `then` once, from a frame, when every
 * one has linked, one failed, or the context was lost. Null when there is nothing to compile ahead — every program
 * was built on `device` before, or the device cannot report a link's completion without blocking — and then the
 * caller builds at once. Throws when a program cannot even be issued (nothing is left behind).
 */
export function compilePrograms(device: Device, programs: readonly LayoutProgram[], then: (outcome: CompileOutcome) => void): ProgramCompile | null {
  const warmup = ProgramWarmup.start(device, programs);
  if (!warmup) return null;
  let raf = 0;
  let done = false;
  const frame = (): void => {
    raf = 0;
    if (done) return;
    const status = warmup.poll();
    if (status === "pending") {
      raf = requestAnimationFrame(frame);
      return;
    }
    done = true;
    if (status === "linked") then({ status: "linked" });
    else if (status === "lost") then({ status: "lost" });
    else then({ status: "failed", reason: warmup.failure ?? "a GPU layout program failed to link" });
  };
  raf = requestAnimationFrame(frame);
  return {
    cancel() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (done) return;
      done = true;
      warmup.cancel();
    },
  };
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("ProgramWarmup: could not create a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}
