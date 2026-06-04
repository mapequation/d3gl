import type { ExampleHandle, ExampleOptions, MountFn } from "../examples/types.js";
import { download, formatRange, setActive } from "./controls.js";
import { createPerfMeter } from "./perf.js";

// Lazy importers for every example module, keyed by path.
const loaders = import.meta.glob("../examples/*/index.ts") as Record<string, () => Promise<{ mount: MountFn }>>;

/** Wire one [data-example] element: pre-rendered control bar + live canvas + perf, with re-mount on change. */
export async function setupExample(root: HTMLElement): Promise<void> {
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

  // Backend segmented switch.
  const backendGroup = root.querySelector<HTMLElement>("[data-backend-group]");
  backendGroup?.querySelectorAll<HTMLElement>("[data-backend]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.hasAttribute("data-active")) return;
      setActive(backendGroup, btn);
      opts.backend = btn.dataset.backend as ExampleOptions["backend"];
      refreshExport();
      remount();
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
