import type { ControlSpec, ExampleHandle, ExampleOptions, MountFn } from "../examples/types.js";
import { segmented, slider, actionButton, download } from "./controls.js";
import { createPerfMeter } from "./perf.js";

// Lazy importers for every example module, keyed by path.
const loaders = import.meta.glob("../examples/*/index.ts") as Record<string, () => Promise<{ mount: MountFn }>>;

/** Wire one [data-example] element: control bar + live canvas + perf, with re-mount on change. */
export async function setupExample(root: HTMLElement): Promise<void> {
  const id = root.dataset.example!;
  const controls: ControlSpec[] = JSON.parse(root.dataset.controls || "[]");
  const path = `../examples/${id}/index.ts`;
  const loader = loaders[path];
  if (!loader) { console.error("Unknown example", id); return; }
  const { mount } = await loader();

  const statusBar = root.querySelector<HTMLElement>("[data-status-bar]");
  const controlsRow = root.querySelector<HTMLElement>("[data-controls-row]");
  // Fall back gracefully if only one container exists.
  const status = statusBar ?? controlsRow!;
  const row = controlsRow ?? statusBar!;
  const canvas = root.querySelector<HTMLElement>("[data-canvas]")!;

  const opts: ExampleOptions = { backend: "webgl" };
  for (const c of controls) opts[c.key] = c.type === "range" ? c.value : c.options[0];
  // Seed any page-supplied defaults after per-control defaults, before first mount.
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

  // Status bar (top line): backend switch (left), export button, then perf (far right).
  // backend switch — first/left
  status.appendChild(segmented("", ["webgl", "canvas", "svg"], "webgl", (v) => {
    opts.backend = v as ExampleOptions["backend"];
    exportBtn.refresh();
    remount();
  }));

  // single backend-aware export button
  const exportBtn = actionButton(
    () => (opts.backend === "svg" ? "Export SVG" : "Export PNG"),
    () => {
      if (!handle) return;
      const out = handle.exportImage();
      if (out.format === "svg") {
        download(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(out.data)}`, `${id}.svg`);
      } else {
        download(out.data, `${id}.png`);
      }
    },
  ) as HTMLButtonElement & { refresh: () => void };
  status.appendChild(exportBtn);

  // perf meter — pushed to the far right
  const perf = document.createElement("div");
  perf.classList.add("ml-auto");
  status.appendChild(perf);
  createPerfMeter(perf);

  // example-specific controls (segmented toggles or range sliders) on their own row
  for (const c of controls) {
    if (c.type === "range") {
      row.appendChild(slider(c.label, c, (v) => { opts[c.key] = v; remount(); }));
    } else {
      row.appendChild(segmented(c.label, c.options, c.options[0]!, (v) => { opts[c.key] = v; remount(); }));
    }
  }

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
