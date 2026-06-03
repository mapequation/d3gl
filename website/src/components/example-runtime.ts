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

  const bar = root.querySelector<HTMLElement>("[data-control-bar]")!;
  const canvas = root.querySelector<HTMLElement>("[data-canvas]")!;

  const opts: ExampleOptions = { backend: "webgl" };
  for (const c of controls) opts[c.key] = c.type === "range" ? c.value : c.options[0];

  let handle: ExampleHandle | null = null;
  const remount = (): void => {
    handle?.dispose();
    canvas.innerHTML = "";
    handle = mount(canvas, { ...opts });
  };

  // perf meter (left)
  const perf = document.createElement("div");
  bar.appendChild(perf);
  createPerfMeter(perf);

  // backend switch
  bar.appendChild(segmented("", ["webgl", "canvas", "svg"], "webgl", (v) => {
    opts.backend = v as ExampleOptions["backend"];
    exportBtn.refresh();
    remount();
  }));

  // example-specific controls (segmented toggles or range sliders)
  for (const c of controls) {
    if (c.type === "range") {
      bar.appendChild(slider(c.label, c, (v) => { opts[c.key] = v; remount(); }));
    } else {
      bar.appendChild(segmented(c.label, c.options, c.options[0]!, (v) => { opts[c.key] = v; remount(); }));
    }
  }

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
  bar.appendChild(exportBtn);

  remount();
}
