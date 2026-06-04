import type { ExampleHandle, ExampleOptions, MountFn } from "../examples/types.js";
import { download, formatRange, setActive } from "./controls.js";
import { createPerfMeter } from "./perf.js";

// Lazy importers for every example module, keyed by path.
const loaders = import.meta.glob("../examples/*/index.ts") as Record<string, () => Promise<{ mount: MountFn }>>;

/** Export handle a React island publishes to its frame via the `d3gl:ready` event. */
interface ReactExportHandle { exportImage(): { format: "svg" | "png"; data: string }; }

/** Wire one [data-example] element: pre-rendered control bar + live canvas + perf, with re-mount on change. */
export async function setupExample(root: HTMLElement): Promise<void> {
  if (root.dataset.react === "true") { setupReactExample(root); return; }

  const id = root.dataset.example!;
  const path = `../examples/${id}/index.ts`;
  const loader = loaders[path];
  if (!loader) { console.error("Unknown example", id); return; }
  const { mount } = await loader();

  const canvas = root.querySelector<HTMLElement>("[data-canvas]")!;

  // Seed options from the pre-rendered defaults: backend + each control's active
  // option / slider value, then any page-supplied `data-defaults`.
  const opts: ExampleOptions = { backend: "webgl" };
  root.querySelectorAll<HTMLElement>("[data-control-key]").forEach((el) => {
    const key = el.dataset.controlKey!;
    const slider = el.matches('[data-slot="slider"]') ? el : null;
    if (slider) {
      opts[key] = Number(slider.querySelector<HTMLInputElement>('input[type="range"]')!.value);
    } else {
      const active = el.querySelector<HTMLElement>("[data-control-value][data-active]")
        ?? el.querySelector<HTMLElement>("[data-control-value]");
      if (active) opts[key] = active.dataset.controlValue!;
    }
  });
  const defaults = JSON.parse(root.dataset.defaults || "{}");
  Object.assign(opts, defaults);

  let handle: ExampleHandle | null = null;
  let lastWidth = 0;
  // Render at the container's actual display size so the drawing buffer, pointer space and
  // any HTML label overlay all coincide (1:1) — this is what keeps zoom-to-cursor centred.
  const measure = (): { width: number; height: number } => {
    const rect = canvas.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const remount = (): void => {
    const size = measure();
    if (size.width === 0 || size.height === 0) return; // not laid out yet; ResizeObserver retries
    lastWidth = size.width;
    handle?.dispose();
    canvas.innerHTML = "";
    handle = mount(canvas, { ...opts }, size);
  };

  // Backend-aware export button (relabels per backend).
  const exportBtn = root.querySelector<HTMLButtonElement>("[data-export]");
  const refreshExport = (): void => {
    if (exportBtn) exportBtn.textContent = opts.backend === "svg" ? "Export SVG" : "Export PNG";
  };
  refreshExport();
  exportBtn?.addEventListener("click", () => {
    if (!handle) return;
    const out = handle.exportImage();
    if (out.format === "svg") {
      download(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(out.data)}`, `${id}.svg`);
    } else {
      download(out.data, `${id}.png`);
    }
  });

  // Backend segmented switch. Swap in place (preserving zoom/pan via engine.setBackend)
  // when the example supports it; only fall back to a full remount otherwise.
  const backendGroup = root.querySelector<HTMLElement>("[data-backend-group]");
  backendGroup?.querySelectorAll<HTMLElement>("[data-backend]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.hasAttribute("data-active")) return;
      setActive(backendGroup, btn);
      const next = btn.dataset.backend as ExampleOptions["backend"];
      opts.backend = next; // keep in sync so a later genuine remount uses the right backend
      refreshExport();
      if (handle?.setBackend) handle.setBackend(next);
      else remount();
    });
  });

  // Example-specific segmented controls.
  root.querySelectorAll<HTMLElement>('[data-control-key]:not([data-slot="slider"])').forEach((group) => {
    const key = group.dataset.controlKey!;
    group.querySelectorAll<HTMLElement>("[data-control-value]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.hasAttribute("data-active")) return;
        setActive(group, btn);
        opts[key] = btn.dataset.controlValue!;
        remount();
      });
    });
  });

  // Range sliders: live-update the label on change, commit (remount) on release.
  root.querySelectorAll<HTMLElement>('[data-slot="slider"][data-control-key]').forEach((slider) => {
    const key = slider.dataset.controlKey!;
    const display: string[] | undefined = slider.dataset.display ? JSON.parse(slider.dataset.display) : undefined;
    const min = Number(slider.dataset.min) || 0;
    const step = Number(slider.dataset.step) || 1;
    const labelEl = root.querySelector<HTMLElement>(`[data-range-label="${key}"]`);
    const baseLabel = labelEl?.textContent ?? key;
    const setLabel = (v: number): void => {
      if (labelEl) labelEl.textContent = `${baseLabel} ${formatRange(v, { min, step, display })}`;
    };
    setLabel(Number(opts[key]));
    slider.addEventListener("slider-change", (e) => {
      setLabel((e as CustomEvent<{ value: number }>).detail.value);
    });
    slider.addEventListener("slider-commit", (e) => {
      opts[key] = (e as CustomEvent<{ value: number }>).detail.value;
      remount();
    });
  });

  // Perf meter — pushed to the far right of the status row.
  const perf = root.querySelector<HTMLElement>("[data-perf]");
  if (perf) createPerfMeter(perf);

  remount();

  // Re-render at the new size when the column width changes (responsive / layout settle).
  // Debounced; ignores height-only changes and sub-pixel jitter.
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const ro = new ResizeObserver(() => {
    const { width } = measure();
    if (width === 0 || Math.abs(width - lastWidth) < 2) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(remount, 150);
  });
  ro.observe(canvas);
}

/**
 * Wire a React example frame. The example is rendered as a genuine Astro island in the
 * canvas slot (so `@vitejs/plugin-react` installs its Fast-Refresh preamble) — we do NOT
 * load a module or call `mount()`. The SAME control bar drives it via scoped DOM events:
 *   - backend switch → set `data-backend` + dispatch `d3gl:setbackend` (island swaps backend
 *     in place via React state → engine.setBackend, so zoom/pan is preserved),
 *   - the island dispatches `d3gl:ready` with an `exportImage()` handle once its engine is up,
 *   - export button calls that handle; perf meter runs as usual.
 */
function setupReactExample(root: HTMLElement): void {
  const id = root.dataset.example!;

  // The island hydrates AFTER this script runs, so register the listener first; it then
  // catches the island's `d3gl:ready` on mount. (Guarded in case of any ordering quirk.)
  let exportHandle: ReactExportHandle | null = null;
  root.addEventListener("d3gl:ready", (e) => {
    exportHandle = (e as CustomEvent<ReactExportHandle>).detail;
  });

  const backend = (): string => root.dataset.backend ?? "webgl";

  // Backend-aware export button (relabels per backend).
  const exportBtn = root.querySelector<HTMLButtonElement>("[data-export]");
  const refreshExport = (): void => {
    if (exportBtn) exportBtn.textContent = backend() === "svg" ? "Export SVG" : "Export PNG";
  };
  refreshExport();
  exportBtn?.addEventListener("click", () => {
    if (!exportHandle) return;
    const out = exportHandle.exportImage();
    if (out.format === "svg") {
      download(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(out.data)}`, `${id}.svg`);
    } else {
      download(out.data, `${id}.png`);
    }
  });

  // Backend segmented switch → update state + tell the island (in-place swap, preserves zoom).
  const backendGroup = root.querySelector<HTMLElement>("[data-backend-group]");
  backendGroup?.querySelectorAll<HTMLElement>("[data-backend]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.hasAttribute("data-active")) return;
      setActive(backendGroup, btn);
      const next = btn.dataset.backend!;
      root.dataset.backend = next;
      refreshExport();
      root.dispatchEvent(new CustomEvent("d3gl:setbackend", { detail: next }));
    });
  });

  // Perf meter — pushed to the far right of the status row, same as vanilla frames.
  const perf = root.querySelector<HTMLElement>("[data-perf]");
  if (perf) createPerfMeter(perf);
}
