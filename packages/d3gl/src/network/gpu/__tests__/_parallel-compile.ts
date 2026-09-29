/**
 * Test helpers for the GPU layout's parallel program compile (#385): fake `KHR_parallel_shader_compile` where
 * the browser has none (the headless shell's SwiftShader), or hide it where it exists, so a test takes the
 * path it means to on any machine.
 */
import { vi } from "vitest";

/** `COMPLETION_STATUS_KHR`. */
const COMPLETION = 0x91b1;

/**
 * Fake `KHR_parallel_shader_compile` on the headless shell (SwiftShader has none): the extension exists, and the
 * programs link side by side, as a parallel compile does: every program reports its link complete once `polls`
 * completion queries have been asked in all (a warm-up asks one per frame while the first is linking, so that is
 * `polls` frames however many programs it issued), and every other link-status read of a program before that is
 * recorded as a blocking read. `queries` counts every completion query; `release()` completes every link at the
 * next query. `failLinks` makes every warmed program report a failed link.
 */
export function fakeParallelCompile(
  polls: number,
  failLinks = false,
): { blocking: number; queries: number; release: () => void; restore: () => void } {
  const proto = WebGL2RenderingContext.prototype;
  const origExtension = proto.getExtension;
  const origParameter = proto.getProgramParameter;
  const asked = new Set<WebGLProgram>();
  const complete = new Set<WebGLProgram>();
  let threshold = polls;
  const state = { blocking: 0, queries: 0, release: () => { threshold = 0; }, restore: () => {} };
  const extension = vi.spyOn(proto, "getExtension").mockImplementation(function (this: WebGL2RenderingContext, name: string) {
    return name === "KHR_parallel_shader_compile" ? { COMPLETION_STATUS_KHR: COMPLETION } : origExtension.call(this, name);
  });
  const parameter = vi.spyOn(proto, "getProgramParameter").mockImplementation(function (
    this: WebGL2RenderingContext,
    program: WebGLProgram,
    pname: GLenum,
  ) {
    if (pname === COMPLETION) {
      state.queries++;
      asked.add(program);
      const done = state.queries >= threshold;
      if (done) complete.add(program);
      return done;
    }
    if (asked.has(program)) {
      // A program the warm-up issued: nothing may read it before its link reported completion.
      if (!complete.has(program)) state.blocking++;
      if (failLinks && pname === this.LINK_STATUS) return false;
    }
    return origParameter.call(this, program, pname);
  });
  state.restore = () => {
    extension.mockRestore();
    parameter.mockRestore();
  };
  return state;
}

/** Hide `KHR_parallel_shader_compile`, so a GPU run builds its solver at once, inside `startGpuLayout`. */
export function hideParallelCompile(): { restore: () => void } {
  const origExtension = WebGL2RenderingContext.prototype.getExtension;
  const spy = vi.spyOn(WebGL2RenderingContext.prototype, "getExtension").mockImplementation(function (this: WebGL2RenderingContext, name: string) {
    return name === "KHR_parallel_shader_compile" ? null : origExtension.call(this, name);
  });
  return { restore: () => spy.mockRestore() };
}
