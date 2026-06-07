/**
 * A tiny HTML overlay (top-right of the canvas) showing how many records have
 * streamed in — count, percentage of the total, and the average append speed so
 * far (records / time spent in `append`). Mirrors the Infomap Bioregions readout.
 */
export interface StatsOverlay {
  /** Update the readout. Throttled to ~10 Hz unless `force`. `batch` (optional) shows
   *  the current batch size — handy to watch adaptive batching converge. */
  update(count: number, total: number, recordsPerSec: number, batch?: number, force?: boolean): void;
  destroy(): void;
}

export function createStatsOverlay(host: HTMLElement): StatsOverlay {
  const el = document.createElement("div");
  el.className =
    "absolute top-2 right-2 pointer-events-none rounded-md bg-white/80 px-2 py-1 " +
    "font-mono text-[11px] leading-tight text-[#333] shadow-sm [font-variant-numeric:tabular-nums]";
  host.appendChild(el);

  const fmt = (n: number): string => Math.round(n).toLocaleString();
  let last = 0;

  return {
    update(count, total, recordsPerSec, batch, force = false) {
      const now = performance.now();
      if (!force && now - last < 100) return;
      last = now;
      const ratio = total > 0 ? count / total : 0;
      const pct = (ratio * 100).toFixed(ratio < 0.1 ? 1 : 0);
      const batchLine = batch != null ? `<br>batch <b>${fmt(batch)}</b>` : "";
      el.innerHTML = `records <b>${fmt(count)}</b> (${pct}%)<br>speed <b>${fmt(recordsPerSec)}</b> rec/s${batchLine}`;
    },
    destroy() {
      el.remove();
    },
  };
}
