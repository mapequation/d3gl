interface MemoryInfo { usedJSHeapSize: number; }

/**
 * A live FPS / frame-time / JS-heap readout. Runs a requestAnimationFrame loop and
 * writes into the given element every 500ms. Ported from the example app's <Stats>.
 * Returns a stop() to cancel the loop.
 */
export function createPerfMeter(el: HTMLElement): () => void {
  el.classList.add("d3gl-perf");
  el.innerHTML =
    '<span class="d3gl-perf-item">fps <b data-fps>0</b></span>' +
    '<span class="d3gl-perf-item">frame <b data-ms>0</b> ms</span>' +
    '<span class="d3gl-perf-item" data-heap-wrap hidden>heap <b data-heap>0</b> MB</span>';
  const fpsEl = el.querySelector("[data-fps]")!;
  const msEl = el.querySelector("[data-ms]")!;
  const heapWrap = el.querySelector("[data-heap-wrap]") as HTMLElement;
  const heapEl = el.querySelector("[data-heap]")!;
  let last = 0, frames = 0, acc = 0, report = 0, raf = 0;
  const tick = (now: number): void => {
    if (last === 0) { last = now; report = now; }
    const dt = now - last; last = now; frames += 1; acc += dt;
    if (now - report >= 500) {
      fpsEl.textContent = String(Math.round((frames * 1000) / (now - report)));
      msEl.textContent = String(Math.round((acc / frames) * 10) / 10);
      const mem = (performance as unknown as { memory?: MemoryInfo }).memory;
      if (mem) { heapWrap.hidden = false; heapEl.textContent = String(Math.round(mem.usedJSHeapSize / 1048576)); }
      frames = 0; acc = 0; report = now;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
